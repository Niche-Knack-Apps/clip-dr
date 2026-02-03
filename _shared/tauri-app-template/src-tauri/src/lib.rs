//! Niche-Knack App Template Library
//!
//! This module provides the core functionality for Tauri-based Niche-Knack apps.

pub mod commands;
pub mod engine;

pub use engine::client::EngineClient;
pub use engine::types::*;
