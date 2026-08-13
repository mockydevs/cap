fn main() {
    tauri_build::build();
    compile_macos_system_audio_helper();
}

/// Compiles `macos/sck-audio-capture.swift` into a standalone executable used
/// at runtime by `capture.rs` (macOS only) to capture system audio via
/// ScreenCaptureKit when the user wants system audio with no microphone
/// selected. See that Swift file's header comment for the full design and an
/// explicit "this is unverified" notice — the same applies to this build
/// step, which has never been run (no macOS/Xcode/Swift toolchain is
/// available in the environment this was written in).
///
/// This function is a no-op, not a hard failure, whenever it cannot do its
/// job (wrong host target, no `swiftc`, or compilation failure): the rest of
/// Cap (video-only and microphone-audio recording, on every platform) does
/// not depend on this helper, so a broken macOS system-audio helper build
/// must never break the desktop build for everyone else.
fn compile_macos_system_audio_helper() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        // Not building for macOS (e.g. this Linux/Windows host, or a non-macOS
        // Cargo target) — nothing to do. Nothing below this line ever runs on
        // the CI/dev machine this change was authored on.
        return;
    }

    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(dir) => std::path::PathBuf::from(dir),
        Err(_) => {
            println!("cargo:warning=CARGO_MANIFEST_DIR is unset; skipping the macOS system-audio helper build");
            return;
        }
    };
    let macos_dir = manifest_dir.join("macos");
    let source = macos_dir.join("sck-audio-capture.swift");
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.exists() {
        println!(
            "cargo:warning=macos/sck-audio-capture.swift not found; the macOS system-audio (no-microphone) helper will not be built"
        );
        return;
    }

    let Some(swiftc) = find_on_path("swiftc") else {
        println!(
            "cargo:warning=swiftc not found on PATH; the macOS system-audio (no-microphone) helper will not be built. Install Xcode or the Xcode Command Line Tools (`xcode-select --install`) to enable it. Video and microphone-audio recording are unaffected."
        );
        return;
    };

    // Compile a single-architecture binary for whatever architecture Cargo is
    // currently building for. Tauri's "universal-apple-darwin" builds invoke
    // `cargo build` (and therefore this build script) once per architecture
    // and then `lipo` the two resulting Rust binaries together; we mirror
    // that below so the bundled helper is a universal binary too instead of
    // silently only supporting whichever architecture happened to build
    // last.
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
    let swift_arch = match target_arch.as_str() {
        "aarch64" => "arm64",
        other => other, // x86_64 matches Swift's own triple naming already.
    };
    // Matches tauri.conf.json's bundle.macOS.minimumSystemVersion. The helper
    // must be launchable (and fail gracefully with a clear stderr message,
    // see the Swift file's `guard #available(macOS 13.0, *)`) all the way
    // down to that floor, even though ScreenCaptureKit audio capture itself
    // requires macOS 13.0+.
    let deployment_target = "12.3";
    let swift_target_triple = format!("{swift_arch}-apple-macos{deployment_target}");

    let arch_output = macos_dir.join(format!(".sck-audio-capture-{swift_arch}"));
    let compile_status = std::process::Command::new(&swiftc)
        .args(["-O", "-parse-as-library", "-target", &swift_target_triple])
        .arg(&source)
        .arg("-o")
        .arg(&arch_output)
        .status();

    match compile_status {
        Ok(status) if status.success() => {
            println!(
                "cargo:warning=Built macOS system-audio helper ({swift_target_triple}) at {}",
                arch_output.display()
            );
        }
        Ok(status) => {
            println!(
                "cargo:warning=swiftc exited with {status}; the macOS system-audio (no-microphone) helper was not built"
            );
            return;
        }
        Err(error) => {
            println!(
                "cargo:warning=Could not run swiftc ({error}); the macOS system-audio (no-microphone) helper was not built"
            );
            return;
        }
    }

    finalize_helper_binary(&macos_dir, swift_arch, &arch_output);
}

/// Produces the final `macos/sck-audio-capture` binary that `capture.rs`
/// looks for at runtime and that `tauri.conf.json` bundles as a macOS
/// resource. If a previously-built binary for the *other* architecture is
/// sitting next to this one (from an earlier invocation of this same build
/// script during a universal-binary build), combine both into a universal
/// binary via `lipo`. Otherwise just use this architecture's binary as-is
/// (this is the common case: a plain single-arch `cargo build`).
fn finalize_helper_binary(
    macos_dir: &std::path::Path,
    swift_arch: &str,
    arch_output: &std::path::Path,
) {
    let other_arch = if swift_arch == "arm64" {
        "x86_64"
    } else {
        "arm64"
    };
    let other_output = macos_dir.join(format!(".sck-audio-capture-{other_arch}"));
    let final_output = macos_dir.join("sck-audio-capture");

    if other_output.exists() {
        let lipo_status = std::process::Command::new("lipo")
            .arg("-create")
            .arg(arch_output)
            .arg(&other_output)
            .arg("-output")
            .arg(&final_output)
            .status();
        match lipo_status {
            Ok(status) if status.success() => {
                println!(
                    "cargo:warning=Combined macOS system-audio helper into a universal binary at {}",
                    final_output.display()
                );
                return;
            }
            Ok(status) => {
                println!("cargo:warning=lipo exited with {status}; falling back to the {swift_arch}-only helper binary");
            }
            Err(error) => {
                println!("cargo:warning=Could not run lipo ({error}); falling back to the {swift_arch}-only helper binary");
            }
        }
    }

    if let Err(error) = std::fs::copy(arch_output, &final_output) {
        println!(
            "cargo:warning=Could not stage the macOS system-audio helper at {}: {error}",
            final_output.display()
        );
    }
}

fn find_on_path(binary: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}
