//! Transcription metadata persistence

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordTimingAdjustment {
    pub word_id: String,
    pub offset_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedWord {
    pub id: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionMetadata {
    pub audio_path: String,
    pub audio_hash: Option<String>,
    pub global_offset_ms: f64,
    pub word_adjustments: Vec<WordTimingAdjustment>,
    pub saved_at: u64,
    // Full transcription data (optional for backwards compatibility)
    pub words: Option<Vec<TranscribedWord>>,
    pub full_text: Option<String>,
    pub language: Option<String>,
}

/// Get the metadata file path for an audio file
fn get_metadata_path(audio_path: &str) -> std::path::PathBuf {
    let audio = Path::new(audio_path);
    let parent = audio.parent().unwrap_or(Path::new("."));
    let stem = audio.file_stem().and_then(|s| s.to_str()).unwrap_or("audio");
    parent.join(format!("{}.transcription.json", stem))
}

/// Save transcription timing metadata
#[tauri::command]
pub async fn save_transcription_metadata(
    audio_path: String,
    metadata: TranscriptionMetadata,
) -> Result<(), String> {
    let meta_path = get_metadata_path(&audio_path);

    let json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    fs::write(&meta_path, json)
        .map_err(|e| format!("Failed to write metadata file: {}", e))?;

    log::info!("Saved transcription metadata to {:?}", meta_path);
    Ok(())
}

/// Load transcription timing metadata
#[tauri::command]
pub async fn load_transcription_metadata(
    audio_path: String,
) -> Result<Option<TranscriptionMetadata>, String> {
    let meta_path = get_metadata_path(&audio_path);

    if !meta_path.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Failed to read metadata file: {}", e))?;

    let metadata: TranscriptionMetadata = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse metadata: {}", e))?;

    log::info!("Loaded transcription metadata from {:?}", meta_path);
    Ok(Some(metadata))
}

/// Delete transcription timing metadata
#[tauri::command]
pub async fn delete_transcription_metadata(audio_path: String) -> Result<(), String> {
    let meta_path = get_metadata_path(&audio_path);

    if meta_path.exists() {
        fs::remove_file(&meta_path)
            .map_err(|e| format!("Failed to delete metadata file: {}", e))?;
        log::info!("Deleted transcription metadata at {:?}", meta_path);
    }

    Ok(())
}
