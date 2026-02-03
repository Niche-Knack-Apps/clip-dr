//! Engine types
//!
//! Type definitions for JSON-RPC communication with the AI engine.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC request
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: String, method: String, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            method,
            params,
        }
    }
}

/// JSON-RPC response
#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC error
#[derive(Debug, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

/// Engine event (streaming output)
#[derive(Debug, Deserialize)]
pub struct EngineEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub timestamp: u64,
    pub data: Value,
}

/// Standard error codes
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;

    // Job errors
    pub const JOB_NOT_FOUND: i32 = -31001;
    pub const JOB_ALREADY_RUNNING: i32 = -31002;
    pub const JOB_CANCELLED: i32 = -31003;
    pub const JOB_TIMEOUT: i32 = -31004;

    // Model errors
    pub const MODEL_NOT_FOUND: i32 = -30001;
    pub const MODEL_LOAD_FAILED: i32 = -30002;
    pub const INSUFFICIENT_MEMORY: i32 = -30003;

    // Cache errors
    pub const CACHE_MISS: i32 = -29001;
    pub const CACHE_FULL: i32 = -29002;
}
