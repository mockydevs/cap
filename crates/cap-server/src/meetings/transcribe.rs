//! Speech-to-text for one standalone audio (or audio+video) chunk.
//!
//! Claude's Messages API reads text and images but does not accept raw
//! audio, so transcription happens here, on Cap's own server.

use crate::config::TranscriptionConfig;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChunkSegment {
    /// Relative to the start of the chunk.
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct ChunkTranscript {
    pub provider: String,
    pub model: String,
    pub language: Option<String>,
    pub segments: Vec<ChunkSegment>,
}

/// Whether a failure is worth retrying later.
#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
    #[error("transcription temporarily failed: {0}")]
    Retryable(String),
    #[error("transcription failed: {0}")]
    Permanent(String),
}

pub struct ChunkInput<'a> {
    pub bytes: &'a [u8],
    pub mime: &'a str,
    pub file_name: &'a str,
    pub seq: u32,
    pub duration_ms: u64,
    /// Tail of the previous chunk's text, to keep wording consistent across
    /// chunk boundaries.
    pub prompt: Option<&'a str>,
}

#[derive(Clone)]
pub struct Transcriber {
    inner: Arc<Inner>,
}

enum Inner {
    #[cfg(feature = "local-whisper")]
    LocalWhisper(local::Engine),
    OpenAi {
        http: reqwest::Client,
        endpoint: String,
        api_key: Option<String>,
        model: String,
    },
    TestFixture,
    Disabled,
}

impl Transcriber {
    pub fn new(cfg: &TranscriptionConfig, ffmpeg: &str) -> Result<Self> {
        let _ = ffmpeg;
        let inner = match cfg {
            #[cfg(feature = "local-whisper")]
            TranscriptionConfig::LocalWhisper {
                model_path,
                threads,
                language,
            } => Inner::LocalWhisper(local::Engine::load(
                model_path,
                *threads,
                language.clone(),
                ffmpeg.to_owned(),
            )?),
            #[cfg(not(feature = "local-whisper"))]
            TranscriptionConfig::LocalWhisper { .. } => {
                bail!("this build was compiled without the local-whisper feature")
            }
            TranscriptionConfig::OpenAiCompatible {
                base_url,
                api_key,
                model,
            } => Inner::OpenAi {
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(300))
                    .build()?,
                endpoint: format!("{}/audio/transcriptions", base_url.trim_end_matches('/')),
                api_key: api_key.as_ref().map(|s| s.0.clone()),
                model: model.clone(),
            },
            TranscriptionConfig::TestFixture => Inner::TestFixture,
            TranscriptionConfig::Disabled => Inner::Disabled,
        };
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    pub fn is_enabled(&self) -> bool {
        !matches!(*self.inner, Inner::Disabled)
    }

    pub async fn transcribe(
        &self,
        input: ChunkInput<'_>,
    ) -> Result<ChunkTranscript, TranscribeError> {
        match &*self.inner {
            #[cfg(feature = "local-whisper")]
            Inner::LocalWhisper(engine) => engine.transcribe(&input).await,
            Inner::OpenAi {
                http,
                endpoint,
                api_key,
                model,
            } => openai(http, endpoint, api_key.as_deref(), model, &input).await,
            Inner::TestFixture => Ok(ChunkTranscript {
                provider: "test-fixture".into(),
                model: "none".into(),
                language: None,
                segments: vec![ChunkSegment {
                    start_ms: 0,
                    end_ms: input.duration_ms,
                    text: format!(
                        "[test-fixture transcript, not real speech recognition: chunk {} of {} bytes]",
                        input.seq,
                        input.bytes.len()
                    ),
                }],
            }),
            Inner::Disabled => Err(TranscribeError::Permanent(
                "no transcription provider is configured".into(),
            )),
        }
    }
}

