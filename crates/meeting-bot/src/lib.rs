//! Calendar attendance runner (see `docs/integrations/calari/CALENDAR.md`).
//! Runs in its own container: no database, no Google or Calari secrets, no
//! Docker socket. It reaches only the Cap server and Google Meet.

pub mod cdp;
pub mod meet;
pub mod runner;
pub mod spool;

use std::{path::PathBuf, time::Duration};

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// Reads configuration from the environment; refuses unsafe values.
pub fn config_from_env() -> Result<runner::Config, String> {
    let server = var("CAP_SERVER_URL")
        .ok_or("CAP_SERVER_URL is required")?
        .trim_end_matches('/')
        .to_owned();
    let allow_http = matches!(var("CAP_BOT_ALLOW_HTTP").as_deref(), Some("1"));
    if !(server.starts_with("https://") || (allow_http && server.starts_with("http://"))) {
        return Err("CAP_SERVER_URL must be https".into());
    }
    let runner_token = match (
        var("CAP_BOT_RUNNER_TOKEN"),
        var("CAP_BOT_RUNNER_TOKEN_FILE"),
    ) {
        (Some(t), _) => t,
        (None, Some(path)) => std::fs::read_to_string(&path)
            .map_err(|_| "CAP_BOT_RUNNER_TOKEN_FILE unreadable")?
            .trim()
            .to_owned(),
        _ => return Err("CAP_BOT_RUNNER_TOKEN or CAP_BOT_RUNNER_TOKEN_FILE is required".into()),
    };
    if runner_token.len() < 32 {
        return Err("the runner token must be at least 32 characters".into());
    }
    let secs = |name: &str, default: u64| -> Result<Duration, String> {
        Ok(Duration::from_secs(match var(name) {
            Some(v) => v.parse().map_err(|_| format!("{name} is not a number"))?,
            None => default,
        }))
    };
    Ok(runner::Config {
        server,
        runner_token,
        chrome: var("CHROME_PATH").unwrap_or_else(|| "google-chrome".into()),
        ffmpeg: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()),
        spool_dir: PathBuf::from(
            var("CAP_BOT_SPOOL_DIR").unwrap_or_else(|| "/var/lib/cap-bot".into()),
        ),
        spool_max_bytes: secs("CAP_BOT_SPOOL_MAX_MB", 2048)?.as_secs() * 1024 * 1024,
        profile_dir: PathBuf::from(
            var("CAP_BOT_PROFILE_DIR").unwrap_or_else(|| "/tmp/cap-bot-profiles".into()),
        ),
        pulse_sink: var("CAP_BOT_PULSE_SINK").unwrap_or_else(|| "cap_bot".into()),
        no_sandbox: matches!(var("CAP_BOT_CHROME_NO_SANDBOX").as_deref(), Some("1")),
        meet_origin: meet_origin(),
        waiting_timeout: secs("CAP_BOT_WAITING_SECONDS", 600)?,
        page_load_timeout: secs("CAP_BOT_PAGE_LOAD_SECONDS", 90)?,
        heartbeat: secs("CAP_BOT_HEARTBEAT_SECONDS", 20)?,
        idle_warning: secs("CAP_BOT_IDLE_WARNING_SECONDS", 360)?,
        idle_stop: secs("CAP_BOT_IDLE_STOP_SECONDS", 180)?,
        segment_seconds: 30,
    })
}

#[cfg(not(feature = "fake-meet"))]
pub fn meet_origin() -> String {
    meet::MEET_ORIGIN.into()
}

/// Test builds only: a local stand-in for Meet.
#[cfg(feature = "fake-meet")]
pub fn meet_origin() -> String {
    var("CAP_BOT_TEST_MEET_ORIGIN").unwrap_or_else(|| meet::MEET_ORIGIN.into())
}
