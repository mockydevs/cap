use anyhow::Context;
use cap_server::{config::Config, meetings::worker, router, AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .json()
        .init();
    let cfg = Config::from_env().context("invalid configuration")?;
    let args: Vec<String> = std::env::args().skip(1).collect();
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
