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
    /// Static landing page directory served at `/`.
    pub site_dir: Option<PathBuf>,
    pub ffmpeg_path: String,
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
            site_dir: var("CAP_SITE_DIR").map(PathBuf::from),
            ffmpeg_path: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()),
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// Rules that hold everywhere, plus production-only rules.
    pub fn validate(&self) -> Result<()> {
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
            }],
            transcription: TranscriptionConfig::OpenAiCompatible {
                base_url: "https://whisper.example/v1".into(),
                api_key: None,
                model: "whisper-1".into(),
            },
            abandon_after: Duration::from_secs(60),
            worker_interval: Duration::from_secs(1),
            site_dir: None,
            ffmpeg_path: "ffmpeg".into(),
        }
    }

    #[test]
    fn production_rules_fail_loudly() {
        assert!(base().validate().is_ok());
        type Mutation = Box<dyn Fn(&mut Config)>;
        let cases: Vec<Mutation> = vec![
            Box::new(|c| c.public_base_url = "http://localhost:8787".into()),
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
