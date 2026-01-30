//! Job management commands
//!
//! Commands for starting, monitoring, and canceling background jobs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use crate::commands::engine::EngineState;

/// Job start result
#[derive(Debug, Serialize, Deserialize)]
pub struct JobStartResult {
    #[serde(rename = "jobId")]
    pub job_id: String,
}

/// Job status
#[derive(Debug, Serialize, Deserialize)]
pub struct JobStatus {
    pub state: String,
    pub progress: Option<f64>,
    pub message: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<u64>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<u64>,
}

/// Job cancel result
#[derive(Debug, Serialize, Deserialize)]
pub struct JobCancelResult {
    pub success: bool,
    pub reason: Option<String>,
}

/// Job info for listing
#[derive(Debug, Serialize, Deserialize)]
pub struct JobInfo {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub state: String,
    pub progress: Option<f64>,
}

/// Start a new job
#[tauri::command]
pub async fn job_start(
    job_type: String,
    payload: Value,
    priority: Option<String>,
    state: State<'_, EngineState>,
) -> Result<JobStartResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    let params = serde_json::json!({
        "type": job_type,
        "payload": payload,
        "priority": priority.unwrap_or_else(|| "normal".to_string())
    });

    let response = engine
        .call("jobs.start", params)
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(response).map_err(|e| e.to_string())
}

/// Get job status
#[tauri::command]
pub async fn job_status(
    job_id: String,
    state: State<'_, EngineState>,
) -> Result<JobStatus, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    let params = serde_json::json!({ "jobId": job_id });

    let response = engine
        .call("jobs.status", params)
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(response).map_err(|e| e.to_string())
}

/// Cancel a job
#[tauri::command]
pub async fn job_cancel(
    job_id: String,
    state: State<'_, EngineState>,
) -> Result<JobCancelResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    let params = serde_json::json!({ "jobId": job_id });

    let response = engine
        .call("jobs.cancel", params)
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(response).map_err(|e| e.to_string())
}

/// List all jobs
#[tauri::command]
pub async fn job_list(
    state: State<'_, EngineState>,
) -> Result<Vec<JobInfo>, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("Engine not initialized")?;

    let response = engine
        .call("jobs.list", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(response).map_err(|e| e.to_string())
}
