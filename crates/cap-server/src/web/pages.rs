//! Internal meetings library: a notes-first list with expandable rows, and a
//! meeting page with notes, player and transcript. Server-rendered; `maud`
//! escapes all text and the only script is a static file.

use super::auth::WebUser;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use cap_meeting_protocol::{audio::AudioContainer, StaffRole};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

/// Library times are shown in US Eastern time, with EST/EDT.
const ZONE: Tz = chrono_tz::America::New_York;

/// The approved Cap mark (speech bubble with audio bars), from
/// `assets/branding/cap-mark.svg`. Decorative: the brand name is text.
const MARK: &str = r##"<svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><rect x="32" y="32" width="960" height="960" rx="228" fill="#0b192c"/><path d="M332 232h360c68 0 124 56 124 124v240c0 68-56 124-124 124H452L300 820V716c-53-14-92-63-92-120V356c0-68 56-124 124-124Z" fill="#fff"/><rect x="352" y="407" width="64" height="144" rx="32" fill="#0b192c"/><rect x="480" y="327" width="64" height="304" rx="32" fill="#9d3292"/><rect x="608" y="375" width="64" height="208" rx="32" fill="#0b192c"/></svg>"##;

const ICON_AUDIO: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12h-2a5 5 0 0 1-10 0H5Z" fill="currentColor"/></svg>"#;
const ICON_VIDEO: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2.5l4.4 2.9A1 1 0 0 0 22 15.6V8.4a1 1 0 0 0-1.6-.8L16 10.5V8a2 2 0 0 0-2-2H4Z" fill="currentColor"/></svg>"#;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Nav {
    Meetings,
    Archived,
    Calendar,
    None,
}

pub(crate) fn layout(title: &str, user: Option<&WebUser>, body: Markup) -> Markup {
    let nav = if title == "Calendar" {
        Nav::Calendar
    } else {
        Nav::None
    };
    layout_nav(title, user, nav, body)
}

fn layout_nav(title: &str, user: Option<&WebUser>, nav: Nav, body: Markup) -> Markup {
    layout_full(title, user, nav, None, body)
}

fn layout_full(
    title: &str,
    user: Option<&WebUser>,
    nav: Nav,
    saved_draft: Option<&str>,
    body: Markup,
) -> Markup {
    let current = |n: Nav| if n == nav { Some("page") } else { None };
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                meta name="referrer" content="same-origin";
                title { (title) " · Cap" }
                link rel="stylesheet" href="/static/app.css";
                script src="/static/app.js" defer {}
            }
            body data-saved-draft=[saved_draft] {
                a.skip href="#main" { "Skip to content" }
                @if let Some(u) = user {
                    div.shell {
                        header.side {
                            a.brand href="/meetings" { (PreEscaped(MARK)) span { "Cap" } }
                            nav.nav aria-label="Main" {
                                a.nav-item href="/meetings" aria-current=[current(Nav::Meetings)] { "Meetings" }
                                a.nav-item href="/meetings?view=archived" aria-current=[current(Nav::Archived)] { "Archived" }
                                @if state_has_calendar() { a.nav-item href="/calendar" aria-current=[current(Nav::Calendar)] { "Calendar" } }
                            }
                            div.side-foot {
                                div.who {
                                    div.name { (u.name) }
                                    div.muted.small { (u.email) @if u.role == StaffRole::Admin { " · Admin" } }
                                }
                                form method="post" action="/logout" data-signout {
                                    input type="hidden" name="csrf" value=(u.csrf());
                                    button.link type="submit" { "Sign out" }
                                }
                            }
                        }
                        main.content #main tabindex="-1" { (body) }
                    }
                } @else {
                    main.solo #main tabindex="-1" { (body) }
                }
            }
        }
    }
}

