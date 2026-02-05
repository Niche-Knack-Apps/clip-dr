use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use thiserror::Error;

static USER_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Error, Debug)]
pub enum PathError {
    #[error("User data directory not found")]
    UserDataNotFound,
    #[error("Path service not initialized")]
    NotInitialized,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

pub fn init(app: &AppHandle) -> Result<(), PathError> {
    let user_data = app.path().app_data_dir().map_err(|_| PathError::UserDataNotFound)?;
    std::fs::create_dir_all(&user_data)?;
    USER_DATA_DIR.set(user_data).map_err(|_| PathError::NotInitialized)?;
    log::info!("Path service initialized. User data: {:?}", USER_DATA_DIR.get());
    Ok(())
}

pub fn get_user_data_dir() -> Result<PathBuf, PathError> {
    USER_DATA_DIR.get().cloned().ok_or(PathError::NotInitialized)
}

pub fn get_models_dir() -> Result<PathBuf, String> {
    let models_dir = get_user_data_dir()
        .map_err(|e| format!("Failed to get user data dir: {}", e))?
        .join("models");

    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)
            .map_err(|e| format!("Failed to create models directory: {}", e))?;
    }

    Ok(models_dir)
}
