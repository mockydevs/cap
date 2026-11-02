//! Cap server. Phase 1 of ADR 0004: the meeting pipeline and the static
//! site. Later phases move the rest of the TypeScript backend here.

pub mod attendance;
pub mod calendar;
pub mod config;
pub mod downloads;
pub mod error;
pub mod google_calendar;
pub mod meetings;
pub mod store;
pub mod web;

use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post, put},
    Json, Router,
};
use std::sync::Arc;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<config::Config>,
    pub downloads: Arc<downloads::Catalog>,
    pub db: sqlx::PgPool,
    pub store: store::ObjectStore,
    pub http: reqwest::Client,
    pub transcriber: meetings::transcribe::Transcriber,
    pub worker_wake: Arc<tokio::sync::Notify>,
}

impl AppState {
    pub async fn new(cfg: config::Config) -> anyhow::Result<Self> {
        let downloads = Arc::new(downloads::Catalog::load(cfg.download_dir.as_deref()).await?);
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&cfg.database_url.0)
            .await
            .map_err(|e| anyhow::anyhow!("connecting to DATABASE_URL failed: {e}"))?;
        MIGRATOR.run(&db).await?;
        let store = store::ObjectStore::from_config(&cfg.storage).await?;
        let transcriber =
            meetings::transcribe::Transcriber::new(&cfg.transcription, &cfg.ffmpeg_path)?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        web::pages::CALENDAR_NAV
            .store(cfg.calendar.is_some(), std::sync::atomic::Ordering::Relaxed);
        Ok(Self {
            cfg: Arc::new(cfg),
            downloads,
            db,
            store,
            http,
            transcriber,
            worker_wake: Arc::new(tokio::sync::Notify::new()),
        })
    }

    pub fn wake_worker(&self) {
        self.worker_wake.notify_one();
    }
}

async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let db = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();
    Json(serde_json::json!({
        "status": if db { "ok" } else { "degraded" },
        "database": db,
        "transcription": state.cfg.transcription_label(),
    }))
}

pub fn router(state: AppState) -> Router {
    use meetings::api;
    let max_chunk = cap_meeting_protocol::MAX_VIDEO_CHUNK_BYTES + 1024;
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/v1/pairings", post(api::create_pairing))
        .route("/v1/pairings/redeem", post(api::redeem_pairing))
        .route("/v1/meetings", post(api::create_meeting))
        .route("/v1/meetings/{id}", get(api::get_meeting))
        .route(
            "/v1/meetings/{id}/chunks/{seq}",
            put(api::put_chunk).layer(DefaultBodyLimit::max(max_chunk)),
        )
        .route("/v1/meetings/{id}/finalize", post(api::finalize_meeting))
        .route("/v1/meetings/{id}/events", post(api::meeting_event))
        .route("/v1/meetings/{id}/cancel", post(api::cancel_meeting))
        .route("/v1/meetings/{id}/adopt", post(api::adopt_meeting))
        .route("/v1/calendar-bot/claim", post(attendance::bot_api::claim))
        .route(
            "/v1/calendar-bot/attendances/{id}/report",
            post(attendance::bot_api::report),
        )
        .merge(web::router())
        .merge(downloads::router(
            state.downloads.clone(),
            state.cfg.portal_url.clone(),
        ))
        .layer(DefaultBodyLimit::max(256 * 1024));
    app.layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
