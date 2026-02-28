use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    pub is_loopback: bool,
    /// Whether this is an output device (new in multi-source)
    #[serde(default)]
    pub is_output: bool,
    /// Device type classification: "microphone", "loopback", "output", "virtual"
    #[serde(default)]
    pub device_type: String,
    /// Number of channels supported
    #[serde(default)]
    pub channels: u16,
    /// Supported sample rates (empty = unknown)
    #[serde(default)]
    pub sample_rates: Vec<u32>,
    /// Platform-specific device identifier (e.g., ALSA hw:x,y)
    #[serde(default)]
    pub platform_id: String,
    /// Device source classification: "hardware", "virtual", "monitor"
    #[serde(default)]
    pub device_source: String,
    /// Pulse source/sink name (for capture routing on Linux)
    #[serde(default)]
    pub pulse_name: String,
    /// Pulse source/sink index
    #[serde(default)]
    pub pulse_index: u32,
    /// Hardware bus: "usb", "pci", "bluetooth", ""
    #[serde(default)]
    pub hw_bus: String,
    /// Device serial for stable re-identification
    #[serde(default)]
    pub serial: String,
}

/// Detailed capabilities for a specific device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub is_input: bool,
    pub is_output: bool,
    pub configs: Vec<DeviceConfig>,
}

/// A supported configuration for a device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub channels: u16,
    pub sample_format: String,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Additional segment paths when recording was split (excludes `path` which is segment 1)
    pub extra_segments: Vec<String>,
    /// Seconds of pre-record buffer audio prepended to the recording
    #[serde(default)]
    pub pre_record_seconds: f64,
}

/// Configuration for a single device in a multi-source recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub device_id: String,
    pub channel_mode: Option<String>,
    pub large_file_format: Option<String>,
}

/// Result for a single session within a multi-source recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResult {
    pub session_id: String,
    pub device_id: String,
    pub result: RecordingResult,
    /// Microseconds from the shared start instant (for alignment)
    pub start_offset_us: i64,
}

/// Level info for a single active session (returned by get_session_levels).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLevel {
    pub session_id: String,
    pub device_id: String,
    pub level: f32,
}

/// Level info for a device preview (returned by get_preview_levels).
#[derive(Debug, Clone, Serialize)]
pub struct PreviewLevel {
    pub device_id: String,
    pub level: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_format: String,
    pub has_signal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceTestResult {
    pub device_name: String,
    pub working_configs: Vec<ConfigInfo>,
    pub errors: Vec<String>,
}

/// Result of scanning for orphaned recording files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanedRecording {
    pub path: String,
    pub size_bytes: u64,
    /// Whether the WAV header appears valid
    pub header_ok: bool,
    /// Estimated duration in seconds (0 if header is invalid)
    pub estimated_duration: f64,
}

/// System audio capability information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemAudioInfo {
    pub available: bool,
    pub method: String,  // "pw-record", "parecord", "cpal-monitor", or "unavailable"
    pub monitor_source: Option<String>,
    pub sink_name: Option<String>,
    pub test_result: Option<String>,  // Result of test recording
    pub cpal_monitor_device: Option<String>,  // CPAL monitor device if available
}

/// Result of a system dependency check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemDepsResult {
    /// Operating system: "linux", "windows", "macos"
    pub os: String,
    /// Missing dependencies that should be installed
    pub missing: Vec<MissingDep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingDep {
    /// Library/package name
    pub name: String,
    /// What it's needed for
    pub reason: String,
    /// Install instructions per distro family
    pub install_hint: String,
}
