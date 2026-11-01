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

pub fn router() -> Router<AppState> {
    let csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
               media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    Router::new()
        .route("/login", get(auth::start))
        .route("/login/signed-out", get(pages::signed_out))
        .route("/auth/calari/callback", get(auth::callback))
        .route("/logout", post(auth::logout))
        .route("/meetings", get(pages::meetings))
        .route("/meetings/{id}", get(pages::meeting))
        .route("/meetings/{id}/parts/{seq}", get(pages::part))
        .route("/static/app.css", get(pages::css))
        .route("/static/app.js", get(pages::js))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(csp),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
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
