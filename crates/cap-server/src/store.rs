//! Object storage: the same private S3 bucket the TypeScript services use, or
//! a local directory in development.

use crate::config::StorageConfig;
use anyhow::{Context, Result};
use aws_sdk_s3::{primitives::ByteStream, types::ServerSideEncryption};
use std::path::{Component, Path, PathBuf};

#[derive(Clone)]
pub enum ObjectStore {
    S3 {
        client: aws_sdk_s3::Client,
        bucket: String,
        kms_key_arn: Option<String>,
    },
    Filesystem {
        root: PathBuf,
    },
    /// Wraps another store and pauses before every write. Used by tests to
    /// hold an upload in flight while the meeting changes state.
    Delayed(Box<ObjectStore>, std::time::Duration),
}

impl ObjectStore {
    pub async fn from_config(cfg: &StorageConfig) -> Result<Self> {
        Ok(match cfg {
            StorageConfig::S3 {
                bucket,
                region,
                endpoint,
                kms_key_arn,
            } => {
                let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(aws_config::Region::new(region.clone()))
                    .load()
                    .await;
                let mut builder = aws_sdk_s3::config::Builder::from(&shared);
                if let Some(endpoint) = endpoint {
                    builder = builder.endpoint_url(endpoint).force_path_style(true);
                }
                ObjectStore::S3 {
                    client: aws_sdk_s3::Client::from_conf(builder.build()),
                    bucket: bucket.clone(),
                    kms_key_arn: kms_key_arn.clone(),
                }
            }
            StorageConfig::Filesystem { root } => {
                tokio::fs::create_dir_all(root)
                    .await
                    .with_context(|| format!("creating {}", root.display()))?;
                ObjectStore::Filesystem { root: root.clone() }
            }
        })
    }

    fn local_path(root: &Path, key: &str) -> Result<PathBuf> {
        let rel = Path::new(key);
        anyhow::ensure!(
            rel.components().all(|c| matches!(c, Component::Normal(_))),
            "object key must be a plain relative path"
        );
        Ok(root.join(rel))
    }

    /// Stores `bytes` at `key`. Writes are all-or-nothing: S3 PUT is atomic,
    /// and the local store writes a temp file, fsyncs and renames.
    pub async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        match self {
            ObjectStore::Delayed(inner, delay) => {
                tokio::time::sleep(*delay).await;
                return Box::pin(inner.put(key, bytes, content_type)).await;
            }
            ObjectStore::S3 {
                client,
                bucket,
                kms_key_arn,
            } => {
                let mut req = client
                    .put_object()
                    .bucket(bucket)
                    .key(key)
                    .content_type(content_type)
                    .body(ByteStream::from(bytes));
                if let Some(arn) = kms_key_arn {
                    req = req
                        .server_side_encryption(ServerSideEncryption::AwsKms)
                        .ssekms_key_id(arn);
                }
                req.send().await.context("S3 PutObject failed")?;
            }
            ObjectStore::Filesystem { root } => {
                use tokio::io::AsyncWriteExt;
                let path = Self::local_path(root, key)?;
                let dir = path.parent().context("object key has no parent")?;
                tokio::fs::create_dir_all(dir).await?;
                let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
                let mut file = tokio::fs::File::create(&tmp).await?;
                file.write_all(&bytes).await?;
                file.sync_all().await?;
                drop(file);
                tokio::fs::rename(&tmp, &path).await?;
                if let Ok(d) = tokio::fs::File::open(dir).await {
                    let _ = d.sync_all().await;
                }
            }
        }
        Ok(())
    }

    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        match self {
            ObjectStore::Delayed(inner, _) => Box::pin(inner.get(key)).await,
            ObjectStore::S3 { client, bucket, .. } => {
                let out = client
                    .get_object()
                    .bucket(bucket)
                    .key(key)
                    .send()
                    .await
                    .context("S3 GetObject failed")?;
                Ok(out.body.collect().await?.into_bytes().to_vec())
            }
            ObjectStore::Filesystem { root } => {
                Ok(tokio::fs::read(Self::local_path(root, key)?).await?)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn filesystem_round_trip_and_rejects_traversal() {
        let dir = std::env::temp_dir().join(format!("cap-store-{}", uuid::Uuid::new_v4()));
        let store = ObjectStore::from_config(&StorageConfig::Filesystem { root: dir.clone() })
            .await
            .unwrap();
        store
            .put("meetings/a/b.ogg", b"OggS".to_vec(), "audio/ogg")
            .await
            .unwrap();
        assert_eq!(store.get("meetings/a/b.ogg").await.unwrap(), b"OggS");
        assert!(store.put("../escape", vec![], "x").await.is_err());
        assert!(store.put("/abs", vec![], "x").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
