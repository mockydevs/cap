//! "Sign in with Calari" for the meetings library. Calari owns staff
//! accounts; Cap keeps no passwords, only a session recording which staff
//! member signed in. See `library-signin-contract` in the integration docs.

use crate::{config::Integration, error::ApiError, AppState};
use axum::{
    extract::{FromRequestParts, Query, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
};
use cap_meeting_protocol::{
    ids::{random_token, sha256_hex},
    pkce_s256,
    signing::{self, Purpose},
    LoginExchangeRequest, LoginExchangeResponse, LoginStatusRequest, LoginStatusResponse,
    StaffRole,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use sqlx::Row;

pub const SESSION_HOURS: i64 = 8;
pub const IDLE_MINUTES: i64 = 60;
const ATTEMPT_MINUTES: i64 = 10;

pub fn cookie_name(production: bool) -> &'static str {
    if production {
        "__Host-cap_web"
    } else {
        "cap_web"
    }
}

pub fn callback_url(state: &AppState) -> String {
    format!("{}/auth/calari/callback", state.cfg.public_base_url)
}

/// A signed-in Calari staff member.
#[derive(Clone, Debug)]
pub struct WebUser {
    pub tenant_id: String,
    pub email: String,
    pub name: String,
    pub role: StaffRole,
    pub session_hash: String,
}

impl WebUser {
    /// Token for this session's forms.
    pub fn csrf(&self) -> String {
        sha256_hex(format!("cap.csrf.v1:{}", self.session_hash).as_bytes())
    }
}

fn token_from(headers: &HeaderMap, production: bool) -> Option<String> {
    let name = cookie_name(production);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

impl FromRequestParts<AppState> for WebUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let to_login = || Redirect::to("/login").into_response();
        let token = token_from(&parts.headers, state.cfg.production).ok_or_else(to_login)?;
        let hash = sha256_hex(token.as_bytes());
        let row = sqlx::query(
            "SELECT tenant_id, calari_user_id, email, display_name, role
             FROM cap_web_sessions
             WHERE token_hash = $1 AND expires_at > now() AND last_seen_at > now() - make_interval(mins => $2)",
        )
        .bind(&hash)
        .bind(IDLE_MINUTES as i32)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| ApiError::from(e).into_response())?
        .ok_or_else(to_login)?;
        let mut user = WebUser {
            tenant_id: row.get("tenant_id"),
            email: row.get("email"),
            name: row.get("display_name"),
            role: if row.get::<String, _>("role") == "admin" {
                StaffRole::Admin
            } else {
                StaffRole::Staff
            },
            session_hash: hash.clone(),
        };
        // Every protected request asks Calari first; there is no cached allow.
        {
            let user_id: uuid::Uuid = row.get("calari_user_id");
            match check_status(state, &user.tenant_id, &user_id.to_string()).await {
                Status::Active(s) => {
                    user.email = s.email.trim().to_lowercase();
                    user.name = cap_meeting_protocol::clean_text(&s.display_name, 100)
                        .unwrap_or_else(|| user.email.clone());
                    user.role = s.role;
                    sqlx::query(
                        "UPDATE cap_web_sessions SET verified_at = now(), email = $2, display_name = $3, role = $4 WHERE token_hash = $1",
                    )
                    .bind(&hash)
                    .bind(&user.email)
                    .bind(&user.name)
                    .bind(if user.role == StaffRole::Admin { "admin" } else { "staff" })
                    .execute(&state.db)
                    .await
                    .map_err(|e| ApiError::from(e).into_response())?;
                }
                Status::Revoked => {
                    let _ = sqlx::query("DELETE FROM cap_web_sessions WHERE token_hash = $1")
                        .bind(&hash)
                        .execute(&state.db)
                        .await;
                    return Err(to_login());
                }
                // Fail closed: no access without a fresh answer from Calari.
                Status::Unknown => {
                    return Err(super::pages::message_page(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Cannot confirm your access",
                        "Cap could not check your account with Calari just now. Try again in a minute.",
                    ));
                }
            }
        }
        let _ =
            sqlx::query("UPDATE cap_web_sessions SET last_seen_at = now() WHERE token_hash = $1")
                .bind(&hash)
                .execute(&state.db)
                .await;
        Ok(user)
    }
}

