//! Calendar settings for the signed-in Calari staff member: connect Google
//! Calendar once (read-only, offline, PKCE + one-time state bound to this
//! Cap session and browser), see upcoming Meet meetings and how each will be
//! routed, choose a client when Cap cannot tell, pause, or disconnect.

use super::{crypto, schedule, Connection, PURPOSE_REFRESH};
use crate::{
    error::ApiError,
    google_calendar as google,
    web::{auth::WebUser, pages},
    AppState,
};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{AppendHeaders, IntoResponse, Redirect, Response},
    Form,
};
use cap_meeting_protocol::{
    ids::{random_token, sha256_hex},
    pkce_s256,
};
use chrono::{DateTime, Duration, Utc};
use maud::html;
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

const ATTEMPT_MINUTES: i64 = 10;

fn browser_cookie_name(production: bool) -> &'static str {
    if production {
        "__Host-cap_cal"
    } else {
        "cap_cal"
    }
}

fn browser_cookie(production: bool, value: &str, max_age: i64) -> String {
    format!(
        "{}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{}",
        browser_cookie_name(production),
        if production { "; Secure" } else { "" }
    )
}

pub fn callback_url(state: &AppState) -> String {
    format!("{}/calendar/google/callback", state.cfg.public_base_url)
}

/// Admin-only until per-staff library ownership exists (see CALENDAR.md).
fn role_denied(state: &AppState, user: &WebUser) -> Option<Response> {
    let allowed = user.role == cap_meeting_protocol::StaffRole::Admin
        || state.cfg.calendar.as_ref().is_some_and(|c| c.allow_staff);
    (!allowed).then(|| {
        page_error(
            user,
            StatusCode::FORBIDDEN,
            "Calendar is not available yet",
            "Calendar attendance is open to Calari admins first. Ask a Calari admin.",
        )
    })
}

fn not_enabled() -> Response {
    pages::message_page(
        StatusCode::NOT_FOUND,
        "Calendar is not set up",
        "Calendar attendance is not enabled on this Cap server.",
    )
}

fn page_error(user: &WebUser, status: StatusCode, title: &str, text: &str) -> Response {
    (
        status,
        pages::layout(
            title,
            Some(user),
            html! {
                h1 { (title) }
                p { (text) }
                a.button href="/calendar" { "Back to calendar" }
            },
        ),
    )
        .into_response()
}

/// Same-origin form with this session's token.
fn form_ok(state: &AppState, headers: &HeaderMap, user: &WebUser, csrf: &str) -> bool {
    let same_site = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|o| o == state.cfg.public_base_url);
    same_site && csrf == user.csrf()
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        "This form expired. Reload the page and try again.",
    )
        .into_response()
}

fn fmt_time(t: DateTime<Utc>, tz: chrono_tz::Tz) -> String {
    // Zone abbreviation (EST/EDT) follows daylight saving.
    t.with_timezone(&tz)
        .format("%a %d %b, %H:%M %Z")
        .to_string()
}

#[cfg(test)]
mod tz_tests {
    #[test]
    fn eastern_time_follows_daylight_saving() {
        use chrono::TimeZone;
        let summer = chrono::Utc.with_ymd_and_hms(2026, 7, 1, 16, 0, 0).unwrap();
        let winter = chrono::Utc.with_ymd_and_hms(2026, 12, 1, 16, 0, 0).unwrap();
        let ny = chrono_tz::America::New_York;
        assert_eq!(super::fmt_time(summer, ny), "Wed 01 Jul, 12:00 EDT");
        assert_eq!(super::fmt_time(winter, ny), "Tue 01 Dec, 11:00 EST");
    }
}

#[derive(Deserialize)]
struct Candidate {
    client_id: String,
    name: String,
}

fn attendance_label(state: &str) -> (&'static str, &'static str) {
    match state {
        "scheduled" | "preparing" | "ready" => ("Notetaker will join", "ok"),
        "claimed" | "joining" => ("Joining", "busy"),
        "waiting" => ("Waiting to be admitted", "busy"),
        "recording" => ("Recording", "live"),
        "completed" => ("Sent to Calari", "ok"),
        "needs_review" => ("Calari did not authorize", "bad"),
        "failed" => ("Could not attend", "bad"),
        _ => ("Not joining", "busy"),
    }
}

