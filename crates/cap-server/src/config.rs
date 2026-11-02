//! Environment configuration. In production every required value must be
//! present and safe, or the server refuses to start.
//!
//! Database and storage reuse the variable names the TypeScript services
//! already use in production (`DATABASE_URL`, `AWS_*`), because the Rust
//! server shares that database and bucket.

use anyhow::{bail, Context, Result};
use cap_meeting_protocol::signing::decode_secret;
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct Integration {
    pub key_id: String,
    pub tenant_id: String,
    pub secret: Vec<u8>,
    pub delivery_url: String,
    /// Calari's staff sign-in page for the meetings library.
    pub login_authorize_url: Option<String>,
    /// Calari endpoint that exchanges a one-time sign-in code (signed, purpose `login`).
    pub login_exchange_url: Option<String>,
    /// Calari endpoint that confirms a staff member is still active.
    pub login_status_url: Option<String>,
    /// Calari endpoint resolving calendar attendees to clients (purpose `calendar`).
    pub calendar_resolve_url: Option<String>,
    /// Calari endpoint creating a pairing for a calendar attendance.
    pub calendar_pairing_url: Option<String>,
}

impl std::fmt::Debug for Integration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Integration")
            .field("key_id", &self.key_id)
            .field("tenant_id", &self.tenant_id)
            .field("secret", &"<redacted>")
            .field("delivery_url", &self.delivery_url)
            .field("login_authorize_url", &self.login_authorize_url)
            .field("login_exchange_url", &self.login_exchange_url)
            .field("login_status_url", &self.login_status_url)
            .field("calendar_resolve_url", &self.calendar_resolve_url)
            .field("calendar_pairing_url", &self.calendar_pairing_url)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub enum TranscriptionConfig {
    /// Whisper running inside this process (feature `local-whisper`).
    LocalWhisper {
        model_path: PathBuf,
        threads: u16,
        language: Option<String>,
    },
    /// `POST {base_url}/audio/transcriptions` on an OpenAI-compatible server
    /// (OpenAI itself, or a self-hosted Whisper server).
    OpenAiCompatible {
        base_url: String,
        api_key: Option<Secret>,
        model: String,
    },
    /// Clearly labelled placeholder text, for development and tests only.
    TestFixture,
    Disabled,
}

#[derive(Clone)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Clone, Debug)]
pub enum StorageConfig {
    S3 {
        bucket: String,
        region: String,
        endpoint: Option<String>,
        kms_key_arn: Option<String>,
    },
    /// Local directory, development only.
    Filesystem { root: PathBuf },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: Secret,
    pub storage: StorageConfig,
    pub public_base_url: String,
    pub production: bool,
    /// Number of trusted reverse proxies in front of the server (matches the
    /// TS app's `TRUSTED_PROXY_HOP_COUNT`). 0 = use the socket address.
    pub trusted_proxy_hops: usize,
    pub integrations: Vec<Integration>,
    pub transcription: TranscriptionConfig,
    /// A meeting still `recording` with no upload for this long is finalized
    /// as `interrupted` with whatever audio arrived.
    pub abandon_after: Duration,
    pub worker_interval: Duration,
    /// Dedicated publisher-owned directory, mounted read-only; optional until installers ship.
    pub download_dir: Option<PathBuf>,
    /// Universal Calari portal, separate from the privileged meetings-library SSO.
    pub portal_url: Option<String>,
    pub ffmpeg_path: String,
    /// Calendar attendance; `None` keeps the feature off entirely.
    pub calendar: Option<CalendarConfig>,
}

/// Google endpoints. Overridable only outside production (test stubs).
#[derive(Clone, Debug)]
pub struct GoogleEndpoints {
    pub auth_url: String,
    pub token_url: String,
    pub revoke_url: String,
    pub api_base: String,
}

