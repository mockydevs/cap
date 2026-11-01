//! Internal meetings library: a list with a side panel, and a meeting page
//! with player and transcript. Server-rendered; `maud` escapes all text and
//! the only script is a static file.

use super::auth::WebUser;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use cap_meeting_protocol::{audio::AudioContainer, StaffRole};
use chrono::{DateTime, Utc};
use maud::{html, Markup, DOCTYPE};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

fn layout(title: &str, user: Option<&WebUser>, body: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                meta name="referrer" content="no-referrer";
                title { (title) " · Cap" }
                link rel="stylesheet" href="/static/app.css";
                script src="/static/app.js" defer {}
            }
            body {
                @if let Some(u) = user {
                    div.shell {
                        nav.side aria-label="Main" {
                            a.brand href="/meetings" { span.dot aria-hidden="true" {} "Cap" }
                            a.nav-item.active href="/meetings" { "Meetings" }
                            div.side-foot {
                                div.who {
                                    div.name { (u.name) }
                                    div.muted.small { (u.email) @if u.role == StaffRole::Admin { " · Admin" } }
                                }
                                form method="post" action="/logout" {
                                    input type="hidden" name="csrf" value=(u.csrf());
                                    button.link type="submit" { "Sign out" }
                                }
                            }
                        }
                        main.content { (body) }
                    }
                } @else {
                    main.solo { (body) }
                }
            }
        }
    }
}

pub fn message_page(status: StatusCode, title: &str, text: &str) -> Response {
    (
        status,
        layout(
            title,
            None,
            html! {
                div.card.narrow {
                    h1 { span.dot aria-hidden="true" {} (title) }
                    p { (text) }
                    a.button href="/login" { "Sign in with Calari" }
                }
            },
        ),
    )
        .into_response()
}

pub async fn signed_out() -> Response {
    message_page(StatusCode::OK, "Signed out", "You have signed out of Cap.")
}