enum Status {
    Active(LoginStatusResponse),
    Revoked,
    Unknown,
}

/// POSTs a body to a Calari login endpoint, signed with purpose `login`.
async fn signed_post(
    state: &AppState,
    integration: &Integration,
    url: &str,
    body: Vec<u8>,
) -> Result<reqwest::Response, ()> {
    let ts = Utc::now().timestamp();
    let nonce = signing::new_nonce();
    let sig =
        signing::sign(&integration.secret, Purpose::Login, ts, &nonce, &body).map_err(|_| ())?;
    state
        .http
        .post(url)
        .header("content-type", "application/json")
        .header(signing::HEADER_KEY_ID, &integration.key_id)
        .header(signing::HEADER_TIMESTAMP, ts.to_string())
        .header(signing::HEADER_NONCE, &nonce)
        .header(signing::HEADER_SIGNATURE, sig)
        .body(body)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e.without_url(), "Calari login endpoint unreachable"))
}

async fn check_status(state: &AppState, tenant_id: &str, user_id: &str) -> Status {
    let Some(integration) = state
        .cfg
        .integration_for_tenant(tenant_id)
        .filter(|i| i.login_status_url.is_some())
    else {
        return Status::Unknown;
    };
    let Some(url) = integration.login_status_url.as_deref() else {
        return Status::Unknown;
    };
    let Ok(body) = serde_json::to_vec(&LoginStatusRequest {
        user_id: user_id.to_owned(),
    }) else {
        return Status::Unknown;
    };
    let Ok(res) = signed_post(state, integration, url, body).await else {
        return Status::Unknown;
    };
    if !res.status().is_success() {
        tracing::warn!(
            status = res.status().as_u16(),
            "Calari status check refused"
        );
        return Status::Unknown;
    }
    match res.json::<LoginStatusResponse>().await {
        Ok(s) if s.tenant_id == tenant_id && s.user_id == user_id => {
            if s.active {
                Status::Active(s)
            } else {
                Status::Revoked
            }
        }
        Ok(_) => Status::Revoked,
        Err(_) => Status::Unknown,
    }
}

fn login_integration(state: &AppState) -> Option<&Integration> {
    state.cfg.login_integration()
}

