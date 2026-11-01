//! JSON error responses. Internal details are logged, never returned.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    detail: Option<&'static str>,
    missing: Option<Vec<u32>>,
}

#[derive(Serialize)]
struct Body {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing_chunks: Option<Vec<u32>>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            detail: None,
            missing: None,
        }
    }

    pub fn bad(code: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal")
    }

    pub fn detail(mut self, detail: &'static str) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn missing(mut self, missing: Vec<u32>) -> Self {
        self.missing = Some(missing);
        self
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Body {
            error: self.code,
            detail: self.detail,
            missing_chunks: self.missing,
        };
        (self.status, Json(body)).into_response()
    }
}