/// GET /calendar
pub async fn page(State(state): State<AppState>, user: WebUser) -> Response {
    let Some(cal) = state.cfg.calendar.as_ref() else {
        return not_enabled();
    };
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    let conn = match Connection::for_user(&state, &user.tenant_id, &user.user_id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "loading calendar connection failed");
            return ApiError::internal().into_response();
        }
    };
    let meta = match &conn {
        Some(c) => {
            sqlx::query("SELECT last_synced_at, last_error FROM calendar_connections WHERE id = $1")
                .bind(c.id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
        }
        None => None,
    };
    let now = Utc::now();
    let rows = match &conn {
        Some(c) if c.status == "active" => sqlx::query(
            "SELECT e.event_id, e.title, e.status, e.starts_at, e.ends_at, e.self_declined, e.self_accepted, e.choice, e.choice_client_id,
                    e.candidates, e.attendee_emails, a.state AS attendance_state, a.routing AS att_routing,
                    a.client_id AS att_client, a.owner_connection_id, a.failure
             FROM calendar_events e LEFT JOIN calendar_attendances a ON a.id = e.attendance_id
             WHERE e.connection_id = $1 AND e.meet_code IS NOT NULL AND e.ends_at > $2 AND e.starts_at < $3
             ORDER BY e.starts_at LIMIT 100",
        )
        .bind(c.id)
        .bind(now)
        .bind(now + Duration::from_std(cal.horizon).unwrap_or(Duration::days(14)))
        .fetch_all(&state.db)
        .await
        .unwrap_or_default(),
        _ => Vec::new(),
    };
    let csrf = user.csrf();
    let body = html! {
        div.top {
            div {
                h1 { "Calendar" }
                p.muted { "Connect your Google Calendar once. The notetaker joins your Google Meet meetings as “" (cal.bot_display_name) "”, the host admits it, and the notes reach the right client in Calari." }
            }
        }
        div.card.stack {
            @match &conn {
                Some(c) if c.status == "active" => {
                    h2 { "Connected" }
                    p { "Google account: " strong { (c.account_email) } }
                    @if let Some(m) = &meta {
                        @if let Some(t) = m.get::<Option<DateTime<Utc>>, _>("last_synced_at") {
                            p.muted.small { "Last checked " (fmt_time(t, cal.display_tz)) }
                        }
                        @if let Some(err) = m.get::<Option<String>, _>("last_error") {
                            p.error.small { "Last check failed: " (err) }
                        }
                    }
                    form.inline method="post" action="/calendar/settings" {
                        input type="hidden" name="csrf" value=(csrf);
                        input type="hidden" name="auto_join" value=(if c.auto_join { "off" } else { "on" });
                        @if c.auto_join {
                            p { "Automatic joining is " strong { "on" } "." }
                            button.secondary type="submit" { "Pause automatic joining" }
                        } @else {
                            p { "Automatic joining is " strong { "paused" } "." }
                            button.primary type="submit" { "Resume automatic joining" }
                        }
                    }
                    form.inline method="post" action="/calendar/disconnect" {
                        input type="hidden" name="csrf" value=(csrf);
                        button.danger type="submit" { "Disconnect Google Calendar" }
                    }
                }
                Some(c) => {
                    h2 { @if c.status == "revoked" { "Disconnected" } @else { "Needs reconnecting" } }
                    @if let Some(m) = &meta {
                        @if let Some(err) = m.get::<Option<String>, _>("last_error") { p.muted { (err) } }
                    }
                    form method="post" action="/calendar/connect" {
                        input type="hidden" name="csrf" value=(csrf);
                        button.primary type="submit" { "Connect Google Calendar" }
                    }
                }
                None => {
                    h2 { "Not connected" }
                    p.muted { "Cap asks Google for read-only access to your calendar events. It never changes your calendar or your Drive connection." }
                    form method="post" action="/calendar/connect" {
                        input type="hidden" name="csrf" value=(csrf);
                        button.primary type="submit" { "Connect Google Calendar" }
                    }
                }
            }
        }
        @if conn.as_ref().is_some_and(|c| c.status == "active") {
            h2.section { "Upcoming Google Meet meetings" }
            @if rows.is_empty() {
                div.empty { p.muted { "No Google Meet meetings in the next days." } }
            } @else {
                ul.list {
                    @for r in &rows {
                        @let event_id: String = r.get("event_id");
                        @let choice: String = r.get("choice");
                        @let choice_client: Option<Uuid> = r.get("choice_client_id");
                        @let candidates: Vec<Candidate> = serde_json::from_value(r.get("candidates")).unwrap_or_default();
                        @let attendees: Vec<String> = serde_json::from_value(r.get("attendee_emails")).unwrap_or_default();
                        // What will actually happen: the attendance's own routing when
                        // there is one (a shared meeting follows its owning calendar).
                        @let routing = match r.get::<Option<String>, _>("att_routing").as_deref() {
                            Some("client") => r.get::<Option<Uuid>, _>("att_client").map(schedule::Routing::Client),
                            Some("internal") => Some(schedule::Routing::Internal),
                            _ => schedule::routing_for(&choice, choice_client, &r.get("candidates"), &attendees),
                        };
                        @let shared = r.get::<Option<Uuid>, _>("owner_connection_id").is_some_and(|o| conn.as_ref().is_some_and(|c| c.id != o));
                        @let (label, tone) = match r.get::<Option<String>, _>("attendance_state") {
                            Some(st) => attendance_label(&st),
                            None if r.get::<String, _>("status") == "cancelled" => ("Cancelled", "busy"),
                            None if r.get::<bool, _>("self_declined") => ("You declined", "busy"),
                            None if !r.get::<bool, _>("self_accepted") => ("Accept the invite to record", "busy"),
                            None if choice == "skip" => ("Skipped", "busy"),
                            None if routing.is_none() => ("Choose a client", "bad"),
                            None if !conn.as_ref().is_some_and(|c| c.auto_join) => ("Paused", "busy"),
                            None => ("Not joining", "busy"),
                        };
                        li.cal-row {
                            div {
                                div.title { (r.get::<String, _>("title")) }
                                div.meta {
                                    @if let Some(t) = r.get::<Option<DateTime<Utc>>, _>("starts_at") { span { (fmt_time(t, cal.display_tz)) } }
                                    span { @match &routing {
                                        Some(schedule::Routing::Internal) => "Internal (no client)",
                                        Some(schedule::Routing::Client(id)) => (candidates.iter().find(|c| c.client_id == id.to_string()).map(|c| c.name.as_str()).unwrap_or("Client")),
                                        None => "Client not decided",
                                    } }
                                }
                                @if shared { div.muted.small { "Recorded through another staff member's calendar, with their client choice." } }
                                @if let Some(f) = r.get::<Option<String>, _>("failure") { div.muted.small { (f) } }
                            }
                            form.choice method="post" action="/calendar/choice" {
                                input type="hidden" name="csrf" value=(csrf);
                                input type="hidden" name="event_id" value=(event_id);
                                label.visually-hidden for=(format!("c-{}", sha256_hex(event_id.as_bytes()))) { "Who is this meeting for" }
                                select id=(format!("c-{}", sha256_hex(event_id.as_bytes()))) name="choice" {
                                    option value="auto" selected[choice == "auto"] { "Automatic (verified attendees)" }
                                    @for c in &candidates {
                                        @let v = format!("client:{}", c.client_id);
                                        option value=(v) selected[choice == "client" && choice_client.map(|x| x.to_string()) == Some(c.client_id.clone())] { (c.name) }
                                    }
                                    option value="internal" selected[choice == "internal"] { "Internal (no client)" }
                                    option value="skip" selected[choice == "skip"] { "Don't join" }
                                }
                                button.secondary type="submit" { "Save" }
                            }
                            span class=(format!("badge {tone}")) { (label) }
                        }
                    }
                }
            }
        }
    };
    pages::layout("Calendar", Some(&user), body).into_response()
}