/// GET /login: send the browser to Calari's staff sign-in.
pub async fn start(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(t) = token_from(&headers, state.cfg.production) {
        let live: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM cap_web_sessions WHERE token_hash = $1 AND expires_at > now()",
        )
        .bind(sha256_hex(t.as_bytes()))
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
        if live.is_some() {
            return Redirect::to("/meetings").into_response();
        }
    }
    let Some(integration) = login_integration(&state) else {
        return super::pages::message_page(
            StatusCode::SERVICE_UNAVAILABLE,
            "Sign-in is not set up",
            "Calari sign-in has not been configured on this Cap server yet.",
        );
    };
    let Some(authorize) = integration.login_authorize_url.as_deref() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let login_state = random_token(43);
    let verifier = random_token(64);
    let stored = sqlx::query(
        "INSERT INTO cap_login_attempts (state_hash, code_verifier, key_id, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(sha256_hex(login_state.as_bytes()))
    .bind(&verifier)
    .bind(&integration.key_id)
    .bind(Utc::now() + Duration::minutes(ATTEMPT_MINUTES))
    .execute(&state.db)
    .await;
    if let Err(e) = stored {
        return ApiError::from(e).into_response();
    }
    let _ = sqlx::query("DELETE FROM cap_login_attempts WHERE expires_at < now()")
        .execute(&state.db)
        .await;
    let mut url = match reqwest::Url::parse(authorize) {
        Ok(u) => u,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    url.query_pairs_mut()
        .append_pair("redirect_uri", &callback_url(&state))
        .append_pair("state", &login_state)
        .append_pair("code_challenge", &pkce_s256(&verifier))
        .append_pair("code_challenge_method", "S256");
    Redirect::to(url.as_str()).into_response()
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

fn failed(why: &str) -> Response {
    super::pages::message_page(StatusCode::UNAUTHORIZED, "Sign-in failed", why)
}

/// GET /auth/calari/callback: exchange Calari's one-time code (signed,
/// server to server) for the staff member, then start a Cap session.
pub async fn callback(State(state): State<AppState>, Query(q): Query<Callback>) -> Response {
    if !q.error.is_empty() {
        return failed("Calari did not complete the sign-in. Try again from the sign-in page.");
    }
    if q.code.is_empty() || q.code.len() > 512 || q.state.is_empty() || q.state.len() > 256 {
        return failed("The sign-in response was incomplete. Try again.");
    }
    // Single use: the attempt is deleted as it is read.
    let attempt = match sqlx::query(
        "DELETE FROM cap_login_attempts WHERE state_hash = $1 AND expires_at > now() RETURNING code_verifier, key_id",
    )
    .bind(sha256_hex(q.state.as_bytes()))
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(a)) => a,
        Ok(None) => return failed("That sign-in link expired or was already used. Start again."),
        Err(e) => return ApiError::from(e).into_response(),
    };
    let key_id: String = attempt.get("key_id");
    let Some(integration) = state.cfg.integration(&key_id) else {
        return failed("Sign-in is no longer configured.");
    };
    let Some(exchange_url) = integration.login_exchange_url.as_deref() else {
        return failed("Sign-in is no longer configured.");
    };
    let body = match serde_json::to_vec(&LoginExchangeRequest {
        code: q.code.clone(),
        code_verifier: attempt.get("code_verifier"),
        redirect_uri: callback_url(&state),
    }) {
        Ok(b) => b,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let res = signed_post(&state, integration, exchange_url, body).await;
    let staff: LoginExchangeResponse = match res {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(s) => s,
            Err(_) => return failed("Calari sent an unreadable sign-in answer."),
        },
        Ok(r) => {
            tracing::info!(
                status = r.status().as_u16(),
                "Calari refused a library sign-in"
            );
            return failed("Calari did not accept this sign-in. Only Calari staff can use Cap.");
        }
        Err(()) => {
            return failed("Could not reach Calari to finish signing in. Try again shortly.")
        }
    };
    if staff.tenant_id != integration.tenant_id
        || cap_meeting_protocol::ids::parse_uuid(&staff.user_id).is_none()
    {
        return failed("That account does not belong to this Cap workspace.");
    }
    let email = staff.email.trim().to_lowercase();
    let name =
        cap_meeting_protocol::clean_text(&staff.display_name, 100).unwrap_or_else(|| email.clone());
    // 43 URL-safe characters ≈ 258 random bits.
    let token = random_token(43);
    let saved = sqlx::query(
        "INSERT INTO cap_web_sessions (token_hash, tenant_id, calari_user_id, email, display_name, role, expires_at, verified_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, now())",
    )
    .bind(sha256_hex(token.as_bytes()))
    .bind(&staff.tenant_id)
    .bind(&staff.user_id)
    .bind(&email)
    .bind(&name)
    .bind(if staff.role == StaffRole::Admin { "admin" } else { "staff" })
    .bind(Utc::now() + Duration::hours(SESSION_HOURS))
    .execute(&state.db)
    .await;
    if let Err(e) = saved {
        return ApiError::from(e).into_response();
    }
    let _ = sqlx::query("DELETE FROM cap_web_sessions WHERE expires_at < now()")
        .execute(&state.db)
        .await;
    let cookie = format!(
        "{}={token}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax{}",
        cookie_name(state.cfg.production),
        SESSION_HOURS * 3600,
        if state.cfg.production { "; Secure" } else { "" }
    );
    (
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, cookie),
            (header::LOCATION, "/meetings".to_owned()),
        ],
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct CsrfForm {
    #[serde(default)]
    csrf: String,
}

/// POST /logout
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    axum::Form(f): axum::Form<CsrfForm>,
) -> Response {
    let same_site = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|o| o == state.cfg.public_base_url);
    if !same_site || f.csrf != user.csrf() {
        return (
            StatusCode::FORBIDDEN,
            "This form expired. Reload the page and try again.",
        )
            .into_response();
    }
    let _ = sqlx::query("DELETE FROM cap_web_sessions WHERE token_hash = $1")
        .bind(&user.session_hash)
        .execute(&state.db)
        .await;
    let cookie = format!(
        "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{}",
        cookie_name(state.cfg.production),
        if state.cfg.production { "; Secure" } else { "" }
    );
    (
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, cookie),
            (header::LOCATION, "/login/signed-out".to_owned()),
        ],
    )
        .into_response()
}