impl Default for GoogleEndpoints {
    fn default() -> Self {
        Self {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            revoke_url: "https://oauth2.googleapis.com/revoke".into(),
            api_base: "https://www.googleapis.com".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CalendarConfig {
    pub google_client_id: String,
    pub google_client_secret: Secret,
    pub google: GoogleEndpoints,
    /// AEAD key for refresh tokens and bot device tokens at rest (32 bytes).
    pub encryption_key: Secret32,
    pub encryption_key_id: String,
    /// sha256 hex of the bearer token the isolated bot runner presents.
    pub bot_token_sha256: String,
    /// Most attendances in progress at once on this server.
    pub max_concurrent: u32,
    /// How long before the start the bot is prepared and may join.
    pub join_lead: Duration,
    pub sync_interval: Duration,
    /// How far ahead events are considered.
    pub horizon: Duration,
    /// Display name the bot uses in the meeting (shown to participants).
    pub bot_display_name: String,
    /// The Google account must have the staff member's Calari email.
    pub require_same_email: bool,
    /// Zone for times shown to staff (instants are always stored in UTC).
    pub display_tz: chrono_tz::Tz,
    /// Calari staff (not only admins) may connect calendars. Off until the
    /// meetings library enforces per-staff ownership.
    pub allow_staff: bool,
}

/// A 32-byte key that never prints.
#[derive(Clone)]
pub struct Secret32(pub [u8; 32]);

impl std::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIntegration {
    key_id: String,
    tenant_id: String,
    /// base64url without padding, exactly 32 decoded bytes.
    secret: String,
    delivery_url: String,
    #[serde(default)]
    login_authorize_url: Option<String>,
    #[serde(default)]
    login_exchange_url: Option<String>,
    #[serde(default)]
    login_status_url: Option<String>,
    #[serde(default)]
    calendar_resolve_url: Option<String>,
    #[serde(default)]
    calendar_pairing_url: Option<String>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn parse_var<T: std::str::FromStr>(name: &str, default: T) -> Result<T> {
    match var(name) {
        Some(v) => v
            .parse()
            .map_err(|_| anyhow::anyhow!("{name} is not valid")),
        None => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let production = matches!(
            var("CAP_ENV").or_else(|| var("NODE_ENV")).as_deref(),
            Some("production")
        );
        let raw_integrations = match (
            var("CAP_MEETING_INTEGRATIONS"),
            var("CAP_MEETING_INTEGRATIONS_FILE"),
        ) {
            (Some(json), _) => json,
            (None, Some(path)) => std::fs::read_to_string(&path)
                .with_context(|| format!("reading CAP_MEETING_INTEGRATIONS_FILE {path}"))?,
            (None, None) => "[]".into(),
        };
        let raw: Vec<RawIntegration> = serde_json::from_str(&raw_integrations).context(
            "CAP_MEETING_INTEGRATIONS must be a JSON array of {key_id, tenant_id, secret, delivery_url}",
        )?;
        let mut integrations = Vec::new();
        for r in raw {
            let secret = decode_secret(&r.secret).map_err(|_| {
                anyhow::anyhow!(
                    "integration {} secret must be base64url without padding, exactly 32 bytes",
                    r.key_id
                )
            })?;
            integrations.push(Integration {
                key_id: r.key_id,
                tenant_id: r.tenant_id,
                secret,
                delivery_url: r.delivery_url,
                login_authorize_url: r.login_authorize_url,
                login_exchange_url: r.login_exchange_url,
                login_status_url: r.login_status_url,
                calendar_resolve_url: r.calendar_resolve_url,
                calendar_pairing_url: r.calendar_pairing_url,
            });
        }

        let transcription = match var("MEETING_TRANSCRIPTION_PROVIDER").as_deref() {
            Some("local-whisper") => TranscriptionConfig::LocalWhisper {
                model_path: var("MEETING_WHISPER_MODEL_PATH")
                    .context("MEETING_TRANSCRIPTION_PROVIDER=local-whisper needs MEETING_WHISPER_MODEL_PATH")?
                    .into(),
                threads: parse_var("MEETING_WHISPER_THREADS", 4)?,
                language: var("MEETING_WHISPER_LANGUAGE"),
            },
            Some("openai-compatible") => TranscriptionConfig::OpenAiCompatible {
                base_url: var("MEETING_TRANSCRIPTION_BASE_URL")
                    .context("openai-compatible transcription needs MEETING_TRANSCRIPTION_BASE_URL")?,
                api_key: var("MEETING_TRANSCRIPTION_API_KEY").map(Secret),
                model: var("MEETING_TRANSCRIPTION_MODEL").unwrap_or_else(|| "whisper-1".into()),
            },
            Some("test-fixture") => TranscriptionConfig::TestFixture,
            Some("disabled") | None => TranscriptionConfig::Disabled,
            Some(other) => bail!("unknown MEETING_TRANSCRIPTION_PROVIDER {other:?}"),
        };

        let storage = match var("AWS_S3_BUCKET_NAME") {
            Some(bucket) => StorageConfig::S3 {
                bucket,
                region: var("AWS_REGION").context("AWS_S3_BUCKET_NAME needs AWS_REGION")?,
                endpoint: var("AWS_S3_ENDPOINT"),
                kms_key_arn: var("AWS_KMS_KEY_ARN"),
            },
            None => StorageConfig::Filesystem {
                root: var("CAP_LOCAL_STORAGE_DIR")
                    .unwrap_or_else(|| "data/cap-server/objects".into())
                    .into(),
            },
        };

        let calendar = if matches!(var("CAP_CALENDAR_ENABLED").as_deref(), Some("1" | "true")) {
            let key = decode_secret(
                &var("CAP_CALENDAR_ENCRYPTION_KEY")
                    .context("CAP_CALENDAR_ENABLED needs CAP_CALENDAR_ENCRYPTION_KEY")?,
            )
            .ok()
            .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
            .context(
                "CAP_CALENDAR_ENCRYPTION_KEY must be base64url without padding, exactly 32 bytes",
            )?;
            let bot_token = var("CAP_CALENDAR_BOT_TOKEN")
                .context("CAP_CALENDAR_ENABLED needs CAP_CALENDAR_BOT_TOKEN")?;
            if bot_token.len() < 32 {
                bail!("CAP_CALENDAR_BOT_TOKEN must be at least 32 random characters");
            }
            let mut google = GoogleEndpoints::default();
            if let Some(v) = var("CAP_CALENDAR_GOOGLE_AUTH_URL") {
                google.auth_url = v;
            }
            if let Some(v) = var("CAP_CALENDAR_GOOGLE_TOKEN_URL") {
                google.token_url = v;
            }
            if let Some(v) = var("CAP_CALENDAR_GOOGLE_REVOKE_URL") {
                google.revoke_url = v;
            }
            if let Some(v) = var("CAP_CALENDAR_GOOGLE_API_BASE") {
                google.api_base = v.trim_end_matches('/').to_owned();
            }
            Some(CalendarConfig {
                google_client_id: var("GOOGLE_OAUTH_CLIENT_ID")
                    .context("CAP_CALENDAR_ENABLED needs GOOGLE_OAUTH_CLIENT_ID")?,
                google_client_secret: Secret(
                    var("GOOGLE_OAUTH_CLIENT_SECRET")
                        .context("CAP_CALENDAR_ENABLED needs GOOGLE_OAUTH_CLIENT_SECRET")?,
                ),
                google,
                encryption_key: Secret32(key),
                encryption_key_id: var("CAP_CALENDAR_ENCRYPTION_KEY_ID")
                    .unwrap_or_else(|| "v1".into()),
                bot_token_sha256: cap_meeting_protocol::ids::sha256_hex(bot_token.as_bytes()),
                max_concurrent: parse_var("CAP_CALENDAR_MAX_CONCURRENT", 1)?,
                join_lead: Duration::from_secs(parse_var::<u64>(
                    "CAP_CALENDAR_JOIN_LEAD_SECONDS",
                    120,
                )?),
                sync_interval: Duration::from_secs(parse_var::<u64>(
                    "CAP_CALENDAR_SYNC_SECONDS",
                    300,
                )?),
                horizon: Duration::from_secs(
                    parse_var::<u64>("CAP_CALENDAR_HORIZON_DAYS", 14)? * 86_400,
                ),
                bot_display_name: var("CAP_CALENDAR_BOT_NAME")
                    .unwrap_or_else(|| "Calari Notetaker".into()),
                require_same_email: !matches!(
                    var("CAP_CALENDAR_REQUIRE_SAME_EMAIL").as_deref(),
                    Some("0" | "false")
                ),
                display_tz: var("CAP_DISPLAY_TIMEZONE")
                    .unwrap_or_else(|| "America/New_York".into())
                    .parse()
                    .map_err(|_| {
                        anyhow::anyhow!("CAP_DISPLAY_TIMEZONE must be an IANA zone name")
                    })?,
                allow_staff: matches!(
                    var("CAP_CALENDAR_ALLOW_STAFF").as_deref(),
                    Some("1" | "true")
                ),
            })
        } else {
            None
        };

        let cfg = Config {
            bind: parse_var("CAP_SERVER_BIND", "127.0.0.1:8787".parse()?)?,
            database_url: Secret(var("DATABASE_URL").context("DATABASE_URL is required")?),
            storage,
            public_base_url: var("CAP_SERVER_PUBLIC_URL")
                .unwrap_or_else(|| "http://127.0.0.1:8787".into())
                .trim_end_matches('/')
                .to_owned(),
            production,
            trusted_proxy_hops: parse_var("TRUSTED_PROXY_HOP_COUNT", 0)?,
            integrations,
            transcription,
            abandon_after: Duration::from_secs(
                parse_var::<u64>("CAP_MEETING_ABANDON_AFTER_MINUTES", 360)? * 60,
            ),
            worker_interval: Duration::from_secs(2),
            download_dir: var("CAP_DOWNLOAD_DIR").map(PathBuf::from),
            portal_url: var("CALARI_PORTAL_URL"),
            ffmpeg_path: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()),
            calendar,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// Rules that hold everywhere, plus production-only rules.
    pub fn validate(&self) -> Result<()> {
        if self.production && self.portal_url.is_none() {
            bail!("CALARI_PORTAL_URL is required for the public hub in production");
        }
        if let Some(url) = &self.portal_url {
            let url = reqwest::Url::parse(url).context("CALARI_PORTAL_URL")?;
            if !(url.scheme() == "https" || (!self.production && url.scheme() == "http"))
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                bail!("CALARI_PORTAL_URL must be an absolute HTTPS portal URL without credentials/query/fragment");
            }
        }
        if self.production
            && self
                .download_dir
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            bail!("CAP_DOWNLOAD_DIR must be absolute in production");
        }
        let mut seen = std::collections::HashSet::new();
        for i in &self.integrations {
            if !cap_meeting_protocol::valid_external_id(&i.key_id)
                || !cap_meeting_protocol::valid_external_id(&i.tenant_id)
            {
                bail!("integration key_id/tenant_id must be 1-128 chars of [A-Za-z0-9_.:-]");
            }
            if !seen.insert(i.key_id.clone()) {
                bail!("duplicate integration key_id {}", i.key_id);
            }
            if i.secret.len() != cap_meeting_protocol::signing::SECRET_BYTES {
                bail!("integration {} secret must be exactly 32 bytes", i.key_id);
            }
            let scheme_ok = i.delivery_url.starts_with("https://")
                || (!self.production && i.delivery_url.starts_with("http://"));
            if !scheme_ok {
                bail!("integration {} delivery_url must be https", i.key_id);
            }
            match (&i.login_authorize_url, &i.login_exchange_url, &i.login_status_url) {
                (None, None, None) => {}
                (Some(a), Some(x), Some(st)) => {
                    let ok = |u: &str| u.starts_with("https://") || (!self.production && u.starts_with("http://"));
                    if !ok(a) || !ok(x) || !ok(st) {
                        bail!("integration {} login URLs must be https", i.key_id);
                    }
                }
                _ => bail!(
                    "integration {} needs login_authorize_url, login_exchange_url and login_status_url together",
                    i.key_id
                ),
            }
            match (&i.calendar_resolve_url, &i.calendar_pairing_url) {
                (None, None) => {}
                (Some(r), Some(p)) => {
                    let ok = |u: &str| {
                        u.starts_with("https://") || (!self.production && u.starts_with("http://"))
                    };
                    if !ok(r) || !ok(p) {
                        bail!("integration {} calendar URLs must be https", i.key_id);
                    }
                }
                _ => bail!(
                    "integration {} needs calendar_resolve_url and calendar_pairing_url together",
                    i.key_id
                ),
            }
        }
        if let Some(c) = &self.calendar {
            if c.google_client_id.is_empty() || c.google_client_secret.0.is_empty() {
                bail!("calendar needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET");
            }
            if c.max_concurrent == 0 || c.max_concurrent > 4 {
                bail!("CAP_CALENDAR_MAX_CONCURRENT must be 1-4");
            }
            if !cap_meeting_protocol::valid_external_id(&c.encryption_key_id) {
                bail!("CAP_CALENDAR_ENCRYPTION_KEY_ID must be 1-128 chars of [A-Za-z0-9_.:-]");
            }
            if c.encryption_key
                .0
                .iter()
                .all(|b| *b == c.encryption_key.0[0])
            {
                bail!("CAP_CALENDAR_ENCRYPTION_KEY is not random");
            }
            if c.bot_token_sha256.len() != 64 {
                bail!("calendar bot token hash is invalid");
            }
            if c.bot_display_name.trim().is_empty() || c.bot_display_name.chars().count() > 60 {
                bail!("CAP_CALENDAR_BOT_NAME must be 1-60 characters");
            }
            if !self
                .integrations
                .iter()
                .any(|i| i.calendar_pairing_url.is_some() && i.login_status_url.is_some())
            {
                bail!("calendar needs an integration with calendar URLs and library sign-in");
            }
            // Tokens only ever go to Google itself in production.
            if self.production {
                let g = GoogleEndpoints::default();
                if c.google.auth_url != g.auth_url
                    || c.google.token_url != g.token_url
                    || c.google.revoke_url != g.revoke_url
                    || c.google.api_base != g.api_base
                {
                    bail!("Google endpoint overrides are refused in production");
                }
            }
        }
        if !self.production {
            return Ok(());
        }
        if !self.public_base_url.starts_with("https://") {
            bail!("CAP_SERVER_PUBLIC_URL must be an https URL in production");
        }
        if self.integrations.is_empty() {
            bail!("CAP_MEETING_INTEGRATIONS must define at least one integration in production");
        }
        if matches!(self.storage, StorageConfig::Filesystem { .. }) {
            bail!(
                "AWS_S3_BUCKET_NAME is required in production; local storage is development only"
            );
        }
        match &self.transcription {
            TranscriptionConfig::LocalWhisper {
                model_path,
                threads,
                ..
            } => {
                if !cfg!(feature = "local-whisper") {
                    bail!("this build has no local-whisper feature");
                }
                if !model_path.is_file() {
                    bail!(
                        "MEETING_WHISPER_MODEL_PATH {} does not exist",
                        model_path.display()
                    );
                }
                if *threads == 0 || *threads > 16 {
                    bail!("MEETING_WHISPER_THREADS must be 1-16");
                }
            }
            TranscriptionConfig::OpenAiCompatible { base_url, .. } => {
                if !base_url.starts_with("https://") {
                    bail!("MEETING_TRANSCRIPTION_BASE_URL must be https in production");
                }
            }
            TranscriptionConfig::TestFixture => {
                bail!("MEETING_TRANSCRIPTION_PROVIDER=test-fixture is refused in production")
            }
            TranscriptionConfig::Disabled => {
                bail!("MEETING_TRANSCRIPTION_PROVIDER must be configured in production")
            }
        }
        Ok(())
    }

    pub fn integration(&self, key_id: &str) -> Option<&Integration> {
        self.integrations.iter().find(|i| i.key_id == key_id)
    }

    /// The integration that provides library sign-in, if any.
    pub fn login_integration(&self) -> Option<&Integration> {
        self.integrations
            .iter()
            .find(|i| i.login_authorize_url.is_some())
    }

    pub fn integration_for_tenant(&self, tenant_id: &str) -> Option<&Integration> {
        self.integrations.iter().find(|i| i.tenant_id == tenant_id)
    }

    pub fn transcription_label(&self) -> &'static str {
        match self.transcription {
            TranscriptionConfig::LocalWhisper { .. } => "local-whisper",
            TranscriptionConfig::OpenAiCompatible { .. } => "openai-compatible",
            TranscriptionConfig::TestFixture => "test-fixture",
            TranscriptionConfig::Disabled => "disabled",
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn base() -> Config {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_url: Secret("postgres://cap:secret@db/cap".into()),
            storage: StorageConfig::S3 {
                bucket: "b".into(),
                region: "eu-west-1".into(),
                endpoint: None,
                kms_key_arn: None,
            },
            public_base_url: "https://cap.example".into(),
            production: true,
            trusted_proxy_hops: 1,
            integrations: vec![Integration {
                key_id: "k1".into(),
                tenant_id: "calari".into(),
                secret: vec![7; 32],
                delivery_url: "https://calari.example/api/meetings".into(),
                login_authorize_url: None,
                login_exchange_url: None,
                login_status_url: None,
                calendar_resolve_url: None,
                calendar_pairing_url: None,
            }],
            transcription: TranscriptionConfig::OpenAiCompatible {
                base_url: "https://whisper.example/v1".into(),
                api_key: None,
                model: "whisper-1".into(),
            },
            abandon_after: Duration::from_secs(60),
            worker_interval: Duration::from_secs(1),
            download_dir: None,
            portal_url: Some("https://calari.example/portal".into()),
            ffmpeg_path: "ffmpeg".into(),
            calendar: None,
        }
    }

    pub fn with_calendar() -> Config {
        let mut c = base();
        let i = &mut c.integrations[0];
        i.login_authorize_url = Some("https://calari.example/a".into());
        i.login_exchange_url = Some("https://calari.example/x".into());
        i.login_status_url = Some("https://calari.example/s".into());
        i.calendar_resolve_url = Some("https://calari.example/cr".into());
        i.calendar_pairing_url = Some("https://calari.example/cp".into());
        let mut key = [0u8; 32];
        key.iter_mut().enumerate().for_each(|(n, b)| *b = n as u8);
        c.calendar = Some(CalendarConfig {
            google_client_id: "id".into(),
            google_client_secret: Secret("google-secret".into()),
            google: GoogleEndpoints::default(),
            encryption_key: Secret32(key),
            encryption_key_id: "v1".into(),
            bot_token_sha256: "0".repeat(64),
            max_concurrent: 1,
            join_lead: Duration::from_secs(120),
            sync_interval: Duration::from_secs(300),
            horizon: Duration::from_secs(86_400),
            bot_display_name: "Calari Notetaker".into(),
            require_same_email: true,
            display_tz: chrono_tz::America::New_York,
            allow_staff: false,
        });
        c
    }

    #[test]
    fn calendar_rules_fail_closed() {
        assert!(with_calendar().validate().is_ok());
        type Mutation = Box<dyn Fn(&mut Config)>;
        let cases: Vec<Mutation> = vec![
            Box::new(|c| {
                c.calendar.as_mut().unwrap().google.token_url = "https://evil.example/token".into()
            }),
            Box::new(|c| {
                c.calendar.as_mut().unwrap().google.api_base = "http://127.0.0.1:1".into()
            }),
            Box::new(|c| c.calendar.as_mut().unwrap().max_concurrent = 0),
            Box::new(|c| c.calendar.as_mut().unwrap().encryption_key = Secret32([9; 32])),
            Box::new(|c| c.integrations[0].calendar_pairing_url = None),
            Box::new(|c| {
                c.integrations[0].calendar_resolve_url = Some("http://calari.example/cr".into())
            }),
            Box::new(|c| {
                c.integrations[0].calendar_resolve_url = None;
                c.integrations[0].calendar_pairing_url = None;
            }),
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut c = with_calendar();
            mutate(&mut c);
            assert!(c.validate().is_err(), "calendar case {i} should be refused");
        }
        let rendered = format!("{:?}", with_calendar());
        assert!(!rendered.contains("google-secret"));
    }

    #[test]
    fn production_rules_fail_loudly() {
        assert!(base().validate().is_ok());
        type Mutation = Box<dyn Fn(&mut Config)>;
        let cases: Vec<Mutation> = vec![
            Box::new(|c| c.public_base_url = "http://localhost:8787".into()),
            Box::new(|c| c.portal_url = None),
            Box::new(|c| c.portal_url = Some("https://user:secret@calari.example/portal".into())),
            Box::new(|c| {
                c.portal_url = Some("https://calari.example/portal?next=untrusted".into())
            }),
            Box::new(|c| c.download_dir = Some(PathBuf::from("relative-downloads"))),
            Box::new(|c| c.integrations.clear()),
            Box::new(|c| c.integrations[0].secret = vec![1; 31]),
            Box::new(|c| c.integrations[0].delivery_url = "http://calari.example".into()),
            Box::new(|c| c.transcription = TranscriptionConfig::TestFixture),
            Box::new(|c| c.transcription = TranscriptionConfig::Disabled),
            Box::new(|c| {
                c.storage = StorageConfig::Filesystem {
                    root: "/tmp".into(),
                }
            }),
            Box::new(|c| {
                c.transcription = TranscriptionConfig::LocalWhisper {
                    model_path: "/nonexistent/model.bin".into(),
                    threads: 4,
                    language: None,
                }
            }),
            Box::new(|c| {
                let dup = c.integrations[0].clone();
                c.integrations.push(dup)
            }),
            Box::new(|c| {
                c.integrations[0].login_authorize_url = Some("https://calari.example/a".into())
            }),
            Box::new(|c| {
                c.integrations[0].login_authorize_url = Some("http://calari.example/a".into());
                c.integrations[0].login_exchange_url = Some("https://calari.example/x".into());
                c.integrations[0].login_status_url = Some("https://calari.example/s".into());
            }),
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut c = base();
            mutate(&mut c);
            assert!(c.validate().is_err(), "case {i} should be refused");
        }
    }

    #[test]
    fn development_allows_local_http_and_test_fixture() {
        let mut c = base();
        c.production = false;
        c.public_base_url = "http://127.0.0.1:8787".into();
        c.integrations[0].delivery_url = "http://127.0.0.1:9999/deliver".into();
        c.transcription = TranscriptionConfig::TestFixture;
        c.storage = StorageConfig::Filesystem {
            root: "/tmp/x".into(),
        };
        assert!(c.validate().is_ok());
    }

    #[test]
    fn debug_output_redacts_secrets() {
        let rendered = format!("{:?}", base());
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("secret@db"));
        assert!(!rendered.contains("[7, 7"));
    }
}