#[derive(Deserialize)]
struct VerboseJson {
    language: Option<String>,
    #[serde(default)]
    segments: Vec<VerboseSegment>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct VerboseSegment {
    start: f64,
    end: f64,
    text: String,
}

fn ms(seconds: f64) -> u64 {
    if seconds.is_finite() && seconds > 0.0 {
        (seconds * 1000.0).round() as u64
    } else {
        0
    }
}

async fn openai(
    http: &reqwest::Client,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    input: &ChunkInput<'_>,
) -> Result<ChunkTranscript, TranscribeError> {
    let part = reqwest::multipart::Part::bytes(input.bytes.to_vec())
        .file_name(input.file_name.to_owned())
        .mime_str(input.mime)
        .map_err(|e| TranscribeError::Permanent(e.to_string()))?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_owned())
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "segment")
        .part("file", part);
    if let Some(prompt) = input.prompt {
        form = form.text("prompt", prompt.to_owned());
    }
    let mut req = http.post(endpoint).multipart(form);
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }
    let res = req
        .send()
        .await
        .map_err(|e| TranscribeError::Retryable(format!("request error: {}", e.without_url())))?;
    let status = res.status();
    if status.as_u16() == 429 || status.is_server_error() || status.as_u16() == 408 {
        return Err(TranscribeError::Retryable(format!(
            "provider returned {status}"
        )));
    }
    if !status.is_success() {
        return Err(TranscribeError::Permanent(format!(
            "provider returned {status}"
        )));
    }
    let body: VerboseJson = res
        .json()
        .await
        .map_err(|e| TranscribeError::Retryable(format!("unreadable provider response: {e}")))?;
    let mut segments: Vec<ChunkSegment> = body
        .segments
        .into_iter()
        .map(|s| ChunkSegment {
            start_ms: ms(s.start),
            end_ms: ms(s.end).max(ms(s.start)),
            text: s.text.trim().to_owned(),
        })
        .filter(|s| !s.text.is_empty())
        .collect();
    if segments.is_empty() {
        if let Some(text) = body
            .text
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
        {
            segments.push(ChunkSegment {
                start_ms: 0,
                end_ms: input.duration_ms,
                text,
            });
        }
    }
    Ok(ChunkTranscript {
        provider: "openai-compatible".into(),
        model: model.to_owned(),
        language: body.language,
        segments,
    })
}

/// Extra audio allowed beyond a chunk's declared duration (encoder padding).
pub const DECODE_SLACK_MS: u64 = 10_000;
const PCM_BYTES_PER_MS: u64 = 16 * 4; // 16 kHz mono f32
const DECODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const STDERR_LIMIT: usize = 4_096;

