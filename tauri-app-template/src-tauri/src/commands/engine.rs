//! Engine-related commands
//!
//! Commands for interacting with the AI engine process.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use std::sync::Mutex;
use crate::engine::client::EngineClient;

/// Engine health status
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
    pub uptime: u64,
    pub memory: MemoryInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub used: u64,
    pub total: u64,
}

/// State wrapper for the engine client
pub struct EngineState(pub Mutex<Option<EngineClient>>);

/// Check engine health
#[tauri::command]
pub async fn engine_health(
    state: State<'_, EngineState>,
) -> Result<HealthStatus, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    let response = engine
        .call("engine.health", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(response).map_err(|e| e.to_string())
}

/// Call an arbitrary engine method
#[tauri::command]
pub async fn engine_call(
    method: String,
    params: Value,
    state: State<'_, EngineState>,
) -> Result<Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    engine
        .call(&method, params)
        .await
        .map_err(|e| e.to_string())
}