/// Set once at start-up when calendar attendance is configured.
pub(crate) static CALENDAR_NAV: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn state_has_calendar() -> bool {
    CALENDAR_NAV.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn message_page(status: StatusCode, title: &str, text: &str) -> Response {
    (
        status,
        layout(
            title,
            None,
            html! {
                div.card.narrow {
                    div.brand.solo-brand { (PreEscaped(MARK)) span { "Cap" } }
                    h1 { (title) }
                    p { (text) }
                    a.button href="/login" { "Sign in with Calari" }
                }
            },
        ),
    )
        .into_response()
}

/// Who may see which meetings has not been agreed with Calari yet, so only
/// Calari admins see the library for now. Staff get a clear message rather
/// than access to every meeting in the workspace.
pub(crate) fn library_denied(user: &WebUser) -> Option<Response> {
    if user.role == StaffRole::Admin {
        return None;
    }
    Some((
        StatusCode::FORBIDDEN,
        layout(
            "No access yet",
            Some(user),
            html! {
                h1 { "Meetings are not available to your account yet" }
                p.muted { "Calari has not set which meetings staff accounts may see. Ask a Calari admin." }
            },
        ),
    )
        .into_response())
}

pub(crate) fn not_found(user: &WebUser) -> Response {
    (
        StatusCode::NOT_FOUND,
        layout_nav(
            "Not found",
            Some(user),
            Nav::None,
            html! { h1 { "Meeting not found" } p { a href="/meetings" { "Back to meetings" } } },
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

/// "Nov 3, 2026, 9:05 AM EST"
pub(crate) fn fmt_eastern(t: DateTime<Utc>) -> String {
    t.with_timezone(&ZONE)
        .format("%b %-d, %Y, %-I:%M %p %Z")
        .to_string()
}

/// "9:05 AM EST"
fn fmt_clock(t: DateTime<Utc>) -> String {
    t.with_timezone(&ZONE).format("%-I:%M %p %Z").to_string()
}

/// Day heading in Eastern time relative to `now`.
fn day_heading(t: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let day = t.with_timezone(&ZONE).date_naive();
    let today = now.with_timezone(&ZONE).date_naive();
    if day == today {
        format!("Today · {}", day.format("%a, %b %-d"))
    } else if Some(day) == today.pred_opt() {
        format!("Yesterday · {}", day.format("%a, %b %-d"))
    } else if day.format("%Y").to_string() == today.format("%Y").to_string() {
        day.format("%A, %b %-d").to_string()
    } else {
        day.format("%A, %b %-d, %Y").to_string()
    }
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

fn source_label(source: &str) -> &'static str {
    match source {
        "desktop" => "Desktop app",
        "extension" => "Chrome extension",
        "calendar_bot" => "Calendar notetaker",
        _ => "Recorder",
    }
}

/// Only plain web links are made clickable.
fn safe_link(url: &str) -> Option<&str> {
    let u = reqwest::Url::parse(url).ok()?;
    (matches!(u.scheme(), "https" | "http") && u.host_str().is_some()).then_some(url)
}

#[derive(Deserialize, Clone)]
pub(crate) struct Seg {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

/// A transcript line for display. Consecutive identical lines (a common
/// speech-to-text artefact) are shown once with a count; the stored
/// transcript is unchanged.
pub(crate) struct Line {
    start_ms: u64,
    end_ms: u64,
    text: String,
    repeats: usize,
}

fn norm(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

pub(crate) fn collapse(segs: &[Seg]) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for s in segs {
        let text = s.text.trim();
        if text.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if norm(&last.text) == norm(text) {
                last.repeats += 1;
                last.end_ms = s.end_ms;
                continue;
            }
        }
        out.push(Line {
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: text.to_owned(),
            repeats: 1,
        });
    }
    out
}

fn excerpt(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    view: String,
}

const STATUS_FILTERS: [(&str, &str); 4] = [
    ("recording", "Recording"),
    ("processing", "Processing"),
    ("in_calari", "In Calari"),
    ("attention", "Needs attention"),
];

fn status_states(filter: &str) -> Vec<String> {
    let s: &[&str] = match filter {
        "recording" => &["recording"],
        "processing" => &["finalized", "transcribing", "summarizing", "delivering"],
        "in_calari" => &["delivered"],
        "attention" => &["failed"],
        _ => &[],
    };
    s.iter().map(|s| (*s).to_owned()).collect()
}

const LIST_LIMIT: i64 = 200;

pub async fn meetings(
    State(state): State<AppState>,
    user: WebUser,
    Query(query): Query<ListQuery>,
) -> Response {
    if let Some(r) = library_denied(&user) {
        return r;
    }
    let q: String = query.q.trim().chars().take(100).collect();
    let archived = query.view == "archived";
    let status = if STATUS_FILTERS.iter().any(|(k, _)| *k == query.status) {
        query.status.as_str()
    } else {
        ""
    };
    let kind = match query.kind.as_str() {
        "client" | "internal" => query.kind.as_str(),
        _ => "",
    };
    let filtered = !q.is_empty() || !status.is_empty() || !kind.is_empty();
    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let counts = match sqlx::query(
        "SELECT count(*) FILTER (WHERE lm.archived_at IS NULL) AS active,
                count(*) FILTER (WHERE lm.archived_at IS NOT NULL) AS archived
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         LEFT JOIN library_meetings lm ON lm.meeting_id = m.id
         WHERE p.tenant_id = $1",
    )
    .bind(&user.tenant_id)
    .fetch_one(&state.db)
    .await
    {
        Ok(r) => (r.get::<i64, _>("active"), r.get::<i64, _>("archived")),
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    let rows = match sqlx::query(
        "SELECT m.id, m.title, lm.display_title, m.state, m.capture_mode, m.source, m.started_at, m.ended_at,
                p.pairing_kind, p.client_display_name,
                (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(t.segments) e LIMIT 40) x) AS head,
                (SELECT count(*) FROM library_notes n WHERE n.meeting_id = m.id) AS notes,
                ln.body AS note_body, ln.updated_by_name AS note_by, ln.updated_at AS note_at
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         LEFT JOIN library_meetings lm ON lm.meeting_id = m.id
         LEFT JOIN meeting_transcripts t ON t.meeting_id = m.id
         LEFT JOIN LATERAL (SELECT body, updated_by_name, updated_at FROM library_notes
                            WHERE meeting_id = m.id ORDER BY updated_at DESC LIMIT 1) ln ON true
         WHERE p.tenant_id = $1
           AND (lm.archived_at IS NOT NULL) = $2
           AND ($3 = '' OR m.title ILIKE $4 OR lm.display_title ILIKE $4 OR p.client_display_name ILIKE $4
                OR t.text ILIKE $4
                OR EXISTS (SELECT 1 FROM library_notes n WHERE n.meeting_id = m.id AND n.body ILIKE $4))
           AND (cardinality($5::text[]) = 0 OR m.state = ANY($5))
           AND ($6 = '' OR (p.pairing_kind = 'internal_team') = ($6 = 'internal'))
         ORDER BY m.started_at DESC LIMIT $7",
    )
    .bind(&user.tenant_id)
    .bind(archived)
    .bind(&q)
    .bind(&pattern)
    .bind(status_states(status))
    .bind(kind)
    .bind(LIST_LIMIT)
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return crate::error::ApiError::from(e).into_response(),
    };
    let now = Utc::now();
    let mut days: Vec<(String, Vec<&sqlx::postgres::PgRow>)> = Vec::new();
    for r in &rows {
        let day = day_heading(r.get("started_at"), now);
        match days.last_mut() {
            Some((d, g)) if *d == day => g.push(r),
            _ => days.push((day, vec![r])),
        }
    }
    let heading = if archived {
        "Archived meetings"
    } else {
        "Meetings"
    };
    let total = if archived { counts.1 } else { counts.0 };
    let body = html! {
        header.page-head {
            div {
                h1 { (heading) }
                p.muted.small {
                    @if filtered {
                        (rows.len()) @if rows.len() as i64 >= LIST_LIMIT { "+" } " of " (total) " " (if total == 1 { "meeting" } else { "meetings" }) " match"
                    } @else {
                        (total) " " (if total == 1 { "meeting" } else { "meetings" })
                        @if rows.len() as i64 >= LIST_LIMIT { " · showing the newest " (LIST_LIMIT) }
                    }
                }
            }
        }
        nav.tabs aria-label="Library views" {
            a.tab href="/meetings" aria-current=[(!archived).then_some("page")] { "Active " span.count { (counts.0) } }
            a.tab href="/meetings?view=archived" aria-current=[archived.then_some("page")] { "Archived " span.count { (counts.1) } }
        }
        form.filters method="get" action="/meetings" role="search" aria-label="Filter meetings" {
            @if archived { input type="hidden" name="view" value="archived"; }
            label.field.grow {
                span.visually-hidden { "Search" }
                input type="search" name="q" value=(q) maxlength="100" placeholder="Search titles, clients, transcripts and notes";
            }
            label.field {
                span.visually-hidden { "Status" }
                select name="status" {
                    option value="" selected[status.is_empty()] { "Any status" }
                    @for (k, l) in STATUS_FILTERS { option value=(k) selected[status == k] { (l) } }
                }
            }
            label.field {
                span.visually-hidden { "Meeting type" }
                select name="kind" {
                    option value="" selected[kind.is_empty()] { "All types" }
                    option value="client" selected[kind == "client"] { "Client" }
                    option value="internal" selected[kind == "internal"] { "Internal" }
                }
            }
            button.btn.secondary type="submit" { "Search" }
            @if filtered { a.btn.ghost href={ "/meetings" @if archived { "?view=archived" } } { "Clear" } }
        }
        @if rows.is_empty() {
            div.empty {
                @if filtered {
                    p.empty-title { "No meetings match these filters." }
                    p.muted { "Try fewer words, or " a href={ "/meetings" @if archived { "?view=archived" } } { "clear the filters" } "." }
                } @else if archived {
                    p.empty-title { "Nothing is archived." }
                    p.muted { "Archiving hides a finished meeting from the main list without deleting anything. Restore it any time." }
                } @else {
                    p.empty-title { "No meetings yet." }
                    p.muted { "Record one with the Cap desktop app or the Chrome extension; it appears here as soon as recording starts." }
                }
            }
        } @else {
            @for (day, group) in &days {
                h2.day { (day) }
                ul.list { @for r in group { (row(r)) } }
            }
        }
    };
    layout_nav(
        heading,
        Some(&user),
        if archived {
            Nav::Archived
        } else {
            Nav::Meetings
        },
        body,
    )
    .into_response()
}

fn row(r: &sqlx::postgres::PgRow) -> Markup {
    let id: Uuid = r.get("id");
    let st: String = r.get("state");
    let (label, tone) = status_label(&st);
    let started: DateTime<Utc> = r.get("started_at");
    let ended: Option<DateTime<Utc>> = r.get("ended_at");
    let client: Option<String> = r.get("client_display_name");
    let video = r.get::<String, _>("capture_mode") == "video";
    let recorded: String = r.get("title");
    let title = r
        .get::<Option<String>, _>("display_title")
        .unwrap_or_else(|| recorded.clone());
    let head: Vec<Seg> = r
        .get::<Option<serde_json::Value>, _>("head")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let lines = collapse(&head);
    let notes: i64 = r.get("notes");
    let note_body: Option<String> = r.get("note_body");
    let panel = format!("m-{}", id.simple());
    html! {
        li {
            details.meeting {
                summary.row aria-describedby=(panel) {
                    span.icon.video[video] { (PreEscaped(if video { ICON_VIDEO } else { ICON_AUDIO })) }
                    span.main {
                        span.title { (title) }
                        span.meta {
                            span { (fmt_clock(started)) }
                            span { @if let Some(e) = ended { (fmt_duration((e - started).num_milliseconds())) } @else if st == "recording" { "In progress" } @else { "—" } }
                            span { (kind_label(&r.get::<String, _>("pairing_kind"))) @if let Some(c) = &client { " · " (c) } }
                            span { (source_label(&r.get::<String, _>("source"))) @if video { " · video" } }
                        }
                    }
                    span.aside {
                        @if notes > 0 { span.chip { (notes) " " (if notes == 1 { "note" } else { "notes" }) } }
                        span.badge.(tone) { (label) }
                        span.chev aria-hidden="true" {}
                    }
                }
                div.panel id=(panel) {
                    div.panel-grid {
                        section aria-label="Latest note" {
                            h3 { "Notes" }
                            @if let Some(b) = &note_body {
                                p.note-excerpt { (excerpt(b, 280)) }
                                p.muted.small {
                                    (r.get::<Option<String>, _>("note_by").unwrap_or_default())
                                    @if let Some(t) = r.get::<Option<DateTime<Utc>>, _>("note_at") { " · " (fmt_eastern(t)) }
                                    @if notes > 1 { " · " (notes - 1) " more" }
                                }
                            } @else {
                                p.muted { "No notes yet." }
                            }
                        }
                        section aria-label="Transcript start" {
                            h3 { "Transcript" }
                            @if lines.is_empty() {
                                p.muted { @match st.as_str() {
                                    "recording" => "Recording now. The transcript follows when it ends.",
                                    "delivered" => "No speech was detected.",
                                    "failed" => "No transcript. Open the meeting to see what went wrong.",
                                    _ => "The transcript appears here when it is ready.",
                                } }
                            } @else {
                                ol.excerpt-lines {
                                    @for l in lines.iter().take(3) {
                                        li { span.ts-label { (fmt_duration(l.start_ms as i64)) } span { (excerpt(&l.text, 160)) @if l.repeats > 1 { span.repeat { " ×" (l.repeats) } } } }
                                    }
                                }
                            }
                        }
                    }
                    div.panel-actions {
                        a.btn.primary href={ "/meetings/" (id) } { "Open meeting" }
                        a.btn.secondary href={ "/meetings/" (id) "#notes" } { "Notes" }
                        @if title != recorded { span.muted.small { "Recorded as “" (recorded) "”" } }
                    }
                }
            }
        }
    }
}

/// Which form a kept draft belongs to.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DraftTarget {
    Title,
    NewNote,
    Note(Uuid),
}

/// Text the user submitted that could not be saved; shown back in its form.
pub(crate) struct Draft {
    pub target: DraftTarget,
    pub text: String,
}

#[derive(Default)]
pub(crate) struct Flash {
    pub done: Option<&'static str>,
    pub problem: Option<String>,
    pub draft: Option<Draft>,
    pub confirm_archive: bool,
    pub confirm_delete: Option<Uuid>,
    /// Draft key the browser should forget because it was saved.
    pub saved_draft: Option<String>,
}

#[derive(Deserialize)]
pub struct MeetingQuery {
    #[serde(default)]
    done: String,
    #[serde(default)]
    confirm: String,
    #[serde(default)]
    note: String,
}

fn done_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "renamed" => "Title saved.",
        "archived" => "Meeting archived. It is hidden from the main list; nothing was deleted.",
        "already_archived" => "This meeting was already archived.",
        "restored" => "Meeting restored to the main list.",
        "already_restored" => "This meeting was already restored.",
        "note_added" => "Note added.",
        "note_saved" => "Note saved.",
        "note_deleted" => "Note deleted.",
        "note_already_deleted" => "That note had already been deleted.",
        _ => return None,
    })
}

