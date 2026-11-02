//! `cap-meeting-bot`: polls Cap for due attendances and attends them one at
//! a time. Start it inside the isolated runner container (see
//! `infra/calendar-bot/`).

use cap_meeting_bot::runner::{run_job, Api, Outcome};
use std::time::Duration;

fn main() {
    #[cfg(target_os = "linux")]
    if let Err(e) = nix::sys::prctl::set_dumpable(false) {
        eprintln!("cap-meeting-bot: could not protect process memory: {e}");
        std::process::exit(2);
    }
    if !matches!(
        std::env::var("CAP_BOT_ENABLED").as_deref(),
        Ok("1" | "true")
    ) {
        // Deployed but switched off: stay idle without credentials.
        eprintln!("cap-meeting-bot: disabled (CAP_BOT_ENABLED is not set)");
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    let cfg = match cap_meeting_bot::config_from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cap-meeting-bot: {e}");
            std::process::exit(2);
        }
    };
    // Read once; children (FFmpeg) must not inherit it. Still single-threaded.
    std::env::remove_var("CAP_BOT_RUNNER_TOKEN");
    std::env::remove_var("CAP_BOT_RUNNER_TOKEN_FILE");
    // Browser profiles are throwaway; audio is not (see spool).
    let _ = std::fs::remove_dir_all(&cfg.profile_dir);
    if let Err(e) = cap_meeting_bot::spool::ensure(&cfg.spool_dir) {
        eprintln!("cap-meeting-bot: spool: {e}");
        std::process::exit(2);
    }
    let spool = cfg.spool_dir.clone();
    let cap = cfg.spool_max_bytes;
    let api = match Api::new(cfg) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cap-meeting-bot: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("cap-meeting-bot: ready");
    loop {
        // Finish uploads left by a crash, restart or outage first. This
        // never joins a meeting again.
        for id in cap_meeting_bot::spool::recover(&spool) {
            eprintln!("cap-meeting-bot: recovered and finalized meeting {id}");
        }
        let used = cap_meeting_bot::spool::size(&spool);
        if used > cap {
            // Fail closed: no new recording that could not be stored.
            eprintln!("cap-meeting-bot: spool holds {used} bytes (cap {cap}); not attending until uploads drain");
            std::thread::sleep(Duration::from_secs(30));
            continue;
        }
        match api.claim() {
            Ok(Some((job, lease_until))) => {
                let id = job.attendance_id;
                eprintln!("cap-meeting-bot: attending {id}");
                match run_job(&api, job, lease_until) {
                    Outcome::Completed => eprintln!("cap-meeting-bot: {id} completed"),
                    Outcome::Failed(why) => eprintln!("cap-meeting-bot: {id} failed: {why}"),
                    Outcome::LeaseLost => eprintln!("cap-meeting-bot: {id} lease lost"),
                }
                continue;
            }
            Ok(None) => {}
            Err(e) if e.contains("404") => {
                // Calendar attendance is switched off on the server.
                std::thread::sleep(Duration::from_secs(60));
                continue;
            }
            Err(e) => eprintln!("cap-meeting-bot: {e}"),
        }
        std::thread::sleep(Duration::from_secs(10));
    }
}
