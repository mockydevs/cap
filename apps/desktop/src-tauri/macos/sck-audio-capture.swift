// sck-audio-capture.swift
//
// *** UNVERIFIED — WRITTEN WITHOUT ACCESS TO macOS/Xcode/A SWIFT TOOLCHAIN ***
// This file has never been compiled, run, or tested. It was written from
// documentation and public sample code only. It MUST be built and exercised
// end-to-end on real macOS hardware (real ScreenCaptureKit permission
// prompts, real audio hardware, a real ffmpeg reading the pipe) before Cap
// ships "system audio without a microphone" capture on macOS. Treat every
// API call below as "believed correct, not confirmed."
//
// Purpose
// -------
// Cap's Rust/ffmpeg pipeline captures the display and, optionally, a
// microphone via ffmpeg's `avfoundation` input. `avfoundation` has no way to
// capture macOS system/desktop audio output, so when the user wants system
// audio and has NOT selected a microphone, apps/desktop/src-tauri/src/capture.rs
// spawns this helper as a plain child process (exactly like it spawns
// ffmpeg — `std::process::Command`, no in-process ObjC/Rust FFI) to capture
// system audio only, via ScreenCaptureKit, and hands the raw samples to
// ffmpeg through a named pipe.
//
// PCM contract — MUST match capture.rs's ffmpeg input arguments exactly
// -----------------------------------------------------------------------
//   32-bit float, native/little-endian, 48 000 Hz, 2 channels, interleaved.
//   ffmpeg is invoked with: -f f32le -ar 48000 -ac 2 -i <path>
// "Native-endian == little-endian" holds because both this helper and
// ffmpeg run on the same Apple Silicon/Intel host, both little-endian.
// If either side of this contract ever changes, it must change in both
// this file and capture.rs's `platform_input` for macOS.
//
// Invocation
// ----------
//   sck-audio-capture <output-path>
// `<output-path>` is created by capture.rs as a named pipe (mkfifo) before
// this process is spawned. Opening a FIFO for writing blocks in the kernel
// until a reader attaches; capture.rs relies on that to rendezvous this
// helper with the ffmpeg process it spawns immediately afterward reading
// the same path. If given a path to a regular file instead, this helper
// still works (it just opens/creates that file normally).
//
// Lifecycle / shutdown
// ---------------------
// Runs until SIGTERM or SIGINT (capture.rs sends SIGTERM, not SIGKILL, so
// this process gets a chance to shut down cleanly), at which point it stops
// the SCStream and closes the output file handle before exiting. Raw PCM
// has no header/trailer, so a truncated final sample would not corrupt
// ffmpeg's read either way — but stopping the stream cleanly avoids
// ScreenCaptureKit teardown races and guarantees the file descriptor is
// closed so ffmpeg observes EOF promptly instead of hanging on stop.
//
// Requirements this helper cannot satisfy on its own
// ----------------------------------------------------
// - Requires macOS 13.0+ for SCStreamConfiguration.capturesAudio /
//   excludesCurrentProcessAudio (Cap's overall minimumSystemVersion is
//   12.3, so this helper must fail *gracefully* — not crash — on 12.3–12.x
//   and on 13.0+ hosts where ScreenCaptureKit audio capture is otherwise
//   unavailable).
// - Requires the same "Screen Recording" TCC permission the rest of Cap
//   already asks for. UNVERIFIED: whether macOS attributes that grant to
//   this helper process (spawned as a child of the Cap.app executable) the
//   same way it does to Cap.app itself, or whether the helper shows up as
//   its own separate, unrecognized entry in System Settings requiring its
//   own grant. This needs to be checked on real hardware.
//
// Build: compiled by build.rs via `swiftc -parse-as-library`, macOS only.
// See build.rs for the exact invocation and where the resulting binary is
// placed for Tauri to bundle as a resource.

import Foundation
import Darwin
import CoreMedia
import AVFoundation
import ScreenCaptureKit
import Dispatch

// MARK: - PCM contract constants (keep in lockstep with capture.rs)

private let targetSampleRate: Double = 48_000
private let targetChannelCount: AVAudioChannelCount = 2

// MARK: - Errors

