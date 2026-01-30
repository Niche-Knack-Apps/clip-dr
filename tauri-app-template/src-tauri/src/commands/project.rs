//! Project management commands
//!
//! Commands for opening, saving, and listing projects.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

/// Project metadata
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

/// Project open result
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectOpenResult {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
}

/// Project save result
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectSaveResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Get the projects directory path
fn get_projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let projects_dir = app_data.join("projects");
    fs::create_dir_all(&projects_dir).map_err(|e| e.to_string())?;

    Ok(projects_dir)
}

/// Open a project by ID
#[tauri::command]
pub async fn project_open(
    project_id: String,
    app: AppHandle,
) -> Result<ProjectOpenResult, String> {
    let projects_dir = get_projects_dir(&app)?;
    let file_path = projects_dir.join(format!("{}.json", project_id));

    match fs::read_to_string(&file_path) {
        Ok(content) => {
            match serde_json::from_str::<Value>(&content) {
                Ok(data) => Ok(ProjectOpenResult {
                    success: true,
                    data: Some(data),
                    error: None,
                }),
                Err(e) => Ok(ProjectOpenResult {
                    success: false,
                    data: None,
                    error: Some(format!("Failed to parse project: {}", e)),
                }),
            }
        }
        Err(e) => Ok(ProjectOpenResult {
            success: false,
            data: None,
            error: Some(format!("Failed to read project: {}", e)),
        }),
    }
}

/// Save a project
#[tauri::command]
pub async fn project_save(
    project_id: String,
    data: Value,
    app: AppHandle,
) -> Result<ProjectSaveResult, String> {
    let projects_dir = get_projects_dir(&app)?;
    let file_path = projects_dir.join(format!("{}.json", project_id));

    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| e.to_string())?;

    match fs::write(&file_path, content) {
        Ok(_) => Ok(ProjectSaveResult {
            success: true,
            path: Some(file_path.to_string_lossy().to_string()),
            error: None,
        }),
        Err(e) => Ok(ProjectSaveResult {
            success: false,
            path: None,
            error: Some(format!("Failed to save project: {}", e)),
        }),
    }
}

/// List all projects
#[tauri::command]
pub async fn project_list(
    app: AppHandle,
) -> Result<Vec<ProjectMeta>, String> {
    let projects_dir = get_projects_dir(&app)?;
    let mut projects = Vec::new();

    let entries = fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map_or(false, |ext| ext == "json") {
            if let Some(stem) = path.file_stem() {
                let id = stem.to_string_lossy().to_string();

                // Try to read project name from file
                let (name, updated_at) = match fs::read_to_string(&path) {
                    Ok(content) => {
                        match serde_json::from_str::<Value>(&content) {
                            Ok(data) => {
                                let name = data.get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Untitled")
                                    .to_string();
                                let updated = data.get("updatedAt")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                (name, updated)
                            }
                            Err(_) => ("Untitled".to_string(), None),
                        }
                    }
                    Err(_) => ("Untitled".to_string(), None),
                };

                projects.push(ProjectMeta {
                    id,
                    name,
                    updated_at,
                });
            }
        }
    }

    // Sort by updated_at, most recent first
    projects.sort_by(|a, b| {
        b.updated_at.cmp(&a.updated_at)
    });

    Ok(projects)
}
