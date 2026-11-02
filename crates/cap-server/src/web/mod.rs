//! Internal meetings library, signed in through Calari.

pub mod auth;
pub mod pages;

use crate::AppState;
use axum::{
    http::{header, HeaderValue},
    routing::{get, post},
    Router,
};
use tower_http::set_header::SetResponseHeaderLayer;

/// Every staff page. A page may send its own, narrower variant (see
/// [`csp_with_form_action`]); otherwise this one applies.
pub const BASE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
               media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/// The base policy with one more exact origin allowed as a form target
/// (Chromium applies form-action to the redirects after a form submission).
pub fn csp_with_form_action(origin: &str) -> String {
    BASE_CSP.replace(
        "form-action 'self'",
        &format!("form-action 'self' {origin}"),
    )
}

pub fn router() -> Router<AppState> {
    let csp = BASE_CSP;
    Router::new()
        .route("/login", get(auth::start))
        .route("/login/signed-out", get(pages::signed_out))
        .route("/auth/calari/callback", get(auth::callback))
        .route("/logout", post(auth::logout))
        .route("/meetings", get(pages::meetings))
        .route("/calendar", get(crate::attendance::web::page))
        .route("/calendar/connect", post(crate::attendance::web::connect))
        .route(
            "/calendar/google/callback",
            get(crate::attendance::web::callback),
        )
        .route(
            "/calendar/disconnect",
            post(crate::attendance::web::disconnect),
        )
        .route("/calendar/settings", post(crate::attendance::web::settings))
        .route("/calendar/choice", post(crate::attendance::web::choice))
        .route("/meetings/{id}", get(pages::meeting))
        .route("/meetings/{id}/parts/{seq}", get(pages::part))
        .route("/static/app.css", get(pages::css))
        .route("/static/app.js", get(pages::js))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(csp),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            // Not "no-referrer": with it Chromium sends `Origin: null` on
            // same-origin form posts, and every Origin check refuses them.
            // same-origin still sends nothing to other sites.
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
}