fn fmt_duration(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn fmt_time(t: DateTime<Utc>) -> String {
    t.format("%d %b %Y, %H:%M UTC").to_string()
}

fn status_label(state: &str) -> (&'static str, &'static str) {
    match state {
        "recording" => ("Recording", "live"),
        "finalized" | "transcribing" | "summarizing" => ("Transcribing", "busy"),
        "delivering" => ("Sending to Calari", "busy"),
        "delivered" => ("In Calari", "ok"),
        "failed" => ("Needs attention", "bad"),
        _ => ("Unknown", "busy"),
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "internal_team" => "Internal",
        _ => "Client",
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    q: String,
}

pub async fn meetings(
    State(state): State<AppState>,
    user: WebUser,
    Query(query): Query<ListQuery>,
) -> Response {
    let q: String = query.q.trim().chars().take(100).collect();
    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let rows = match sqlx::query(
        "SELECT m.id, m.title, m.state, m.capture_mode, m.started_at, m.ended_at,
                p.pairing_kind, p.client_display_name, left(t.text, 180) AS preview
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         LEFT JOIN meeting_transcripts t ON t.meeting_id = m.id
         WHERE p.tenant_id = $1
           AND ($2 = '' OR m.title ILIKE $3 OR p.client_display_name ILIKE $3 OR t.text ILIKE $3)
         ORDER BY m.started_at DESC LIMIT 200",
    )
    .bind(&user.tenant_id)
    .bind(&q)
    .bind(&pattern)
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    layout(
        "Meetings",
        Some(&user),
        html! {
            header.top {
                h1 { "Meetings" }
                form.search method="get" action="/meetings" role="search" {
                    input type="search" name="q" value=(q) placeholder="Search titles, clients and transcripts" aria-label="Search meetings";
                }
            }
            @if rows.is_empty() {
                div.empty {
                    @if q.is_empty() {
                        p { "No meetings yet." }
                        p.muted { "Record one with the Cap desktop app or the Chrome extension; it appears here as soon as it starts." }
                    } @else {
                        p { "No meetings match \u{201c}" (q) "\u{201d}." }
                    }
                }
            } @else {
                ul.list {
                    @for r in &rows {
                        @let id: Uuid = r.get("id");
                        @let st: String = r.get("state");
                        @let (label, tone) = status_label(&st);
                        @let started: DateTime<Utc> = r.get("started_at");
                        @let ended: Option<DateTime<Utc>> = r.get("ended_at");
                        @let client: Option<String> = r.get("client_display_name");
                        @let mode: String = r.get("capture_mode");
                        @let preview: Option<String> = r.get("preview");
                        li {
                            a.row href={ "/meetings/" (id) } {
                                div.thumb.video[mode == "video"] aria-hidden="true" {}
                                div.main {
                                    div.title { (r.get::<String, _>("title")) }
                                    div.meta {
                                        span { (fmt_time(started)) }
                                        @if let Some(e) = ended { span { (fmt_duration((e - started).num_milliseconds())) } }
                                        span { (kind_label(&r.get::<String, _>("pairing_kind"))) @if let Some(c) = &client { " · " (c) } }
                                    }
                                    @if let Some(p) = preview { div.preview { (p) } }
                                }
                                span.badge.(tone) { (label) }
                            }
                        }
                    }
                }
            }
        },
    )
    .into_response()
}

#[derive(Deserialize)]
struct Seg {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

pub async fn meeting(
    State(state): State<AppState>,
    user: WebUser,
    Path(id): Path<Uuid>,
) -> Response {
    let row = match sqlx::query(
        "SELECT m.title, m.state, m.capture_mode, m.started_at, m.ended_at, m.stop_reason, m.partial, m.failure, m.meeting_url,
                p.pairing_kind, p.client_display_name, t.segments, t.model,
                d.status AS delivery_status, d.receipt_id, d.attempts
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         LEFT JOIN meeting_transcripts t ON t.meeting_id = m.id
         LEFT JOIN LATERAL (SELECT status, receipt_id, attempts FROM meeting_deliveries
                            WHERE meeting_id = m.id ORDER BY revision DESC LIMIT 1) d ON true
         WHERE m.id = $1 AND p.tenant_id = $2",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                layout("Not found", Some(&user), html! { h1 { "Meeting not found" } a href="/meetings" { "Back to meetings" } }),
            )
                .into_response()
        }
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    let parts = match sqlx::query(
        "SELECT seq, start_ms, duration_ms FROM meeting_chunks WHERE meeting_id = $1 ORDER BY seq",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    {
        Ok(p) => p,
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    let playlist: Vec<serde_json::Value> = parts
        .iter()
        .map(|p| {
            let seq: i32 = p.get("seq");
            serde_json::json!({
                "url": format!("/meetings/{id}/parts/{seq}"),
                "start_ms": p.get::<i64, _>("start_ms"),
                "duration_ms": p.get::<i64, _>("duration_ms"),
            })
        })
        .collect();
    let st: String = row.get("state");
    let (label, tone) = status_label(&st);
    let started: DateTime<Utc> = row.get("started_at");
    let ended: Option<DateTime<Utc>> = row.get("ended_at");
    let video = row.get::<String, _>("capture_mode") == "video";
    let segments: Vec<Seg> = row
        .get::<Option<serde_json::Value>, _>("segments")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let client: Option<String> = row.get("client_display_name");
    let title: String = row.get("title");
    let total_ms: i64 = parts
        .iter()
        .map(|p| p.get::<i64, _>("start_ms") + p.get::<i64, _>("duration_ms"))
        .max()
        .unwrap_or(0);
    layout(
        &title,
        Some(&user),
        html! {
            a.back href="/meetings" { "\u{2190} Meetings" }
            header.top {
                div {
                    h1 { (title) }
                    div.meta {
                        span { (fmt_time(started)) }
                        @if let Some(e) = ended { span { (fmt_duration((e - started).num_milliseconds())) } }
                        span { (kind_label(&row.get::<String, _>("pairing_kind"))) @if let Some(c) = &client { " · " (c) } }
                        @if let Some(r) = row.get::<Option<String>, _>("stop_reason") { span { "Stopped: " (r.replace('_', " ")) } }
                        @if row.get::<bool, _>("partial") { span.badge.bad { "Partial audio" } }
                    }
                }
                span.badge.(tone) { (label) }
            }
            div.detail {
                section.player {
                    @if playlist.is_empty() {
                        p.muted { "No audio has arrived yet." }
                    } @else {
                        div #playlist data-parts=(serde_json::Value::Array(playlist.clone()).to_string()) {
                            @if video { video #player controls preload="metadata" {} } @else { audio #player controls preload="metadata" {} }
                            div.timeline {
                                span #position { "0:00" } " / " span { (fmt_duration(total_ms)) }
                                @if playlist.len() > 1 { span.muted.small { " · plays " (playlist.len()) " parts back to back" } }
                            }
                        }
                        @if st == "recording" { p.muted.small { "Still recording; reload to hear newer audio." } }
                    }
                    dl.facts {
                        dt { "Calari" }
                        dd {
                            @match row.get::<Option<String>, _>("delivery_status").as_deref() {
                                Some("delivered") => { "Delivered" @if let Some(r) = row.get::<Option<String>, _>("receipt_id") { " (receipt " (r) ")" } }
                                Some("failed") => { "Failed after " (row.get::<Option<i32>, _>("attempts").unwrap_or(0)) " attempts" }
                                Some(_) => { "Sending" }
                                None => { "Not sent yet" }
                            }
                        }
                        @if let Some(m) = row.get::<Option<String>, _>("model") { dt { "Transcribed by" } dd { (m) } }
                        @if let Some(u) = row.get::<Option<String>, _>("meeting_url") {
                            dt { "Meeting link" } dd { a href=(u) rel="noopener noreferrer" target="_blank" { (u) } }
                        }
                        @if let Some(f) = row.get::<Option<String>, _>("failure") { dt { "Problem" } dd.error { (f) } }
                    }
                }
                section.transcript aria-label="Transcript" {
                    h2 { "Transcript" }
                    @if segments.is_empty() {
                        p.muted { @if st == "delivered" { "No speech was detected." } @else { "The transcript appears here when it is ready." } }
                    } @else {
                        ol.segments {
                            @for s in &segments {
                                li {
                                    button.ts type="button" data-seek=(s.start_ms) title={ "Play from " (fmt_duration(s.start_ms as i64)) } { (fmt_duration(s.start_ms as i64)) }
                                    span { (s.text) }
                                }
                            }
                        }
                        p.muted.small { (segments.len()) " segments · ends at " (fmt_duration(segments.last().map(|s| s.end_ms).unwrap_or(0) as i64)) }
                    }
                }
            }
        },
    )
    .into_response()
}

/// Serves bytes with single-range support so browsers can seek in them.
fn ranged(bytes: Vec<u8>, mime: &'static str, range: Option<&str>) -> Response {
    let total = bytes.len();
    let parsed = range
        .and_then(|r| r.strip_prefix("bytes="))
        .filter(|r| !r.contains(','))
        .and_then(|r| r.split_once('-'))
        .and_then(|(a, b)| match (a.trim(), b.trim()) {
            ("", n) => n
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0)
                .map(|n| (total.saturating_sub(n), total.saturating_sub(1))),
            (a, "") => a
                .parse::<usize>()
                .ok()
                .map(|a| (a, total.saturating_sub(1))),
            (a, b) => Some((
                a.parse().ok()?,
                b.parse::<usize>().ok()?.min(total.saturating_sub(1)),
            )),
        });
    match parsed {
        Some((start, end)) if start <= end && end < total => (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, mime.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                ),
                (header::CACHE_CONTROL, "private, no-store".to_owned()),
            ],
            bytes[start..=end].to_vec(),
        )
            .into_response(),
        Some(_) => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response(),
        None => (
            [
                (header::CONTENT_TYPE, mime.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (header::CACHE_CONTROL, "private, no-store".to_owned()),
            ],
            bytes,
        )
            .into_response(),
    }
}

/// One audio/video part, after re-checking the viewer may see the meeting.
/// S3 objects are handed out as short-lived pre-signed links.
pub async fn part(
    State(state): State<AppState>,
    user: WebUser,
    headers: axum::http::HeaderMap,
    Path((id, seq)): Path<(Uuid, i32)>,
) -> Response {
    let row = match sqlx::query(
        "SELECT c.object_key, c.container FROM meeting_chunks c
         JOIN meeting_sessions m ON m.id = c.meeting_id JOIN meeting_pairings p ON p.id = m.pairing_id
         WHERE c.meeting_id = $1 AND c.seq = $2 AND p.tenant_id = $3",
    )
    .bind(id)
    .bind(seq)
    .bind(&user.tenant_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    let key: String = row.get("object_key");
    let mime = AudioContainer::from_extension(&row.get::<String, _>("container"))
        .map(|c| c.mime())
        .unwrap_or("application/octet-stream");
    match state
        .store
        .presign_get(&key, std::time::Duration::from_secs(300))
        .await
    {
        Ok(Some(url)) => (
            StatusCode::FOUND,
            [
                (header::LOCATION, url),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
        )
            .into_response(),
        Ok(None) => match state.store.get(&key).await {
            Ok(bytes) => ranged(
                bytes,
                mime,
                headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
            ),
            Err(e) => {
                tracing::error!(error = %e, "reading a meeting part failed");
                StatusCode::SERVICE_UNAVAILABLE.into_response()
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "presigning a meeting part failed");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

pub const APP_CSS: &str = include_str!("app.css");
pub const APP_JS: &str = include_str!("app.js");

pub async fn css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        APP_CSS,
    )
        .into_response()
}

pub async fn js() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        APP_JS,
    )
        .into_response()
}

#[cfg(test)]
mod range_tests {
    use super::*;

    #[test]
    fn byte_ranges() {
        let r = ranged(b"0123456789".to_vec(), "audio/ogg", Some("bytes=2-4"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(
            ranged(b"0123456789".to_vec(), "audio/ogg", Some("bytes=-3")).headers()
                [header::CONTENT_RANGE],
            "bytes 7-9/10"
        );
        assert_eq!(
            ranged(b"0123456789".to_vec(), "audio/ogg", Some("bytes=8-")).headers()
                [header::CONTENT_RANGE],
            "bytes 8-9/10"
        );
        assert_eq!(
            ranged(b"0123456789".to_vec(), "audio/ogg", Some("bytes=20-30")).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            ranged(b"0123456789".to_vec(), "audio/ogg", None).status(),
            StatusCode::OK
        );
        assert_eq!(
            ranged(b"0123456789".to_vec(), "audio/ogg", Some("bytes=0-1,4-5")).status(),
            StatusCode::OK
        );
    }
}