#[derive(Deserialize)]
pub struct CsrfOnly {
    #[serde(default)]
    csrf: String,
}

/// POST /calendar/connect → Google consent (read-only calendar, offline).
pub async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Form(f): Form<CsrfOnly>,
) -> Response {
    let Some(cal) = state.cfg.calendar.as_ref() else {
        return not_enabled();
    };
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    if !form_ok(&state, &headers, &user, &f.csrf) {
        return forbidden();
    }
    if super::calari::integration(&state, &user.tenant_id).is_none() {
        return page_error(
            &user,
            StatusCode::SERVICE_UNAVAILABLE,
            "Calendar is not set up",
            "This Calari workspace is not connected for calendar attendance yet.",
        );
    }
    let oauth_state = random_token(43);
    let verifier = random_token(64);
    let browser = random_token(43);
    let saved = sqlx::query(
        "INSERT INTO calendar_oauth_attempts (state_hash, session_hash, browser_hash, tenant_id, calari_user_id, code_verifier, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(sha256_hex(oauth_state.as_bytes()))
    .bind(&user.session_hash)
    .bind(sha256_hex(browser.as_bytes()))
    .bind(&user.tenant_id)
    .bind(&user.user_id)
    .bind(&verifier)
    .bind(Utc::now() + Duration::minutes(ATTEMPT_MINUTES))
    .execute(&state.db)
    .await;
    if let Err(e) = saved {
        return ApiError::from(e).into_response();
    }
    let Ok(mut url) = reqwest::Url::parse(&cal.google.auth_url) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    url.query_pairs_mut()
        .append_pair("client_id", &cal.google_client_id)
        .append_pair("redirect_uri", &callback_url(&state))
        .append_pair("response_type", "code")
        .append_pair("scope", google::SCOPES)
        .append_pair("access_type", "offline")
        // Always show consent so Google returns an offline refresh token, and
        // keep this grant separate from any existing Drive grant.
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "false")
        .append_pair("login_hint", &user.email)
        .append_pair("state", &oauth_state)
        .append_pair("code_challenge", &pkce_s256(&verifier))
        .append_pair("code_challenge_method", "S256");
    (
        StatusCode::SEE_OTHER,
        AppendHeaders([
            (
                header::SET_COOKIE,
                browser_cookie(state.cfg.production, &browser, ATTEMPT_MINUTES * 60),
            ),
            (header::LOCATION, url.to_string()),
        ]),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct Callback {
    #[serde(default)]
    code: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    error: String,
}

/// GET /calendar/google/callback
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Query(q): Query<Callback>,
) -> Response {
    let Some(cal) = state.cfg.calendar.as_ref() else {
        return not_enabled();
    };
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    let fail = |text: &str| {
        page_error(
            &user,
            StatusCode::BAD_REQUEST,
            "Calendar was not connected",
            text,
        )
    };
    if !q.error.is_empty() {
        return fail("Google did not grant access. Nothing was connected.");
    }
    if q.code.is_empty() || q.code.len() > 1024 || q.state.is_empty() || q.state.len() > 256 {
        return fail("The response from Google was incomplete. Try again.");
    }
    let Some(browser) =
        crate::web::auth::cookie_value_pub(&headers, browser_cookie_name(state.cfg.production))
    else {
        return fail("This connection was started in a different browser. Start again from the calendar page.");
    };
    // Single use, and only for the same Cap session, staff member and browser.
    let attempt = sqlx::query(
        "DELETE FROM calendar_oauth_attempts
         WHERE state_hash = $1 AND browser_hash = $2 AND session_hash = $3 AND tenant_id = $4 AND calari_user_id = $5
           AND expires_at > now()
         RETURNING code_verifier",
    )
    .bind(sha256_hex(q.state.as_bytes()))
    .bind(sha256_hex(browser.as_bytes()))
    .bind(&user.session_hash)
    .bind(&user.tenant_id)
    .bind(&user.user_id)
    .fetch_optional(&state.db)
    .await;
    let verifier: String =
        match attempt {
            Ok(Some(r)) => r.get("code_verifier"),
            Ok(None) => return fail(
                "That link expired, was already used, or belongs to another sign-in. Start again.",
            ),
            Err(e) => return ApiError::from(e).into_response(),
        };
    let tokens =
        match google::exchange_code(&state.http, cal, &q.code, &verifier, &callback_url(&state))
            .await
        {
            Ok(t) => t,
            Err(_) => return fail("Google did not accept the connection. Try again."),
        };
    let Some(refresh) = tokens.refresh_token.as_deref().filter(|t| !t.is_empty()) else {
        return fail("Google did not grant offline access. Try again and approve access.");
    };
    if !tokens
        .scope
        .split_whitespace()
        .any(|s| s == google::CALENDAR_SCOPE)
    {
        google::revoke(&state.http, cal, refresh).await;
        return fail(
            "Calendar access was not granted. Tick the calendar permission and try again.",
        );
    }
    let info =
        match google::user_info(&state.http, &cal.google.api_base, &tokens.access_token).await {
            Ok(i) if i.email_verified => i,
            _ => {
                google::revoke(&state.http, cal, refresh).await;
                return fail("Google did not confirm the account's email address.");
            }
        };
    let email = info.email.trim().to_lowercase();
    if cal.require_same_email && email != user.email {
        google::revoke(&state.http, cal, refresh).await;
        return fail("Connect the Google account that uses your Calari email address.");
    }
    match store_connection(&state, &user, &email, refresh, &tokens.scope).await {
        Ok(_) => {}
        Err(e) => {
            tracing::error!(error = %e, "saving calendar connection failed");
            return ApiError::internal().into_response();
        }
    }
    (
        StatusCode::SEE_OTHER,
        AppendHeaders([
            (
                header::SET_COOKIE,
                browser_cookie(state.cfg.production, "", 0),
            ),
            (header::LOCATION, "/calendar".to_owned()),
        ]),
    )
        .into_response()
}

async fn store_connection(
    state: &AppState,
    user: &WebUser,
    email: &str,
    refresh: &str,
    scopes: &str,
) -> anyhow::Result<Uuid> {
    let cal = state
        .cfg
        .calendar
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("calendar off"))?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))")
        .bind(format!(
            "cap.calendar.conn|{}|{}",
            user.tenant_id, user.user_id
        ))
        .execute(&mut *tx)
        .await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM calendar_connections WHERE tenant_id = $1 AND calari_user_id = $2 AND provider = 'google' FOR UPDATE",
    )
    .bind(&user.tenant_id)
    .bind(&user.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let id = existing.unwrap_or_else(Uuid::new_v4);
    let sealed = crypto::seal(
        &cal.encryption_key.0,
        &cal.encryption_key_id,
        PURPOSE_REFRESH,
        &id.to_string(),
        refresh.as_bytes(),
    )?;
    sqlx::query(
        "INSERT INTO calendar_connections (id, tenant_id, calari_user_id, provider, account_email, refresh_ciphertext, key_id, scopes, status, next_sync_at)
         VALUES ($1, $2, $3, 'google', $4, $5, $6, $7, 'active', now())
         ON CONFLICT (id) DO UPDATE SET account_email = $4, refresh_ciphertext = $5, key_id = $6, scopes = $7,
           status = 'active', sync_token = NULL, page_token = NULL, sync_run_token = NULL, next_sync_at = now(),
           sync_attempts = 0, last_error = NULL, updated_at = now()",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .bind(&user.user_id)
    .bind(email)
    .bind(&sealed)
    .bind(&cal.encryption_key_id)
    .bind(scopes.chars().take(500).collect::<String>())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(connection = %id, "calendar connected");
    Ok(id)
}

async fn own_connection(state: &AppState, user: &WebUser) -> Option<Connection> {
    Connection::for_user(state, &user.tenant_id, &user.user_id)
        .await
        .ok()
        .flatten()
}

/// POST /calendar/disconnect
pub async fn disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Form(f): Form<CsrfOnly>,
) -> Response {
    if state.cfg.calendar.is_none() {
        return not_enabled();
    }
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    if !form_ok(&state, &headers, &user, &f.csrf) {
        return forbidden();
    }
    if let Some(c) = own_connection(&state, &user).await {
        if let Err(e) =
            super::revoke_connection(&state, c.id, "disconnected by the staff member").await
        {
            tracing::error!(error = %e, "disconnecting calendar failed");
            return ApiError::internal().into_response();
        }
    }
    Redirect::to("/calendar").into_response()
}

