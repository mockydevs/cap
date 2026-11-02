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
    // Audio from a previous crash is not resumable without its device token;
    // the server finalizes what it already received. Never keep it locally.
    let _ = std::fs::remove_dir_all(&cfg.work_dir);
    if let Err(e) = std::fs::create_dir_all(&cfg.work_dir) {
        eprintln!("cap-meeting-bot: work dir: {e}");
        std::process::exit(2);
    }
    let api = match Api::new(cfg) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cap-meeting-bot: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("cap-meeting-bot: ready");
    loop {
        match api.claim() {
            Ok(Some(job)) => {
                let id = job.attendance_id;
                eprintln!("cap-meeting-bot: attending {id}");
                match run_job(&api, job) {
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