pub async fn meeting(
    State(state): State<AppState>,
    user: WebUser,
    Path(id): Path<Uuid>,
    Query(q): Query<MeetingQuery>,
) -> Response {
    if let Some(r) = library_denied(&user) {
        return r;
    }
    let note = Uuid::parse_str(&q.note).ok();
    let saved_draft = match q.done.as_str() {
        "renamed" => Some("title".to_owned()),
        "note_added" => Some("new".to_owned()),
        "note_saved" => note.map(|n| format!("note.{n}")),
        _ => None,
    };
    let flash = Flash {
        done: done_message(&q.done),
        confirm_archive: q.confirm == "archive",
        confirm_delete: if q.confirm == "delete" { note } else { None },
        saved_draft,
        ..Flash::default()
    };
    render_meeting(&state, &user, id, flash, StatusCode::OK).await
}

/// The meeting page. Callers have already checked the viewer's role.
pub(crate) async fn render_meeting(
    state: &AppState,
    user: &WebUser,
    id: Uuid,
    flash: Flash,
    status: StatusCode,
) -> Response {
    let row = match sqlx::query(
        "SELECT m.title, m.state, m.capture_mode, m.source, m.started_at, m.ended_at, m.stop_reason, m.partial, m.failure, m.meeting_url,
                p.pairing_kind, p.client_display_name, t.segments, t.model,
                lm.display_title, lm.archived_at, lm.version AS meta_version,
                d.status AS delivery_status, d.receipt_id, d.attempts, d.delivered_at
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         LEFT JOIN meeting_transcripts t ON t.meeting_id = m.id
         LEFT JOIN library_meetings lm ON lm.meeting_id = m.id
         LEFT JOIN LATERAL (SELECT status, receipt_id, attempts, delivered_at FROM meeting_deliveries
                            WHERE meeting_id = m.id ORDER BY revision DESC LIMIT 1) d ON true
         WHERE m.id = $1 AND p.tenant_id = $2",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return not_found(user),
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
    let notes = match sqlx::query(
        "SELECT id, body, version, created_by_name, created_at, updated_by_name, updated_at
         FROM library_notes WHERE meeting_id = $1 AND tenant_id = $2 ORDER BY created_at DESC, id",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(n) => n,
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
    let lines = collapse(&segments);
    let client: Option<String> = row.get("client_display_name");
    let recorded: String = row.get("title");
    let title = row
        .get::<Option<String>, _>("display_title")
        .unwrap_or_else(|| recorded.clone());
    let archived_at: Option<DateTime<Utc>> = row.get("archived_at");
    let archived = archived_at.is_some();
    let meta_version: i32 = row.get::<Option<i32>, _>("meta_version").unwrap_or(0);
    let finished = st == "delivered" || st == "failed";
    let delivered = row.get::<Option<String>, _>("delivery_status").as_deref() == Some("delivered");
    let total_ms: i64 = parts
        .iter()
        .map(|p| p.get::<i64, _>("start_ms") + p.get::<i64, _>("duration_ms"))
        .max()
        .unwrap_or(0);
    let csrf = user.csrf();
    let draft_for = |t: DraftTarget| {
        flash
            .draft
            .as_ref()
            .filter(|d| d.target == t)
            .map(|d| d.text.as_str())
    };
    let title_draft = draft_for(DraftTarget::Title);
    let new_draft = draft_for(DraftTarget::NewNote);
    let base = format!("/meetings/{id}");
    let portal = state.cfg.portal_url.as_deref();
    let body = html! {
        header.page-head.meeting-head #top {
            nav.crumbs aria-label="Breadcrumb" {
                @if archived { a href="/meetings?view=archived" { "Archived" } } @else { a href="/meetings" { "Meetings" } }
                span aria-hidden="true" { " / " }
            }
            div.title-row #title {
                h1 { (title) }
                span.badge.(tone) { (label) }
                @if archived { span.badge.muted-badge { "Archived" } }
            }
            div.meta {
                span { (fmt_eastern(started)) }
                span { @if let Some(e) = ended { (fmt_duration((e - started).num_milliseconds())) } @else if st == "recording" { "In progress" } @else { "—" } }
                span { (kind_label(&row.get::<String, _>("pairing_kind"))) @if let Some(c) = &client { " · " (c) } }
                span { (source_label(&row.get::<String, _>("source"))) " · " (if video { "video" } else { "audio" }) }
            }
            @if title != recorded { p.muted.small { "Recorded as “" (recorded) "”. Renaming only changes how it is listed in Cap." } }
            div.actions {
                @if !archived {
                    details.inline-edit open[title_draft.is_some()] {
                        summary.btn.secondary { "Rename" }
                        form.stack method="post" action={ (base) "/title" } data-guard {
                            input type="hidden" name="csrf" value=(csrf);
                            input type="hidden" name="version" value=(meta_version);
                            label for="title-input" { "Title shown in Cap" }
                            input #title-input type="text" name="title" maxlength="200" value=(title_draft.unwrap_or(&title))
                                data-draft={ (id) ".title" } data-server-draft[title_draft.is_some()];
                            p.muted.small { "Leave empty to use the recorded title. Calari keeps the title it received." }
                            div.row-actions { button.btn.primary type="submit" { "Save title" } }
                        }
                    }
                    @if finished {
                        a.btn.secondary href={ (base) "?confirm=archive#top" } { "Archive" }
                    }
                } @else {
                    form method="post" action={ (base) "/restore" } data-guard {
                        input type="hidden" name="csrf" value=(csrf);
                        input type="hidden" name="version" value=(meta_version);
                        button.btn.primary type="submit" { "Restore" }
                    }
                }
                @if let (Some(p), true) = (portal, delivered) {
                    a.btn.ghost href=(p) target="_blank" rel="noopener noreferrer" { "Open Calari" span.visually-hidden { " (opens in a new tab)" } }
                }
            }
            div #notice aria-live="polite" {
                @if let Some(m) = flash.done { p.notice.ok role="status" { (m) } }
                @if let Some(m) = &flash.problem { p.notice.bad role="alert" { (m) } }
            }
            @if flash.confirm_archive && !archived && finished {
                section.confirm aria-labelledby="confirm-archive" {
                    h2 #confirm-archive { "Archive this meeting?" }
                    p { "It leaves the main list and its notes become read-only. Audio, transcript and notes are kept, nothing is sent to Calari, and you can restore it any time." }
                    form.row-actions method="post" action={ (base) "/archive" } data-guard {
                        input type="hidden" name="csrf" value=(csrf);
                        input type="hidden" name="version" value=(meta_version);
                        button.btn.primary type="submit" { "Archive meeting" }
                        a.btn.ghost href=(base) { "Cancel" }
                    }
                }
            }
            @if let Some(t) = archived_at {
                p.banner { "Archived " (fmt_eastern(t)) ". Notes and title are read-only until you restore it." }
            }
        }
        div.detail {
            div.main-col {
                section.card #notes aria-labelledby="notes-h" {
                    div.card-head {
                        h2 #notes-h { "Notes" }
                        span.muted.small { (notes.len()) " " (if notes.len() == 1 { "note" } else { "notes" }) " · kept in Cap, not sent to Calari" }
                    }
                    @if !archived {
                        form.note-new method="post" action={ (base) "/notes" } data-guard {
                            input type="hidden" name="csrf" value=(csrf);
                            input type="hidden" name="submit_key" value=(Uuid::new_v4());
                            label.visually-hidden for="new-note" { "New note" }
                            textarea #new-note name="body" rows="4" maxlength="20000" required
                                placeholder="Write a note: decisions, follow-ups, context for the team"
                                data-draft={ (id) ".new" } data-server-draft[new_draft.is_some()] { (new_draft.unwrap_or("")) }
                            div.row-actions {
                                span.muted.small.draft-state aria-live="polite" {}
                                button.btn.primary type="submit" { "Add note" }
                            }
                        }
                    }
                    @if archived {
                        @if let Some(d) = new_draft.or(title_draft) {
                            div.kept {
                                label for="kept-text" { "Your text was not saved. Copy it before leaving:" }
                                textarea #kept-text readonly rows="3" { (d) }
                            }
                        }
                    }
                    @if notes.is_empty() {
                        p.muted.empty-notes { @if archived { "No notes were written for this meeting." } @else { "No notes yet. Notes you add here are visible to Calari admins in Cap." } }
                    } @else {
                        ol.notes {
                            @for n in &notes {
                                @let nid: Uuid = n.get("id");
                                @let version: i32 = n.get("version");
                                @let body: String = n.get("body");
                                @let created: DateTime<Utc> = n.get("created_at");
                                @let updated: DateTime<Utc> = n.get("updated_at");
                                @let edit_draft = draft_for(DraftTarget::Note(nid));
                                li.note id={ "note-" (nid) } {
                                    div.note-head {
                                        span.author { (n.get::<String, _>("created_by_name")) }
                                        span.muted.small {
                                            (fmt_eastern(created))
                                            @if version > 1 { " · edited by " (n.get::<String, _>("updated_by_name")) " " (fmt_eastern(updated)) }
                                        }
                                    }
                                    div.note-body { (body) }
                                    @if !archived {
                                        @if flash.confirm_delete == Some(nid) {
                                            form.confirm.row-actions method="post" action={ (base) "/notes/" (nid) "/delete" } data-guard aria-label="Confirm delete" {
                                                input type="hidden" name="csrf" value=(csrf);
                                                input type="hidden" name="version" value=(version);
                                                span { "Delete this note? This cannot be undone." }
                                                button.btn.danger type="submit" { "Delete note" }
                                                a.btn.ghost href={ (base) "#note-" (nid) } { "Cancel" }
                                            }
                                        }
                                        div.note-actions {
                                            details.inline-edit open[edit_draft.is_some()] {
                                                summary.btn.ghost.small-btn { "Edit" }
                                                form.stack method="post" action={ (base) "/notes/" (nid) } data-guard {
                                                    input type="hidden" name="csrf" value=(csrf);
                                                    input type="hidden" name="version" value=(version);
                                                    label.visually-hidden for={ "edit-" (nid) } { "Edit note" }
                                                    textarea id={ "edit-" (nid) } name="body" rows="5" maxlength="20000" required
                                                        data-draft={ (id) ".note." (nid) } data-server-draft[edit_draft.is_some()] { (edit_draft.unwrap_or(&body)) }
                                                    div.row-actions {
                                                        span.muted.small.draft-state aria-live="polite" {}
                                                        button.btn.primary type="submit" { "Save note" }
                                                    }
                                                }
                                            }
                                            @if flash.confirm_delete != Some(nid) {
                                                a.btn.ghost.small-btn href={ (base) "?confirm=delete&note=" (nid) "#note-" (nid) } { "Delete" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                section.card.transcript #transcript aria-labelledby="transcript-h" {
                    div.card-head {
                        h2 #transcript-h { "Transcript" }
                        @if !lines.is_empty() { span.muted.small { "Ends at " (fmt_duration(segments.last().map(|s| s.end_ms).unwrap_or(0) as i64)) } }
                    }
                    @if lines.is_empty() {
                        p.muted { @match st.as_str() {
                            "recording" => "Recording now. The transcript appears when the meeting ends.",
                            "delivered" => "No speech was detected.",
                            "failed" => "There is no transcript. See the problem noted beside the player.",
                            _ => "The transcript appears here when it is ready.",
                        } }
                    } @else {
                        ol.segments {
                            @for l in &lines {
                                li {
                                    button.ts type="button" data-seek=(l.start_ms) aria-label={ "Play from " (fmt_duration(l.start_ms as i64)) } { (fmt_duration(l.start_ms as i64)) }
                                    span {
                                        (l.text)
                                        @if l.repeats > 1 { span.repeat title="Repeated consecutive lines are shown once" { " ×" (l.repeats) } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            aside.side-col aria-label="Recording" {
                section.card.player {
                    h2.visually-hidden { "Recording" }
                    @if playlist.is_empty() {
                        p.muted { "No audio has arrived yet." }
                    } @else {
                        div #playlist data-parts=(serde_json::Value::Array(playlist.clone()).to_string()) {
                            @if video { video #player controls preload="metadata" {} } @else { audio #player controls preload="metadata" {} }
                            @if playlist.len() > 1 {
                                div.timeline {
                                    span #position { "0:00" } " / " span { (fmt_duration(total_ms)) }
                                    span.muted.small { " · plays " (playlist.len()) " parts back to back" }
                                }
                            }
                        }
                        @if st == "recording" { p.muted.small { "Still recording; reload to hear newer audio." } }
                    }
                    dl.facts {
                        dt { "Calari" }
                        dd {
                            @match row.get::<Option<String>, _>("delivery_status").as_deref() {
                                Some("delivered") => {
                                    "Delivered"
                                    @if let Some(t) = row.get::<Option<DateTime<Utc>>, _>("delivered_at") { " " (fmt_eastern(t)) }
                                    @if let Some(r) = row.get::<Option<String>, _>("receipt_id") { br; span.muted.small { "Receipt " (r) } }
                                }
                                Some("failed") => { "Failed after " (row.get::<Option<i32>, _>("attempts").unwrap_or(0)) " attempts" }
                                Some(_) => { "Sending" }
                                None => { "Not sent yet" }
                            }
                        }
                        dt { "Summary" }
                        dd.muted { "Calari writes the summary and tasks from the transcript. Edits here do not change them." }
                        @if let Some(m) = row.get::<Option<String>, _>("model") { dt { "Transcribed by" } dd { (m) } }
                        @if let Some(r) = row.get::<Option<String>, _>("stop_reason") { dt { "Stopped" } dd { (r.replace('_', " ")) } }
                        @if row.get::<bool, _>("partial") { dt { "Audio" } dd.error { "Partial: some audio is missing" } }
                        @if let Some(u) = row.get::<Option<String>, _>("meeting_url") {
                            dt { "Meeting link" }
                            dd { @if let Some(l) = safe_link(&u) { a href=(l) rel="noopener noreferrer" target="_blank" { (u) } } @else { (u) } }
                        }
                        @if let Some(f) = row.get::<Option<String>, _>("failure") { dt { "Problem" } dd.error { (f) } }
                    }
                }
            }
        }
    };
    let nav = if archived {
        Nav::Archived
    } else {
        Nav::Meetings
    };
    let saved = flash.saved_draft.as_ref().map(|k| format!("{id}.{k}"));
    (
        status,
        layout_full(&title, Some(user), nav, saved.as_deref(), body),
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
/// Archiving does not change access: archived meetings stay playable for
/// the same viewers, and nothing is purged.
pub async fn part(
    State(state): State<AppState>,
    user: WebUser,
    headers: axum::http::HeaderMap,
    Path((id, seq)): Path<(Uuid, i32)>,
) -> Response {
    if let Some(r) = library_denied(&user) {
        return r;
    }
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
    // Streamed through Cap after this request's Calari check; no storage
    // link is handed out that could outlive the check.
    match state.store.get(&key).await {
        Ok(bytes) => ranged(
            bytes,
            mime,
            headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        ),
        Err(e) => {
            tracing::error!(error = %e, "reading a meeting part failed");
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
mod tests {
    use super::*;
    use chrono::TimeZone;

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

    #[test]
    fn eastern_times_name_the_zone() {
        let winter = Utc.with_ymd_and_hms(2026, 11, 3, 14, 5, 0).unwrap();
        let summer = Utc.with_ymd_and_hms(2026, 7, 1, 13, 5, 0).unwrap();
        assert_eq!(fmt_eastern(winter), "Nov 3, 2026, 9:05 AM EST");
        assert_eq!(fmt_eastern(summer), "Jul 1, 2026, 9:05 AM EDT");
        // 03:30 UTC on Nov 4 is still Nov 3 in New York.
        let late = Utc.with_ymd_and_hms(2026, 11, 4, 3, 30, 0).unwrap();
        assert!(day_heading(late, late).starts_with("Today · Tue, Nov 3"));
    }

    #[test]
    fn repeated_lines_collapse_for_display() {
        let s = |t: &str, a: u64| Seg {
            start_ms: a,
            end_ms: a + 1000,
            text: t.into(),
        };
        let lines = collapse(&[
            s("Thank you.", 0),
            s(" thank you ", 1000),
            s("Thank you!", 2000),
            s("", 3000),
            s("Next item", 4000),
        ]);
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].repeats, lines[0].end_ms), (3, 3000));
        assert_eq!(lines[1].text, "Next item");
    }

    #[test]
    fn only_web_links_are_clickable() {
        assert!(safe_link("https://meet.google.com/abc-defg-hij").is_some());
        assert!(safe_link("javascript:alert(1)").is_none());
        assert!(safe_link("data:text/html,x").is_none());
    }
}
