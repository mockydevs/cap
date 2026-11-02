//! `cap-meet-speaker`: TEST-ONLY synthetic participant for the controlled
//! live calendar test (feature `test-speaker`, never in the notetaker image).
//!
//! Joins one pinned Google Meet as a clearly named guest ("Calari audio
//! test"), keeps its microphone on, asks the host to admit it, then plays a
//! scripted audio file into its microphone and leaves. It records nothing,
//! holds no Google credentials, does not hide automation, and gives up at a
//! hard time limit.
//!
//!   CAP_SPEAKER_ALLOWED_CODE=abc-defg-hij cap-meet-speaker \
//!     --code abc-defg-hij --wav /speech.ogg [--minutes 15] [--repeat 2]

use cap_meeting_bot::{cdp, meet};
use std::{
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::{Duration, Instant},
};

const NAME: &str = "Calari audio test";
const MAX_MINUTES: u64 = 30;

struct Args {
    code: String,
    wav: PathBuf,
    minutes: u64,
    repeat: u32,
}

fn parse(args: &[String], allowed: Option<&str>) -> Result<Args, String> {
    let mut code = None;
    let mut wav = None;
    let mut minutes = 15;
    let mut repeat = 2;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--code" => code = Some(val()?),
            "--wav" => wav = Some(PathBuf::from(val()?)),
            "--minutes" => minutes = val()?.parse().map_err(|_| "--minutes must be a number")?,
            "--repeat" => repeat = val()?.parse().map_err(|_| "--repeat must be a number")?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let code = code.ok_or("--code is required")?;
    if !meet::valid_code(&code) {
        return Err("--code must be a Google Meet code like abc-defg-hij".into());
    }
    // Pinned twice: the operator's argument and the container's setting must
    // name the same meeting, so it can never wander into another one.
    if allowed != Some(code.as_str()) {
        return Err("CAP_SPEAKER_ALLOWED_CODE must equal --code".into());
    }
    let wav = wav.ok_or("--wav is required")?;
    if !wav.is_file() {
        return Err("--wav must be a readable audio file".into());
    }
    if minutes == 0 || minutes > MAX_MINUTES {
        return Err(format!("--minutes must be 1-{MAX_MINUTES}"));
    }
    if repeat == 0 || repeat > 5 {
        return Err("--repeat must be 1-5".into());
    }
    Ok(Args {
        code,
        wav,
        minutes,
        repeat,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let allowed = std::env::var("CAP_SPEAKER_ALLOWED_CODE").ok();
    let a = match parse(&args, allowed.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cap-meet-speaker: {e}");
            std::process::exit(2);
        }
    };
    std::process::exit(run(a));
}

fn run(a: Args) -> i32 {
    let chrome = std::env::var("CHROME_PATH").unwrap_or_else(|_| "chromium".into());
    let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
    let mic_sink = std::env::var("CAP_SPEAKER_SINK").unwrap_or_else(|_| "cap_spk".into());
    let deadline = Instant::now() + Duration::from_secs(a.minutes * 60);
    let mut browser = match cdp::Browser::launch(cdp::LaunchOptions {
        chrome: &chrome,
        profile: std::env::temp_dir().join("cap-speaker-profile"),
        // What it hears is discarded; what it says comes from cap_spk.
        pulse_sink: "spk_out",
        pulse_source: Some(&format!("{mic_sink}_mic")),
        no_sandbox: matches!(
            std::env::var("CAP_BOT_CHROME_NO_SANDBOX").as_deref(),
            Ok("1")
        ),
        headless: false,
    }) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cap-meet-speaker: browser: {e}");
            return 3;
        }
    };
    // Hard time limit, whatever happens.
    let done = Arc::new(AtomicBool::new(false));
    {
        let killer = browser.killer();
        let done = done.clone();
        std::thread::spawn(move || {
            while Instant::now() < deadline {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            eprintln!("cap-meet-speaker: time limit reached; leaving");
            killer.kill();
            std::process::exit(4);
        });
    }
    let url = format!("{}/{}?hl=en", cap_meeting_bot::meet_origin(), a.code);
    eprintln!("cap-meet-speaker: asking to join {} as \"{NAME}\"", a.code);
    let keep = || Instant::now() < deadline;
    let mut on_waiting = || eprintln!("cap-meet-speaker: waiting for the host to admit \"{NAME}\"");
    let joined = meet::join(
        &mut browser,
        &url,
        meet::JoinOptions {
            display_name: NAME,
            page_load_timeout: Duration::from_secs(90),
            waiting_timeout: Duration::from_secs(600),
            on_waiting: &mut on_waiting,
            keep_going: &keep,
            mute_microphone: false,
        },
    );
    match joined {
        Ok(meet::JoinOutcome::Admitted) => eprintln!("cap-meet-speaker: admitted"),
        other => {
            eprintln!("cap-meet-speaker: did not join: {other:?}");
            return 5;
        }
    }
    std::thread::sleep(Duration::from_secs(5));
    for n in 1..=a.repeat {
        eprintln!(
            "cap-meet-speaker: playing the scripted audio ({n}/{})",
            a.repeat
        );
        let status = Command::new(&ffmpeg)
            .args(["-nostdin", "-loglevel", "error", "-re", "-i"])
            .arg(&a.wav)
            .args(["-f", "pulse", "-device", &mic_sink, NAME])
            .status();
        if !matches!(status, Ok(s) if s.success()) {
            eprintln!("cap-meet-speaker: playback failed");
            meet::leave(&mut browser);
            return 6;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    meet::leave(&mut browser);
    done.store(true, Ordering::SeqCst);
    eprintln!("cap-meet-speaker: done; left the meeting");
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }
    #[test]
    fn pinned_code_bounded_time() {
        let wav = std::env::temp_dir().join(format!("spk-{}.ogg", std::process::id()));
        std::fs::write(&wav, b"OggS").unwrap();
        let w = wav.to_str().unwrap();
        assert!(parse(
            &args(&["--code", "abc-defg-hij", "--wav", w]),
            Some("abc-defg-hij")
        )
        .is_ok());
        for (a, allowed) in [
            (vec!["--code", "abc-defg-hij", "--wav", w], None),
            (
                vec!["--code", "abc-defg-hij", "--wav", w],
                Some("xyz-wxyz-xyz"),
            ),
            (
                vec!["--code", "https://evil.test/x", "--wav", w],
                Some("https://evil.test/x"),
            ),
            (
                vec!["--code", "abc-defg-hij", "--wav", "/nonexistent.ogg"],
                Some("abc-defg-hij"),
            ),
            (
                vec!["--code", "abc-defg-hij", "--wav", w, "--minutes", "999"],
                Some("abc-defg-hij"),
            ),
            (
                vec!["--code", "abc-defg-hij", "--wav", w, "--repeat", "0"],
                Some("abc-defg-hij"),
            ),
        ] {
            assert!(parse(&args(&a), allowed).is_err(), "{a:?} {allowed:?}");
        }
        let _ = std::fs::remove_file(wav);
    }
}