private enum CaptureError: Error, CustomStringConvertible {
    case invalidArguments
    case unsupportedOSVersion
    case couldNotOpenOutput(Int32)
    case noDisplaysAvailable
    case unsupportedTargetFormat
    case missingFormatDescription
    case unsupportedSourceFormat
    case coreMediaStatus(OSStatus)
    case bufferWrapFailed
    case converterCreationFailed
    case bufferAllocationFailed

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: sck-audio-capture <output-path>"
        case .unsupportedOSVersion:
            return "ScreenCaptureKit audio-only capture requires macOS 13.0 or later"
        case .couldNotOpenOutput(let errnoValue):
            return "could not open output path (errno \(errnoValue))"
        case .noDisplaysAvailable:
            return "no displays are available to build a ScreenCaptureKit content filter"
        case .unsupportedTargetFormat:
            return "could not construct the target Float32/48kHz/stereo audio format"
        case .missingFormatDescription:
            return "captured audio sample buffer had no usable format description"
        case .unsupportedSourceFormat:
            return "could not interpret the captured audio sample buffer's format"
        case .coreMediaStatus(let status):
            return "CoreMedia error \(status)"
        case .bufferWrapFailed:
            return "could not wrap the captured audio buffer without copying"
        case .converterCreationFailed:
            return "could not create an AVAudioConverter to the target PCM format"
        case .bufferAllocationFailed:
            return "could not allocate a converted audio buffer"
        }
    }
}

private func logError(_ message: String) {
    let line = "sck-audio-capture: \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8) ?? Data())
}

// MARK: - Shutdown coordination
//
// A tiny lock-guarded box standing in for the stop signal. Both a GCD signal
// source (fired from `signalQueue`) and the SCStreamDelegate callback (fired
// from ScreenCaptureKit's own internal queue) can trigger a stop, so this is
// deliberately just a lock around "resume the continuation once," rather than
// a bare captured `var`, to keep the concurrent-access story simple to audit
// by inspection since it cannot be verified by a Swift concurrency checker
// here.
private final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var fired = false

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if fired {
                lock.unlock()
                continuation.resume()
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
    }

    func fire() {
        lock.lock()
        fired = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume()
    }
}

// MARK: - Audio tap

@available(macOS 13.0, *)
private final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private let fileHandle: FileHandle
    private let targetFormat: AVAudioFormat
    private let onFatalError: (String) -> Void
    private var converter: AVAudioConverter?
    private var converterSourceFormat: AVAudioFormat?

    init(fileHandle: FileHandle, targetFormat: AVAudioFormat, onFatalError: @escaping (String) -> Void) {
        self.fileHandle = fileHandle
        self.targetFormat = targetFormat
        self.onFatalError = onFatalError
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else {
            // We configure a minimal 2x2 video stream because SCStream requires a
            // filter/config that can technically produce frames, but we never asked
            // for and never use .screen output — ignore it defensively either way.
            return
        }
        guard sampleBuffer.isValid else { return }
        do {
            try handle(sampleBuffer)
        } catch {
            // A single bad buffer should not take down the whole capture; log and
            // keep going. Sustained failures will show up as silence/garbled audio
            // in the recording, which is an acceptable degraded mode versus a crash.
            logError("dropping an audio buffer: \(error)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onFatalError("ScreenCaptureKit stopped the stream: \(error)")
    }

    private func handle(_ sampleBuffer: CMSampleBuffer) throws {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            throw CaptureError.missingFormatDescription
        }
        guard let incomingFormat = AVAudioFormat(streamDescription: asbd) else {
            throw CaptureError.unsupportedSourceFormat
        }

        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            throw CaptureError.coreMediaStatus(status)
        }

        guard
            let incomingBuffer = AVAudioPCMBuffer(
                pcmFormat: incomingFormat,
                bufferListNoCopy: &audioBufferList,
                deallocator: nil
            )
        else {
            throw CaptureError.bufferWrapFailed
        }

        try writeAsTargetFormat(incomingBuffer, incomingFormat: incomingFormat)

        // Keep `blockBuffer` (which owns the memory `incomingBuffer` points into
        // without copying) alive for the duration of the write above.
        withExtendedLifetime(blockBuffer) {}
    }

    private func writeAsTargetFormat(_ buffer: AVAudioPCMBuffer, incomingFormat: AVAudioFormat) throws {
        let matchesTarget =
            incomingFormat.sampleRate == targetFormat.sampleRate
            && incomingFormat.channelCount == targetFormat.channelCount
            && incomingFormat.commonFormat == targetFormat.commonFormat
            && incomingFormat.isInterleaved == targetFormat.isInterleaved

        let outputBuffer: AVAudioPCMBuffer
        if matchesTarget {
            outputBuffer = buffer
        } else {
            outputBuffer = try convert(buffer, incomingFormat: incomingFormat)
        }

        let bufferList = outputBuffer.audioBufferList.pointee
        guard bufferList.mNumberBuffers > 0, let mData = bufferList.mBuffers.mData else {
            return
        }
        let byteCount = Int(bufferList.mBuffers.mDataByteSize)
        guard byteCount > 0 else { return }
        let data = Data(bytes: mData, count: byteCount)
        do {
            try fileHandle.write(contentsOf: data)
        } catch {
            // Most commonly EPIPE (ffmpeg exited already). Surface it as a fatal
            // error so main() stops the stream instead of spinning on a dead pipe.
            throw error
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer, incomingFormat: AVAudioFormat) throws -> AVAudioPCMBuffer {
        if converter == nil || converterSourceFormat != incomingFormat {
            guard let newConverter = AVAudioConverter(from: incomingFormat, to: targetFormat) else {
                throw CaptureError.converterCreationFailed
            }
            converter = newConverter
            converterSourceFormat = incomingFormat
        }
        guard let converter else {
            throw CaptureError.converterCreationFailed
        }

        let ratio = targetFormat.sampleRate / max(incomingFormat.sampleRate, 1)
        let estimatedFrames = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: estimatedFrames) else {
            throw CaptureError.bufferAllocationFailed
        }

        var consumed = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if let conversionError {
            throw conversionError
        }
        return converted
    }
}