#[derive(Deserialize)]
pub struct SettingsForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    auto_join: String,
}

/// POST /calendar/settings
pub async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Form(f): Form<SettingsForm>,
) -> Response {
    if state.cfg.calendar.is_none() {
        return not_enabled();
    }
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    if !form_ok(&state, &headers, &user, &f.csrf) {
        return forbidden();
    }
    let Some(c) = own_connection(&state, &user)
        .await
        .filter(|c| c.status == "active")
    else {
        return Redirect::to("/calendar").into_response();
    };
    let on = match f.auto_join.as_str() {
        "on" => true,
        "off" => false,
        _ => return (StatusCode::BAD_REQUEST, "invalid setting").into_response(),
    };
    let r = sqlx::query(
        "UPDATE calendar_connections SET auto_join = $2, updated_at = now() WHERE id = $1",
    )
    .bind(c.id)
    .bind(on)
    .execute(&state.db)
    .await;
    if let Err(e) = r {
        return ApiError::from(e).into_response();
    }
    if let Err(e) = schedule::reconcile_connection(&state, c.id, Utc::now()).await {
        tracing::error!(error = %e, "reconciling after settings change failed");
    }
    Redirect::to("/calendar").into_response()
}

#[derive(Deserialize)]
pub struct ChoiceForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    event_id: String,
    #[serde(default)]
    choice: String,
}