/// Decodes any supported container to 16 kHz mono f32 PCM with FFmpeg.
///
/// The output is read as a stream and capped at `max_ms` of audio: a small
/// compressed file that decodes to far more audio than it claimed is
/// rejected (not truncated) before it can use much memory or CPU.
pub async fn decode_pcm16k(ffmpeg: &str, bytes: &[u8], max_ms: u64) -> Result<Vec<f32>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut child = tokio::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {ffmpeg}"))?;
    let mut stdin = child.stdin.take().context("ffmpeg stdin")?;
    let mut stdout = child.stdout.take().context("ffmpeg stdout")?;
    let mut stderr = child.stderr.take().context("ffmpeg stderr")?;
    let data = bytes.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&data).await;
    });
    // Keep only the start of stderr, but keep draining it so FFmpeg never blocks.
    let errors = tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut buf = [0u8; 4_096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let room = STDERR_LIMIT.saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
        String::from_utf8_lossy(&kept).into_owned()
    });
    let limit = max_ms.saturating_mul(PCM_BYTES_PER_MS) as usize;
    let read = async {
        let mut pcm = Vec::with_capacity(limit.min(8 << 20));
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = stdout.read(&mut buf).await?;
            if n == 0 {
                return Ok::<_, anyhow::Error>(Some(pcm));
            }
            if pcm.len() + n > limit {
                return Ok(None);
            }
            pcm.extend_from_slice(&buf[..n]);
        }
    };
    let outcome = tokio::time::timeout(DECODE_TIMEOUT, read).await;
    let pcm = match outcome {
        Err(_) => {
            let _ = child.kill().await;
            bail!(
                "decoding the chunk took longer than {} s",
                DECODE_TIMEOUT.as_secs()
            );
        }
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(e);
        }
        Ok(Ok(None)) => {
            let _ = child.kill().await;
            bail!("the chunk contains more than {max_ms} ms of audio, more than it declared");
        }
        Ok(Ok(Some(pcm))) => pcm,
    };
    let status = child.wait().await?;
    let _ = writer.await;
    let stderr_text = errors.await.unwrap_or_default();
    if !status.success() {
        bail!(
            "ffmpeg could not decode the chunk: {}",
            stderr_text.chars().take(300).collect::<String>()
        );
    }
    Ok(pcm
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

#[cfg(feature = "local-whisper")]
mod local {
    use super::*;
    use std::path::Path;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    /// One loaded model, one inference at a time: the host has no GPU and
    /// shares its CPUs with the rest of Cap, so concurrency is bounded here.
    pub struct Engine {
        ctx: Arc<WhisperContext>,
        threads: u16,
        language: Option<String>,
        model: String,
        ffmpeg: String,
        gate: tokio::sync::Semaphore,
    }

    impl Engine {
        pub fn load(
            path: &Path,
            threads: u16,
            language: Option<String>,
            ffmpeg: String,
        ) -> Result<Self> {
            let ctx = WhisperContext::new_with_params(
                path.to_str().context("model path is not UTF-8")?,
                WhisperContextParameters::default(),
            )
            .map_err(|e| anyhow::anyhow!("loading Whisper model {}: {e}", path.display()))?;
            Ok(Self {
                ctx: Arc::new(ctx),
                threads,
                language,
                model: path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("whisper")
                    .to_owned(),
                ffmpeg,
                gate: tokio::sync::Semaphore::new(1),
            })
        }

        pub async fn transcribe(
            &self,
            input: &ChunkInput<'_>,
        ) -> Result<ChunkTranscript, TranscribeError> {
            let pcm = decode_pcm16k(
                &self.ffmpeg,
                input.bytes,
                input.duration_ms + DECODE_SLACK_MS,
            )
            .await
            .map_err(|e| TranscribeError::Permanent(e.to_string()))?;
            let _permit = self
                .gate
                .acquire()
                .await
                .map_err(|e| TranscribeError::Retryable(e.to_string()))?;
            let ctx = self.ctx.clone();
            let threads = self.threads as i32;
            let language = self.language.clone();
            let prompt = input.prompt.map(str::to_owned);
            // Inference gets at most twice the audio length plus two minutes
            // (never more than 20 minutes), then is aborted, so one stuck run
            // cannot hold the shared CPU indefinitely.
            let budget = std::time::Duration::from_millis(
                (input.duration_ms.saturating_mul(2) + 120_000).min(20 * 60_000),
            );
            let deadline = std::time::Instant::now() + budget;
            let segments = tokio::task::spawn_blocking(move || -> Result<Vec<ChunkSegment>> {
                let mut state = ctx.create_state().map_err(|e| anyhow::anyhow!("{e}"))?;
                let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                params.set_n_threads(threads);
                params.set_language(Some(language.as_deref().unwrap_or("auto")));
                params.set_print_progress(false);
                params.set_print_realtime(false);
                params.set_print_timestamps(false);
                params.set_suppress_blank(true);
                if let Some(p) = prompt.as_deref() {
                    params.set_initial_prompt(p);
                }
                params.set_abort_callback_safe(move || std::time::Instant::now() > deadline);
                if let Err(e) = state.full(params, &pcm) {
                    if std::time::Instant::now() > deadline {
                        anyhow::bail!(
                            "transcription took longer than {} s and was stopped",
                            budget.as_secs()
                        );
                    }
                    anyhow::bail!("{e}");
                }
                let mut out = Vec::new();
                for seg in state.as_iter() {
                    let text = seg.to_str_lossy().map_err(|e| anyhow::anyhow!("{e}"))?;
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    // whisper.cpp timestamps are in 10 ms units.
                    let start = seg.start_timestamp().max(0) as u64 * 10;
                    let end = seg.end_timestamp().max(0) as u64 * 10;
                    out.push(ChunkSegment {
                        start_ms: start,
                        end_ms: end.max(start),
                        text: text.to_owned(),
                    });
                }
                Ok(out)
            })
            .await
            .map_err(|e| TranscribeError::Retryable(e.to_string()))?
            .map_err(|e| TranscribeError::Retryable(e.to_string()))?;
            Ok(ChunkTranscript {
                provider: "cap-whisper".into(),
                model: self.model.clone(),
                language: self.language.clone(),
                segments,
            })
        }
    }
}
