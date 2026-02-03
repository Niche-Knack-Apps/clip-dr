//! Engine Client
//!
//! Spawns and communicates with the AI engine via JSON-RPC over stdio.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use serde_json::Value;
use uuid::Uuid;

use super::types::{JsonRpcRequest, JsonRpcResponse, EngineEvent};

/// Error type for engine operations
#[derive(Debug)]
pub enum EngineError {
    NotStarted,
    Io(std::io::Error),
    Json(serde_json::Error),
    RpcError { code: i32, message: String },
    Timeout,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotStarted => write!(f, "Engine not started"),
            Self::Io(e) => write!(f, "IO error: {}", e),
            Self::Json(e) => write!(f, "JSON error: {}", e),
            Self::RpcError { code, message } => write!(f, "RPC error {}: {}", code, message),
            Self::Timeout => write!(f, "Request timeout"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<std::io::Error> for EngineError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for EngineError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

/// Engine client for communicating with the AI engine
pub struct EngineClient {
    child: Child,
    event_tx: Sender<EngineEvent>,
    event_rx: Receiver<EngineEvent>,
}

impl EngineClient {
    /// Spawn a new engine process
    pub fn spawn(engine_path: &str) -> Result<Self, EngineError> {
        let mut child = Command::new(engine_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child.stdout.take().ok_or_else(|| {
            EngineError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Failed to capture stdout",
            ))
        })?;

        let (event_tx, event_rx) = mpsc::channel();

        // Spawn thread to read stdout
        let tx = event_tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // Try to parse as event
                    if let Ok(event) = serde_json::from_str::<EngineEvent>(&line) {
                        let _ = tx.send(event);
                    }
                    // Otherwise it's probably a response (handled in call())
                }
            }
        });

        // Log stderr
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        log::warn!("[Engine stderr] {}", line);
                    }
                }
            });
        }

        Ok(Self {
            child,
            event_tx,
            event_rx,
        })
    }

    /// Call a method on the engine
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, EngineError> {
        let stdin = self.child.stdin.as_mut().ok_or(EngineError::NotStarted)?;

        let id = Uuid::new_v4().to_string();
        let request = JsonRpcRequest::new(id.clone(), method.to_string(), Some(params));

        let request_line = serde_json::to_string(&request)?;
        writeln!(stdin, "{}", request_line)?;
        stdin.flush()?;

        // Read response from stdout
        // Note: In a real implementation, you'd want a more sophisticated
        // approach that matches request IDs to responses
        let stdout = self.child.stdout.as_mut().ok_or(EngineError::NotStarted)?;
        let mut reader = BufReader::new(stdout);
        let mut response_line = String::new();
        reader.read_line(&mut response_line)?;

        let response: JsonRpcResponse = serde_json::from_str(&response_line)?;

        if let Some(error) = response.error {
            return Err(EngineError::RpcError {
                code: error.code,
                message: error.message,
            });
        }

        response.result.ok_or_else(|| {
            EngineError::RpcError {
                code: -32603,
                message: "No result in response".to_string(),
            }
        })
    }

    /// Receive the next event (non-blocking)
    pub fn try_recv_event(&self) -> Option<EngineEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Check if the engine is running
    pub fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }

    /// Stop the engine
    pub fn stop(&mut self) -> Result<(), EngineError> {
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }
}

impl Drop for EngineClient {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