// MARK: - Entry point

@available(macOS 13.0, *)
private func run(outputPath: String) async throws {
    // SIGPIPE's default disposition terminates the process; if ffmpeg exits
    // first and we write to the now-reader-less FIFO, we want an EPIPE error
    // from `write`, not an unconditional crash.
    signal(SIGPIPE, SIG_IGN)

    // Opening the FIFO for writing blocks until ffmpeg (or whatever opens the
    // path for reading) attaches — this is the intended synchronization with
    // capture.rs, not a bug. O_CREAT is harmless/ignored if the path already
    // exists as a FIFO; it just makes this helper usable against a plain file
    // too (e.g. for manual testing during development).
    let fileDescriptor = open(outputPath, O_WRONLY | O_CREAT, 0o600)
    guard fileDescriptor >= 0 else {
        throw CaptureError.couldNotOpenOutput(errno)
    }
    let fileHandle = FileHandle(fileDescriptor: fileDescriptor, closeOnDealloc: true)

    guard
        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: targetChannelCount,
            interleaved: true
        )
    else {
        throw CaptureError.unsupportedTargetFormat
    }

    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else {
        throw CaptureError.noDisplaysAvailable
    }
    // Audio capture is not scoped to a particular display's pixels — the
    // filter just needs *a* display target. We deliberately exclude no
    // applications and except no windows, since we want whole-system audio.
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = Int(targetSampleRate)
    configuration.channelCount = Int(targetChannelCount)
    // We only care about audio, but SCStream still needs a video configuration;
    // keep it as cheap as possible (1x1 px, ~1 frame/sec) rather than trying to
    // fully disable video, which SCStreamConfiguration has no flag for.
    configuration.width = 2
    configuration.height = 2
    configuration.showsCursor = false
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 8

    let stopSignal = StopSignal()
    let tap = AudioTap(fileHandle: fileHandle, targetFormat: targetFormat) { message in
        logError(message)
        stopSignal.fire()
    }

    let stream = SCStream(filter: filter, configuration: configuration, delegate: tap)
    let audioQueue = DispatchQueue(label: "dev.mocky.cap.sck-audio-capture.audio")
    try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: audioQueue)

    try await stream.startCapture()

    // Install signal handling only once capture has actually started, so a
    // SIGTERM delivered before we get this far still terminates the process
    // via the default disposition instead of being silently ignored forever.
    let signalQueue = DispatchQueue(label: "dev.mocky.cap.sck-audio-capture.signals")
    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    sigtermSource.setEventHandler { stopSignal.fire() }
    sigintSource.setEventHandler { stopSignal.fire() }
    sigtermSource.resume()
    sigintSource.resume()

    await stopSignal.wait()

    try? await stream.stopCapture()
    try? fileHandle.close()
}

@main
struct SckAudioCapture {
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count == 2 else {
            logError(CaptureError.invalidArguments.description)
            exit(64) // EX_USAGE
        }
        let outputPath = arguments[1]

        guard #available(macOS 13.0, *) else {
            logError(CaptureError.unsupportedOSVersion.description)
            exit(69) // EX_UNAVAILABLE
        }

        do {
            try await run(outputPath: outputPath)
            exit(0)
        } catch {
            logError("\(error)")
            exit(70) // EX_SOFTWARE
        }
    }
}
