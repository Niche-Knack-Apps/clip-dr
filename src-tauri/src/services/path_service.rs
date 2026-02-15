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

/// Clean up old/orphaned decode cache files on startup.
/// Removes files older than 30 days, and evicts newest-first once total exceeds 10GB.
pub fn cleanup_decode_cache() -> Result<(), String> {
    let data_dir = get_user_data_dir().map_err(|e| format!("{}", e))?;
    let cache_dir = data_dir.join("decode-cache");
    if !cache_dir.exists() { return Ok(()); }

    let max_age = std::time::Duration::from_secs(30 * 24 * 3600); // 30 days
    let max_total_bytes: u64 = 10 * 1024 * 1024 * 1024; // 10 GB
    let now = std::time::SystemTime::now();

    // Collect cache entries with their age and size
    let mut entries: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&cache_dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("wav") { continue; }
            if let Ok(meta) = std::fs::metadata(&path) {
                let mtime = meta.modified().unwrap_or(now);
                entries.push((path, mtime, meta.len()));
            }
        }
    }

    if entries.is_empty() { return Ok(()); }

    // Sort newest first
    entries.sort_by_key(|(_, mtime, _)| std::cmp::Reverse(*mtime));

    let mut total_bytes: u64 = 0;
    for (path, mtime, size) in &entries {
        let age = now.duration_since(*mtime).unwrap_or_default();
        if age > max_age {
            log::info!("Cache GC: removing old cache {:?} (age: {}d)", path, age.as_secs() / 86400);
            let _ = std::fs::remove_file(path);
        } else {
            total_bytes += size;
            if total_bytes > max_total_bytes {
                log::info!("Cache GC: removing {:?} (total cache exceeds {}GB)",
                    path, max_total_bytes / 1024 / 1024 / 1024);
                let _ = std::fs::remove_file(path);
            }
        }
    }

    log::info!("Cache GC complete: {} entries checked", entries.len());
    Ok(())
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
