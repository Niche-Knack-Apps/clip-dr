//! Settings management commands
//!
//! Commands for reading and writing application settings.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

/// Settings result
#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsResult {
    pub success: bool,
    pub settings: Option<Value>,
    pub error: Option<String>,
}

/// Get the settings file path
fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;

    Ok(app_data.join("settings.json"))
}

/// Default settings (override per-app)
fn get_default_settings() -> Value {
    serde_json::json!({
        "theme": "system",
        "fontSize": 16,
        "autoSave": true
    })
}

/// Get application settings
#[tauri::command]
pub async fn settings_get(
    app: AppHandle,
) -> Result<SettingsResult, String> {
    let settings_path = get_settings_path(&app)?;

    match fs::read_to_string(&settings_path) {
        Ok(content) => {
            match serde_json::from_str::<Value>(&content) {
                Ok(settings) => Ok(SettingsResult {
                    success: true,
                    settings: Some(settings),
                    error: None,
                }),
                Err(e) => {
                    log::warn!("Failed to parse settings, using defaults: {}", e);
                    Ok(SettingsResult {
                        success: true,
                        settings: Some(get_default_settings()),
                        error: None,
                    })
                }
            }
        }
        Err(_) => {
            // Return default settings if file doesn't exist
            Ok(SettingsResult {
                success: true,
                settings: Some(get_default_settings()),
                error: None,
            })
        }
    }
}

/// Set application settings
#[tauri::command]
pub async fn settings_set(
    settings: Value,
    app: AppHandle,
) -> Result<SettingsResult, String> {
    let settings_path = get_settings_path(&app)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| e.to_string())?;

    match fs::write(&settings_path, content) {
        Ok(_) => Ok(SettingsResult {
            success: true,
            settings: Some(settings),
            error: None,
        }),
        Err(e) => Ok(SettingsResult {
            success: false,
            settings: None,
            error: Some(format!("Failed to save settings: {}", e)),
        }),
    }
}
