use crate::model::{Project, ProjectStatus};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

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
