//! Project file save/load (.clipdr)

use std::fs;

/// Save a project file to disk
#[tauri::command]
pub async fn save_project(path: String, json: String) -> Result<(), String> {
    // Validate that the JSON is parseable
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Invalid project JSON: {}", e))?;

    fs::write(&path, &json)
        .map_err(|e| format!("Failed to write project file: {}", e))?;

    log::info!("Saved project to {:?}", path);
    Ok(())
}

/// Load a project file from disk
#[tauri::command]
pub async fn load_project(path: String) -> Result<String, String> {
    let json = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read project file: {}", e))?;

    // Validate that the JSON is parseable
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Invalid project JSON: {}", e))?;

    log::info!("Loaded project from {:?}", path);
    Ok(json)
}
