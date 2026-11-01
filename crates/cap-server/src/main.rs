use anyhow::Context;
use cap_server::{config::Config, meetings::worker, router, AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .json()
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("healthcheck") {
        // Container health probe: needs no database or config, only HTTP.
        return healthcheck();
    }
    let cfg = Config::from_env().context("invalid configuration")?;
    let state = AppState::new(cfg).await?;
    match args.first().map(String::as_str) {
        Some("migrate") => {
            tracing::info!("migrations applied");
            return Ok(());
        }
        Some("retry-meeting") => {
            let id = args
                .get(1)
                .and_then(|v| uuid::Uuid::parse_str(v).ok())
                .context("usage: cap-server retry-meeting <uuid>")?;
            worker::retry_failed(&state, id).await?;
            tracing::info!(meeting = %id, "meeting queued for retry");
            return Ok(());
        }
        Some(other) if other != "serve" => {
            anyhow::bail!("unknown command {other}; use serve, migrate or retry-meeting")
        }
        _ => {}
    }
    tracing::info!(bind = %state.cfg.bind, transcription = state.cfg.transcription_label(), "cap-server starting");
    tokio::spawn(worker::run(state.clone()));
    let listener = tokio::net::TcpListener::bind(state.cfg.bind).await?;
    let app = router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// GET /healthz on this container's own port; exits non-zero unless the
/// server answers 200 with "status":"ok".
fn healthcheck() -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let bind = std::env::var("CAP_SERVER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let mut addr: std::net::SocketAddr = bind.parse().context("CAP_SERVER_BIND")?;
    if addr.ip().is_unspecified() {
        addr.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
    }
    let timeout = std::time::Duration::from_secs(3);
    let mut stream = std::net::TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.write_all(format!("GET /healthz HTTP/1.0\r\nHost: {addr}\r\n\r\n").as_bytes())?;
    let mut response = String::new();
    stream.take(64 * 1024).read_to_string(&mut response)?;
    let ok_status = response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200");
    anyhow::ensure!(
        ok_status && response.contains(r#""status":"ok""#),
        "unhealthy: {}",
        response.lines().next().unwrap_or("")
    );
    Ok(())
}
