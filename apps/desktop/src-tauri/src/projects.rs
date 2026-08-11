use crate::model::{Project, ProjectStatus};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
// `AppHandle::path()` comes from this trait, not an inherent method.
use tauri::Manager;

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn save(directory: &Path, project: &Project) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let target = directory.join("project.json");
    let temporary = directory.join("project.json.tmp");
    let bytes = serde_json::to_vec_pretty(project).map_err(|e| e.to_string())?;
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(temporary, target).map_err(|e| e.to_string())
}

pub fn load_all(root: &Path) -> Result<Vec<Project>, String> {
    let mut projects = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry
            .map_err(|e| e.to_string())?
            .path()
            .join("project.json");
        if !path.exists() {
            continue;
        }
        let mut project: Project =
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if matches!(project.status, ProjectStatus::Recording) {
            project.status = if project.media_path.exists() {
                ProjectStatus::Recoverable
            } else {
                ProjectStatus::Failed
            };
            project.failure = Some("The previous recording process ended unexpectedly".into());
            project.updated_at = chrono::Utc::now();
            save(path.parent().unwrap(), &project)?;
        }
        projects.push(project);
    }
    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(projects)
}

pub fn delete(directory: &Path) -> Result<(), String> {
    match fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("cap-projects-test-{nanos}"))
    }

    fn sample_project(status: ProjectStatus, media_path: PathBuf) -> Project {
        let now = chrono::Utc::now();
        Project {
            id: "project-1".into(),
            title: "Test recording".into(),
            status,
            media_path,
            duration_ms: 0,
            created_at: now,
            updated_at: now,
            upload_session_id: None,
            recording_id: None,
            completion_key: "key-1".into(),
            uploaded_parts: Vec::new(),
            failure: None,
        }
    }

    #[test]
    fn save_writes_atomically_leaving_no_temp_file() {
        let root = unique_temp_dir();
        let project_dir = root.join("project-1");
        let media_path = project_dir.join("recording.mp4");
        let project = sample_project(ProjectStatus::Ready, media_path);

        save(&project_dir, &project).unwrap();

        assert!(project_dir.join("project.json").exists());
        assert!(!project_dir.join("project.json.tmp").exists());
        let loaded: Project =
            serde_json::from_slice(&fs::read(project_dir.join("project.json")).unwrap()).unwrap();
        assert_eq!(loaded.id, project.id);
        assert!(matches!(loaded.status, ProjectStatus::Ready));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_all_recovers_an_interrupted_recording_with_media_on_disk() {
        let root = unique_temp_dir();
        let project_dir = root.join("project-1");
        fs::create_dir_all(&project_dir).unwrap();
        let media_path = project_dir.join("recording.mp4");
        fs::write(&media_path, b"partial fragmented mp4 bytes").unwrap();
        let project = sample_project(ProjectStatus::Recording, media_path);
        save(&project_dir, &project).unwrap();

        let recovered = load_all(&root).unwrap();

        assert_eq!(recovered.len(), 1);
        assert!(matches!(recovered[0].status, ProjectStatus::Recoverable));
        assert!(recovered[0].failure.is_some());
        // The recovery reclassification is itself persisted, not just returned.
        let reread: Project =
            serde_json::from_slice(&fs::read(project_dir.join("project.json")).unwrap()).unwrap();
        assert!(matches!(reread.status, ProjectStatus::Recoverable));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_all_marks_an_interrupted_recording_failed_when_media_is_missing() {
        let root = unique_temp_dir();
        let project_dir = root.join("project-1");
        fs::create_dir_all(&project_dir).unwrap();
        let media_path = project_dir.join("recording.mp4"); // never written
        let project = sample_project(ProjectStatus::Recording, media_path);
        save(&project_dir, &project).unwrap();

        let recovered = load_all(&root).unwrap();

        assert_eq!(recovered.len(), 1);
        assert!(matches!(recovered[0].status, ProjectStatus::Failed));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_all_leaves_non_recording_projects_untouched() {
        let root = unique_temp_dir();
        let project_dir = root.join("project-1");
        fs::create_dir_all(&project_dir).unwrap();
        let media_path = project_dir.join("recording.mp4");
        fs::write(&media_path, b"done").unwrap();
        let project = sample_project(ProjectStatus::Ready, media_path);
        save(&project_dir, &project).unwrap();

        let loaded = load_all(&root).unwrap();

        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].status, ProjectStatus::Ready));
        assert!(loaded[0].failure.is_none());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_is_idempotent_when_the_directory_is_already_gone() {
        let root = unique_temp_dir();
        assert!(delete(&root).is_ok());
        assert!(delete(&root).is_ok());
    }
}
