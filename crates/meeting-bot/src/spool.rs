//! Durable, private spool: `<spool>/<attendance>/` holds the recorder's
//! segments and journal; `<spool>/<attendance>.token` holds that meeting's own
//! device token (mode 0600). Nothing is deleted until the server confirmed the
//! meeting finalized. Quarantined segments (refused by the server for good)
//! are kept for an operator, never deleted.

use cap_meeting_recorder as recorder;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn meeting_dir(spool: &Path, attendance: Uuid) -> PathBuf {
    spool.join(attendance.to_string())
}

fn token_path(spool: &Path, attendance: Uuid) -> PathBuf {
    spool.join(format!("{attendance}.token"))
}

/// Creates the spool (0700) if needed.
pub fn ensure(spool: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(spool)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(spool, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn store_token(spool: &Path, attendance: Uuid, token: &str) -> std::io::Result<()> {
    ensure(spool)?;
    let path = token_path(spool, attendance);
    let tmp = path.with_extension("token.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    {
        use std::io::Write;
        let mut f = opts.open(&tmp)?;
        f.write_all(token.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)
}

/// Recording never started: no meeting exists, so drop the credential and
/// any empty folder (the recorder already removed its audio).
pub fn forget_if_unused(spool: &Path, attendance: Uuid) {
    let dir = meeting_dir(spool, attendance);
    if !recorder::Journal::path(&dir).exists() {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(token_path(spool, attendance));
    }
}

pub enum Settled {
    /// Server confirmed; local audio and credential removed.
    Finalized,
    /// Kept on disk with the reason; recovery retries later.
    Kept(String),
}

/// Removes a meeting's audio and credential only once the server confirmed
/// it finalized. Quarantined audio stays for an operator.
pub fn settle(spool: &Path, attendance: Uuid) -> Settled {
    let dir = meeting_dir(spool, attendance);
    let Ok(j) = recorder::Journal::load(&dir) else {
        forget_if_unused(spool, attendance);
        return Settled::Kept("no recording was made".into());
    };
    if !j.finalized {
        return Settled::Kept("audio is kept on the runner; the upload will be retried".into());
    }
    let _ = std::fs::remove_file(token_path(spool, attendance));
    if j.quarantined.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
    } else {
        eprintln!(
            "cap-meeting-bot: meeting {} finalized; segments {:?} were refused by the server and are kept in {}",
            j.meeting_id,
            j.quarantined,
            dir.display()
        );
    }
    Settled::Finalized
}

/// Bytes held in the spool (audio and journals).
pub fn size(spool: &Path) -> u64 {
    fn walk(p: &Path) -> u64 {
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            return 0;
        };
        if meta.is_dir() {
            std::fs::read_dir(p)
                .map(|it| it.flatten().map(|e| walk(&e.path())).sum())
                .unwrap_or(0)
        } else {
            meta.len()
        }
    }
    walk(spool)
}

/// Uploads and finalizes every unfinished meeting in the spool with its own
/// credential. Never joins a meeting or records. Returns the meetings that
/// were finalized now.
pub fn recover(spool: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(spool) else {
        return Vec::new();
    };
    let mut tokens: HashMap<String, String> = HashMap::new();
    let mut attendances: Vec<Uuid> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(id) = Uuid::parse_str(name.trim_end_matches(".token")) else {
            continue;
        };
        if name.ends_with(".token") {
            if !meeting_dir(spool, id).exists() {
                // A credential without audio: nothing to recover with it.
                let _ = std::fs::remove_file(entry.path());
            }
            continue;
        }
        attendances.push(id);
        let dir = meeting_dir(spool, id);
        match recorder::Journal::load(&dir) {
            Ok(j) if !j.finalized => {
                if let Ok(t) = std::fs::read_to_string(token_path(spool, id)) {
                    tokens.insert(j.meeting_id, t.trim().to_owned());
                }
            }
            _ => {}
        }
    }
    let done = recorder::recover_all(spool, |j| {
        tokens.get(&j.meeting_id).cloned().into_iter().collect()
    });
    for id in attendances {
        if let Settled::Kept(_) = settle(spool, id) {
            if recorder::Journal::load(&meeting_dir(spool, id)).is_ok() {
                eprintln!("cap-meeting-bot: attendance {id}: audio still waiting to upload");
            }
        }
    }
    done.into_iter().map(|r| r.meeting_id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_is_private_and_unused_spool_is_forgotten() {
        let root = std::env::temp_dir().join(format!("spool-{}", Uuid::new_v4().simple()));
        let a = Uuid::new_v4();
        store_token(&root, a, "capdev_x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(token_path(&root, a))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            let mode = std::fs::metadata(&root).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert!(matches!(settle(&root, a), Settled::Kept(_)));
        assert!(
            !token_path(&root, a).exists(),
            "no meeting: credential dropped"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unfinalized_audio_is_never_deleted() {
        let root = std::env::temp_dir().join(format!("spool-{}", Uuid::new_v4().simple()));
        let a = Uuid::new_v4();
        store_token(&root, a, "capdev_x").unwrap();
        let dir = meeting_dir(&root, a);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("seg-000000.ogg"), b"OggS audio").unwrap();
        let j = recorder::Journal {
            meeting_id: Uuid::new_v4().to_string(),
            server: "http://127.0.0.1:9".into(),
            mode: cap_meeting_protocol::CaptureMode::Audio,
            uploaded: vec![],
            quarantined: vec![],
            stop_reason: None,
            finalized: false,
        };
        j.save(&dir).unwrap();
        assert!(matches!(settle(&root, a), Settled::Kept(_)));
        // Server unreachable: recovery keeps everything.
        assert!(recover(&root).is_empty());
        assert!(dir.join("seg-000000.ogg").exists());
        assert!(token_path(&root, a).exists());
        let mut j = j;
        j.finalized = true;
        j.quarantined = vec![3];
        j.save(&dir).unwrap();
        assert!(matches!(settle(&root, a), Settled::Finalized));
        assert!(
            dir.join("seg-000000.ogg").exists(),
            "quarantined audio is kept"
        );
        assert!(!token_path(&root, a).exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