/// POST /calendar/choice
pub async fn choice(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Form(f): Form<ChoiceForm>,
) -> Response {
    if state.cfg.calendar.is_none() {
        return not_enabled();
    }
    if let Some(denied) = role_denied(&state, &user) {
        return denied;
    }
    if !form_ok(&state, &headers, &user, &f.csrf) {
        return forbidden();
    }
    let Some(c) = own_connection(&state, &user)
        .await
        .filter(|c| c.status == "active")
    else {
        return Redirect::to("/calendar").into_response();
    };
    // Only this staff member's own event.
    let candidates: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT candidates FROM calendar_events WHERE connection_id = $1 AND event_id = $2",
    )
    .bind(c.id)
    .bind(&f.event_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some(candidates) = candidates else {
        return (StatusCode::NOT_FOUND, "Meeting not found").into_response();
    };
    let (choice, client): (&str, Option<Uuid>) = match f.choice.as_str() {
        "auto" => ("auto", None),
        "internal" => ("internal", None),
        "skip" => ("skip", None),
        other => match other
            .strip_prefix("client:")
            .and_then(cap_meeting_protocol::ids::parse_uuid)
        {
            // A client Calari mapped for this meeting's attendees only;
            // Calari re-checks access when the pairing is requested.
            Some(id)
                if serde_json::from_value::<Vec<Candidate>>(candidates)
                    .unwrap_or_default()
                    .iter()
                    .any(|c| c.client_id == id.to_string()) =>
            {
                ("client", Some(id))
            }
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "That client is not available for this meeting",
                )
                    .into_response()
            }
        },
    };
    let r = sqlx::query(
        "UPDATE calendar_events SET choice = $3, choice_client_id = $4, updated_at = now() WHERE connection_id = $1 AND event_id = $2",
    )
    .bind(c.id)
    .bind(&f.event_id)
    .bind(choice)
    .bind(client)
    .execute(&state.db)
    .await;
    if let Err(e) = r {
        return ApiError::from(e).into_response();
    }
    if let Err(e) = schedule::reconcile_event(&state, c.id, &f.event_id, Utc::now()).await {
        tracing::error!(error = %e, "reconciling after choice failed");
    }
    Redirect::to("/calendar").into_response()
}
