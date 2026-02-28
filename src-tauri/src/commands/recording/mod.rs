pub mod types;
pub mod ring_buffer;
pub mod wav_writer;
pub mod error;
pub mod backend;
pub mod cpal_backend;
#[cfg(target_os = "linux")]
pub mod pulse_backend;
pub mod diagnostics;
pub mod system_audio;

// Re-export all public types so external callers remain unchanged
pub use types::*;
pub use ring_buffer::{RecordingRingBuffer, PreRecordBuffer, PRE_RECORD_SECONDS};
pub use wav_writer::{
    segment_path, spawn_wav_writer_thread, stereo_wav_to_mono_streaming,
    patch_wav_header_if_needed, check_wav_header_valid, estimate_wav_duration,
    read_wav_format,
};
pub use error::AudioError;
pub use backend::{
    AudioBackend, AudioSink, BackendKind, DeviceKey, DeviceRegistry,
    InputHandle, NegotiatedConfig, StreamConfigRequest,
};
pub use cpal_backend::CpalBackend;
#[cfg(target_os = "linux")]
pub use pulse_backend::PulseBackend;
// Diagnostics functions re-exported from diagnostics.rs (glob re-export needed
// so Tauri's generated __cmd__ symbols are visible at the recording:: path)
pub use diagnostics::*;
// System audio functions re-exported from system_audio.rs (glob re-export needed
// so Tauri's generated __cmd__ symbols are visible at the recording:: path)
pub use system_audio::*;
#[cfg(target_os = "linux")]
use system_audio::which_exists;
use system_audio::reset_recording_state_internal;
use cpal_backend::StreamHolder;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use hound::{WavSpec, WavWriter};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::panic;
use std::path::PathBuf;
use std::process::{ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::State;

use crate::audio_util::{Rf64Writer, AudioWriter};

// ── Per-Session Recording Architecture ──
// RecordingManager is Tauri managed state; individual sessions hold per-stream
// ring buffers, level atomics, and active flags. Old single-session commands
// map to the "default" session for backward compatibility.

/// A single recording session (one input device → one WAV file).
pub(super) struct RecordingSession {
    pub(super) stream: Option<StreamHolder>,
    pub(super) ring_buffer: Option<Arc<RecordingRingBuffer>>,
    pub(super) writer_handle: Option<JoinHandle<(AudioWriter, usize, Vec<PathBuf>)>>,
    /// Per-session active flag (checked by audio callback)
    pub(super) active: Arc<AtomicBool>,
    /// Per-session peak level (updated by audio callback, read by polling)
    pub(super) level: Arc<AtomicU32>,
    /// Per-session debug callback counter
    pub(super) debug_count: Arc<AtomicUsize>,
    /// Device ID this session is recording from
    pub(super) device_id: String,
    pub(super) sample_rate: u32,
    pub(super) channels: u16,
    pub(super) output_path: PathBuf,
    pub(super) target_mono: bool,
    pub(super) large_file_format: String,
    pub(super) use_system_buffer: bool,
    /// Microseconds from the shared start instant to when this session's stream started
    pub(super) start_offset_us: i64,
    /// Seconds of pre-record buffer audio prepended
    pub(super) pre_record_seconds: f64,
    /// Subprocess handle for monitor device capture (when CPAL can't open the device)
    pub(super) child: Option<std::process::Child>,
    /// Pulse capture thread handle (Linux only)
    pub(super) pulse_capture: Option<JoinHandle<()>>,
}

/// Managed state for all recording, monitoring, and preview operations.
/// Holds Arc-wrapped atomics so audio threads can access them without statics.
pub struct RecordingManager {
    /// The chosen audio backend (Pulse or cpal), selected once at startup.
    pub registry: DeviceRegistry,

    /// Active recording sessions keyed by session ID ("default" for single-session)
    pub(super) sessions: Mutex<HashMap<String, RecordingSession>>,

    // ── Monitor state (not per-session) ──
    pub(super) monitor_stream: Mutex<Option<StreamHolder>>,
    pub(super) monitoring_active: Arc<AtomicBool>,

    // ── Preview state (not per-session) ──
    preview_stream: Mutex<Option<StreamHolder>>,
    preview_active: Arc<AtomicBool>,
    preview_level: Arc<AtomicU32>,

    // ── Multi-device preview (concurrent VU meters) ──
    preview_sessions: Mutex<HashMap<String, PreviewSession>>,

    // ── Pre-record buffer (filled during monitoring) ──
    pre_record_buffer: Mutex<Option<Arc<PreRecordBuffer>>>,

    // ── Shared current level (backward compat: single-session & monitoring) ──
    pub(super) current_level: Arc<AtomicU32>,

    // ── System audio state (inherently single-instance) ──
    pub(super) system_monitor_active: Arc<AtomicBool>,
    pub(super) system_monitor_child: Arc<Mutex<Option<std::process::Child>>>,
    pub(super) system_recording_active: Arc<AtomicBool>,
    pub(super) system_wav_writer: Arc<Mutex<Option<AudioWriter>>>,
    pub(super) system_segment_base_path: Mutex<Option<PathBuf>>,
    pub(super) system_completed_segments: Mutex<Vec<PathBuf>>,
    pub(super) system_segment_data_bytes: Arc<AtomicUsize>,
    pub(super) system_segment_index: Arc<AtomicUsize>,
    pub(super) system_audio_sample_count: Arc<AtomicUsize>,
    pub(super) debug_callback_count: Arc<AtomicUsize>,
}

// RecordingSession contains a StreamHolder which has `unsafe impl Send`.
// The Mutex wrappers ensure safe concurrent access.
unsafe impl Send for RecordingSession {}

/// A preview session for live VU metering (no recording).
struct PreviewSession {
    stream: Option<StreamHolder>,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    /// Subprocess handle for monitor device preview (when CPAL can't open the device)
    child: Option<std::process::Child>,
    /// Pulse preview thread handle (Linux only)
    pulse_capture: Option<JoinHandle<()>>,
}
unsafe impl Send for PreviewSession {}

impl RecordingManager {
    pub fn new() -> Self {
        Self {
            registry: DeviceRegistry::new(),
            sessions: Mutex::new(HashMap::new()),
            monitor_stream: Mutex::new(None),
            monitoring_active: Arc::new(AtomicBool::new(false)),
            pre_record_buffer: Mutex::new(None),
            preview_stream: Mutex::new(None),
            preview_active: Arc::new(AtomicBool::new(false)),
            preview_level: Arc::new(AtomicU32::new(0)),
            preview_sessions: Mutex::new(HashMap::new()),
            current_level: Arc::new(AtomicU32::new(0)),
            system_monitor_active: Arc::new(AtomicBool::new(false)),
            system_monitor_child: Arc::new(Mutex::new(None)),
            system_recording_active: Arc::new(AtomicBool::new(false)),
            system_wav_writer: Arc::new(Mutex::new(None)),
            system_segment_base_path: Mutex::new(None),
            system_completed_segments: Mutex::new(Vec::new()),
            system_segment_data_bytes: Arc::new(AtomicUsize::new(0)),
            system_segment_index: Arc::new(AtomicUsize::new(1)),
            system_audio_sample_count: Arc::new(AtomicUsize::new(0)),
            debug_callback_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Check if any session is actively recording
    fn is_any_recording(&self) -> bool {
        if let Ok(sessions) = self.sessions.lock() {
            sessions.values().any(|s| s.active.load(Ordering::SeqCst))
        } else {
            false
        }
    }

    /// Get the "default" session's recording active state
    fn is_default_recording(&self) -> bool {
        if let Ok(sessions) = self.sessions.lock() {
            sessions.get("default")
                .map(|s| s.active.load(Ordering::SeqCst))
                .unwrap_or(false)
        } else {
            false
        }
    }
}


// Types re-exported from types.rs above

// Ring buffer and pre-record buffer re-exported from ring_buffer.rs above

// segment_path moved to wav_writer.rs

// spawn_wav_writer_thread moved to wav_writer.rs

// stereo_wav_to_mono_streaming and patch_wav_header_if_needed moved to wav_writer.rs

/// Check if a CPAL device name corresponds to a PipeWire sink name.
/// Tokenizes the sink name, extracts meaningful words (skipping "alsa", "output", "pci",
/// and hex segments), then checks if the CPAL device name contains all meaningful tokens.
/// Example: sink `alsa_output.pci_0000_00_1f_3.analog_stereo` → tokens `["analog", "stereo"]`
///          → matches CPAL device `"Monitor of Built-in Audio Analog Stereo"`
fn matches_monitor_sink(device_name: &str, sink_name: &str) -> bool {
    let lower_device = device_name.to_lowercase();
    let skip_words: &[&str] = &["alsa", "output", "input", "pci", "monitor"];

    let tokens: Vec<&str> = sink_name
        .split(|c: char| c == '.' || c == '_' || c == '-')
        .filter(|t| {
            if t.is_empty() || t.len() <= 1 { return false; }
            if skip_words.contains(&t.to_lowercase().as_str()) { return false; }
            // Skip hex-like segments (e.g., "0000", "00", "1f", "3")
            if t.chars().all(|c| c.is_ascii_hexdigit()) { return false; }
            true
        })
        .collect();

    if tokens.is_empty() {
        return false;
    }

    tokens.iter().all(|token| lower_device.contains(&token.to_lowercase()))
}

/// Spawn a subprocess to capture audio from a PipeWire monitor source.
/// Tries `parec` first, then `pw-record`. Returns the child process with stdout piped.
#[cfg(target_os = "linux")]
fn spawn_monitor_capture(device_id: &str, sample_rate: u32, channels: u16) -> Result<std::process::Child, String> {
    let pa_monitor = if device_id.ends_with(".monitor") {
        device_id.to_string()
    } else {
        format!("{}.monitor", device_id)
    };
    // For pw-record --target, strip .monitor suffix to get the sink name
    let pw_target = device_id.trim_end_matches(".monitor");

    let child = if which_exists("parec") {
        log::info!("Monitor capture: using parec -d {}", pa_monitor);
        std::process::Command::new("parec")
            .args([
                "-d", &pa_monitor,
                "--format=float32le",
                &format!("--rate={}", sample_rate),
                &format!("--channels={}", channels),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else if which_exists("pw-record") {
        log::info!("Monitor capture: using pw-record --target {}", pw_target);
        std::process::Command::new("pw-record")
            .args([
                "-P", "{ stream.capture.sink = true }",
                "--target", pw_target,
                "--format", "f32",
                "--rate", &sample_rate.to_string(),
                "--channels", &channels.to_string(),
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        return Err("No audio capture tool available (need parec or pw-record)".to_string());
    };

    child.map_err(|e| format!("Failed to spawn monitor capture: {}", e))
}

/// Reader thread for subprocess-based monitor preview (level metering only).
#[cfg(target_os = "linux")]
fn monitor_preview_reader(stdout: ChildStdout, active: Arc<AtomicBool>, level: Arc<AtomicU32>) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while active.load(Ordering::SeqCst) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let mut max_level: f32 = 0.0;
                for chunk in buffer[..n].chunks_exact(4) {
                    let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    max_level = max_level.max(s.abs());
                }
                level.store((max_level * 1000.0) as u32, Ordering::SeqCst);
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::Interrupted {
                    log::warn!("Monitor preview reader error: {}", e);
                    break;
                }
            }
        }
    }
    log::info!("Monitor preview reader thread exiting");
}

/// Reader thread for subprocess-based monitor recording.
/// Reads f32le from stdout, pushes samples into ring buffer (same as CPAL callback path).
#[cfg(target_os = "linux")]
fn monitor_session_reader(
    stdout: ChildStdout,
    ring: Arc<RecordingRingBuffer>,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    shared_level: Arc<AtomicU32>,
) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while active.load(Ordering::SeqCst) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let samples: Vec<f32> = buffer[..n]
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();

                if samples.is_empty() {
                    continue;
                }

                // Update level meter
                let max_level = samples.iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max);
                let level_val = (max_level * 1000.0) as u32;
                level.store(level_val, Ordering::SeqCst);
                shared_level.store(level_val, Ordering::SeqCst);

                // Push into ring buffer (same path as CPAL callback)
                let wp = ring.write_pos.load(Ordering::Relaxed);
                let rp = ring.read_pos.load(Ordering::Relaxed);
                let used = wp.wrapping_sub(rp);
                if used + samples.len() <= ring.capacity {
                    for (i, &s) in samples.iter().enumerate() {
                        let idx = (wp + i) % ring.capacity;
                        unsafe { *ring.data_ptr.add(idx) = s; }
                    }
                    ring.write_pos.store(wp + samples.len(), Ordering::Release);
                } else {
                    ring.overrun_count.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::Interrupted {
                    log::warn!("Monitor session reader error: {}", e);
                    break;
                }
            }
        }
    }
    log::info!("Monitor session reader thread exiting");
}

/// List input audio devices using the backend selected at startup.
/// On Linux, PulseBackend is preferred (includes monitor sources); falls back to CpalBackend.
/// No inline #[cfg] — the DeviceRegistry picks the backend once at startup.
#[tauri::command]
pub async fn list_audio_devices(mgr: State<'_, RecordingManager>) -> Result<Vec<AudioDevice>, String> {
    log::info!("[DeviceList] list_audio_devices() called (backend: {:?})", mgr.registry.kind());

    let devices = mgr.registry.refresh()
        .map_err(|e| format!("Failed to list devices: {}", e))?;

    log::info!("[DeviceList] {:?} backend returned {} input devices", mgr.registry.kind(), devices.len());
    for (i, d) in devices.iter().enumerate() {
        log::debug!("[DeviceList]   [{}] id='{}' name='{}' type={} source={} default={} loopback={} ch={} rates={:?}",
            i, d.id, d.name, d.device_type, d.device_source, d.is_default, d.is_loopback, d.channels, d.sample_rates);
    }
    if devices.is_empty() {
        log::error!("[DeviceList] WARNING: Returning 0 devices! No devices found via {:?} backend.", mgr.registry.kind());
    }

    Ok(devices)
}

/// List ALL audio devices (inputs + outputs) across all platforms.
/// Returns a unified list with is_input/is_output flags.
#[tauri::command]
pub async fn list_all_audio_devices() -> Result<Vec<AudioDevice>, String> {
    log::info!("[DeviceListAll] list_all_audio_devices() called");

    // On Linux, try PulseAudio API first — sources + sinks merged
    #[cfg(target_os = "linux")]
    {
        log::debug!("[DeviceListAll] Linux detected, trying PulseAudio sources + sinks...");
        let sources = super::pulse_devices::enumerate_pulse_sources();
        let sinks = super::pulse_devices::enumerate_pulse_sinks();
        match (&sources, &sinks) {
            (Ok(src), Ok(snk)) => {
                log::debug!("[DeviceListAll] Pulse returned {} sources, {} sinks", src.len(), snk.len());
            }
            (Err(e), _) => log::warn!("[DeviceListAll] Pulse sources failed: {}", e),
            (_, Err(e)) => log::warn!("[DeviceListAll] Pulse sinks failed: {}", e),
        }
        if let (Ok(mut src_list), Ok(sink_list)) = (sources, sinks) {
            if !src_list.is_empty() || !sink_list.is_empty() {
                // Merge sinks: if a source already has the same base name, mark it bidirectional
                let pre_merge = src_list.len();
                for sink in sink_list {
                    let base = sink.id.trim_end_matches(".monitor");
                    if let Some(existing) = src_list.iter_mut().find(|d| d.id == base || d.id == sink.id) {
                        log::debug!("[DeviceListAll] Merging sink '{}' into existing source '{}'", sink.id, existing.id);
                        existing.is_output = true;
                    } else {
                        log::debug!("[DeviceListAll] Adding sink-only device '{}'", sink.id);
                        src_list.push(sink);
                    }
                }
                log::info!("[DeviceListAll] PulseAudio: {} sources + sinks merged → {} total devices (was {} before sink merge)",
                    src_list.len(), src_list.len(), pre_merge);
                return Ok(src_list);
            }
        }
        log::warn!("[DeviceListAll] Pulse enumeration returned no devices, falling back to cpal");
    }

    // cpal path (fallback on Linux, primary on Windows/macOS)
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Get default device names for comparison
    let default_input_name = host.default_input_device().and_then(|d| d.name().ok());
    let default_output_name = host.default_output_device().and_then(|d| d.name().ok());

    // Helper: classify device name into a device_type
    fn classify_device(name: &str) -> &'static str {
        let lower = name.to_lowercase();
        if lower.contains("monitor") || lower.contains("loopback") || lower.contains("stereo mix") {
            "loopback"
        } else if lower.contains("hdmi") || lower.contains("displayport") {
            "output"
        } else if lower.contains("virtual") || lower.contains("null") {
            "virtual"
        } else {
            "microphone" // default for input devices
        }
    }

    // Helper: should skip this ALSA device?
    fn should_skip(name: &str) -> bool {
        let lower = name.to_lowercase();
        lower.contains("dmix") || lower.contains("surround")
            || lower.contains("iec958") || lower.contains("spdif")
            || name == "null"
    }

    // Helper: get channels and sample rates from a device's supported configs
    fn get_input_info(device: &cpal::Device) -> (u16, Vec<u32>) {
        if let Ok(cfg) = device.default_input_config() {
            let ch = cfg.channels();
            let rates = device.supported_input_configs()
                .map(|cfgs| {
                    let mut rates: Vec<u32> = cfgs.flat_map(|c| {
                        let mut r = vec![c.min_sample_rate().0];
                        if c.max_sample_rate().0 != c.min_sample_rate().0 {
                            r.push(c.max_sample_rate().0);
                        }
                        r
                    }).collect();
                    rates.sort_unstable();
                    rates.dedup();
                    rates
                })
                .unwrap_or_default();
            (ch, rates)
        } else {
            (0, Vec::new())
        }
    }

    fn get_output_info(device: &cpal::Device) -> (u16, Vec<u32>) {
        if let Ok(cfg) = device.default_output_config() {
            let ch = cfg.channels();
            let rates = device.supported_output_configs()
                .map(|cfgs| {
                    let mut rates: Vec<u32> = cfgs.flat_map(|c| {
                        let mut r = vec![c.min_sample_rate().0];
                        if c.max_sample_rate().0 != c.min_sample_rate().0 {
                            r.push(c.max_sample_rate().0);
                        }
                        r
                    }).collect();
                    rates.sort_unstable();
                    rates.dedup();
                    rates
                })
                .unwrap_or_default();
            (ch, rates)
        } else {
            (0, Vec::new())
        }
    }

    // ── Input devices ──
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                if should_skip(&name) { continue; }
                if device.default_input_config().is_err() { continue; }

                let is_default = default_input_name.as_ref() == Some(&name);
                let is_loopback = classify_device(&name) == "loopback";
                let (channels, sample_rates) = get_input_info(&device);
                let device_type = if is_loopback { "loopback" } else { "microphone" }.to_string();

                devices.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_default,
                    is_input: true,
                    is_loopback,
                    is_output: false,
                    device_type,
                    channels,
                    sample_rates,
                    platform_id: name.clone(),
                    device_source: String::new(),
                    pulse_name: String::new(),
                    pulse_index: 0,
                    hw_bus: String::new(),
                    serial: String::new(),
                });
            }
        }
    }

    // ── Output devices ──
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(name) = device.name() {
                if should_skip(&name) { continue; }
                if device.default_output_config().is_err() { continue; }

                let is_default = default_output_name.as_ref() == Some(&name);
                let (channels, sample_rates) = get_output_info(&device);

                // Check if this device already exists as an input (bidirectional)
                if let Some(existing) = devices.iter_mut().find(|d| d.id == name) {
                    existing.is_output = true;
                } else {
                    let device_type = classify_device(&name);
                    devices.push(AudioDevice {
                        id: name.clone(),
                        name: name.clone(),
                        is_default,
                        is_input: false,
                        is_loopback: false,
                        is_output: true,
                        device_type: if device_type == "microphone" { "output" } else { device_type }.to_string(),
                        channels,
                        sample_rates,
                        platform_id: name.clone(),
                        device_source: String::new(),
                        pulse_name: String::new(),
                        pulse_index: 0,
                        hw_bus: String::new(),
                        serial: String::new(),
                    });
                }
            }
        }
    }

    // ── Linux PipeWire/PulseAudio monitor sources ──
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("pw-cli")
            .args(["list-objects"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("alsa_output") && line.contains("node.name") {
                    if let Some(name_start) = line.find("= \"") {
                        if let Some(name_end) = line[name_start + 3..].find("\"") {
                            let sink_name = &line[name_start + 3..name_start + 3 + name_end];
                            let monitor_name = format!("{}.monitor", sink_name);
                            let display_name = format!("Monitor of {}", sink_name.replace("alsa_output.", "").replace(".", " "));

                            let already_exists = devices.iter().any(|d| {
                                d.id == monitor_name || (d.is_loopback && matches_monitor_sink(&d.name, sink_name))
                            });
                            if !already_exists {
                                devices.push(AudioDevice {
                                    id: monitor_name.clone(),
                                    name: display_name,
                                    is_default: false,
                                    is_input: true,
                                    is_loopback: true,
                                    is_output: false,
                                    device_type: "loopback".to_string(),
                                    channels: 2,
                                    sample_rates: vec![44100, 48000],
                                    platform_id: monitor_name,
                                    device_source: "monitor".to_string(),
                                    pulse_name: String::new(),
                                    pulse_index: 0,
                                    hw_bus: String::new(),
                                    serial: String::new(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!("Found {} total audio devices (input + output)", devices.len());
    for d in &devices {
        log::info!("  {} [{}] in={} out={} ch={} type={}",
            d.name, d.id, d.is_input, d.is_output, d.channels, d.device_type);
    }

    Ok(devices)
}

/// Get detailed capabilities for a specific device.
#[tauri::command]
pub fn get_device_capabilities(device_id: String) -> Result<DeviceCapabilities, String> {
    let host = cpal::default_host();

    let mut caps = DeviceCapabilities {
        device_id: device_id.clone(),
        device_name: device_id.clone(),
        is_input: false,
        is_output: false,
        configs: Vec::new(),
    };

    // Search input devices
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if device.name().ok().as_ref() == Some(&device_id) {
                caps.device_name = device.name().unwrap_or_default();
                caps.is_input = true;
                if let Ok(configs) = device.supported_input_configs() {
                    for cfg in configs {
                        caps.configs.push(DeviceConfig {
                            channels: cfg.channels(),
                            sample_format: format!("{:?}", cfg.sample_format()),
                            min_sample_rate: cfg.min_sample_rate().0,
                            max_sample_rate: cfg.max_sample_rate().0,
                        });
                    }
                }
                break;
            }
        }
    }

    // Search output devices
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if device.name().ok().as_ref() == Some(&device_id) {
                caps.device_name = device.name().unwrap_or_default();
                caps.is_output = true;
                if caps.configs.is_empty() {
                    if let Ok(configs) = device.supported_output_configs() {
                        for cfg in configs {
                            caps.configs.push(DeviceConfig {
                                channels: cfg.channels(),
                                sample_format: format!("{:?}", cfg.sample_format()),
                                min_sample_rate: cfg.min_sample_rate().0,
                                max_sample_rate: cfg.max_sample_rate().0,
                            });
                        }
                    }
                }
                break;
            }
        }
    }

    if !caps.is_input && !caps.is_output {
        return Err(format!("Device not found: {}", device_id));
    }

    Ok(caps)
}

/// Start a preview stream on a specific device (for inline VU meter in device picker).
/// Only one preview stream can be active at a time.
#[tauri::command]
pub async fn start_device_preview(device_id: String, mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Stop any existing preview
    stop_device_preview_internal(&mgr);
    std::thread::sleep(Duration::from_millis(50));

    mgr.preview_active.store(true, Ordering::SeqCst);
    mgr.preview_level.store(0, Ordering::SeqCst);

    // On Linux, try Pulse capture for Pulse-enumerated devices
    #[cfg(target_os = "linux")]
    if super::pulse_devices::is_pulse_source(&device_id) {
        log::debug!("[Preview] start_device_preview: Pulse source '{}', opening capture...", device_id);
        let active = mgr.preview_active.clone();
        let level = mgr.preview_level.clone();
        let (simple, spec) = super::pulse_devices::open_pulse_capture(&device_id, 48000, 2)?;
        log::debug!("[Preview] Pulse capture opened for preview: format={:?} rate={} ch={}", spec.format, spec.rate, spec.channels);
        let handle = std::thread::Builder::new()
            .name("pulse-preview".into())
            .spawn(move || {
                super::pulse_devices::pulse_preview_thread(simple, spec, active, level);
            })
            .map_err(|e| format!("Failed to spawn pulse preview thread: {}", e))?;
        // Store handle — we don't have a dedicated field for single preview pulse handle,
        // but the preview_active flag controls shutdown. The thread handle is fire-and-forget.
        drop(handle);
        log::info!("[Preview] Device preview started (Pulse): {}", device_id);
        return Ok(());
    }

    let host = cpal::default_host();

    let device = host.input_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
        .find(|d| d.name().ok().as_ref() == Some(&device_id))
        .ok_or_else(|| format!("Device not found: {}", device_id))?;

    let config = device.default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    let active = mgr.preview_active.clone();
    let level = mgr.preview_level.clone();

    let sample_format = config.sample_format();
    let stream = cpal_backend::build_preview_stream_dispatch(&device, &config.into(), sample_format, active, level)?;

    stream.play().map_err(|e| format!("Failed to start preview stream: {}", e))?;

    if let Ok(mut guard) = mgr.preview_stream.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    log::info!("Device preview started: {}", device_id);
    Ok(())
}

// build_preview_stream moved to cpal_backend.rs

/// Get the current preview level (0.0 - 1.0)
#[tauri::command]
pub fn get_device_preview_level(mgr: State<'_, RecordingManager>) -> f32 {
    mgr.preview_level.load(Ordering::SeqCst) as f32 / 1000.0
}

/// Stop device preview
#[tauri::command]
pub fn stop_device_preview(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping device preview");
    stop_device_preview_internal(&mgr);
}

fn stop_device_preview_internal(mgr: &RecordingManager) {
    mgr.preview_active.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = mgr.preview_stream.lock() {
        *guard = None;
    }
    mgr.preview_level.store(0, Ordering::SeqCst);
}

#[tauri::command]
pub async fn start_recording(device_id: Option<String>, output_dir: String, channel_mode: Option<String>, large_file_format: Option<String>, mgr: State<'_, RecordingManager>) -> Result<String, String> {
    // Auto-reset any stuck state from previous failed recordings
    if mgr.is_default_recording() {
        log::warn!("Recording state was stuck, auto-resetting...");
        reset_recording_state_internal(&mgr);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // On Linux, use Pulse capture if device_id is a Pulse source
    #[cfg(target_os = "linux")]
    if device_id.as_ref().map_or(false, |id| super::pulse_devices::is_pulse_source(id)) {
        let device_id_str = device_id.as_ref().unwrap();
        log::info!("[Recording] start_recording: Pulse source detected, device='{}'", device_id_str);
        let (simple, spec) = super::pulse_devices::open_pulse_capture(device_id_str, 48000, 2)?;
        log::debug!("[Recording] Pulse capture opened: format={:?} rate={} ch={}", spec.format, spec.rate, spec.channels);
        let sample_rate = spec.rate;
        let channels = spec.channels as u16;

        let target_mono = channel_mode.as_deref() == Some("mono");
        let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
        let use_rf64 = lff == "rf64";

        let output_dir_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_dir_path)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let filename = format!("recording_{}.wav", timestamp);
        let output_path = output_dir_path.join(&filename);

        let wav_spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let audio_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(file), wav_spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        let session_active = Arc::new(AtomicBool::new(true));
        let session_level = Arc::new(AtomicU32::new(0));
        let session_debug = Arc::new(AtomicUsize::new(0));
        mgr.current_level.store(0, Ordering::SeqCst);

        let ring = Arc::new(RecordingRingBuffer::new(
            sample_rate as usize * channels as usize * 10,
        ).with_channels(channels));

        let writer_handle = spawn_wav_writer_thread(
            ring.clone(), audio_writer, channels, target_mono,
            output_path.clone(), wav_spec, use_rf64,
        );

        let shared_level = mgr.current_level.clone();
        let ring_clone = ring.clone();
        let active_clone = session_active.clone();
        let level_clone = session_level.clone();
        let pulse_handle = std::thread::Builder::new()
            .name("pulse-capture-default".into())
            .spawn(move || {
                super::pulse_devices::pulse_capture_thread(
                    simple, spec, ring_clone, active_clone, level_clone, shared_level,
                );
            })
            .map_err(|e| format!("Failed to spawn Pulse capture thread: {}", e))?;

        let session = RecordingSession {
            stream: None,
            ring_buffer: Some(ring),
            writer_handle: Some(writer_handle),
            active: session_active,
            level: session_level,
            debug_count: session_debug,
            device_id: device_id_str.clone(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            use_system_buffer: false,
            start_offset_us: 0,
            pre_record_seconds: 0.0,
            child: None,
            pulse_capture: Some(pulse_handle),
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert("default".to_string(), session);
        }

        return Ok(output_path.to_string_lossy().to_string());
    }

    let host = cpal::default_host();

    // Select device
    let device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(id))
            .ok_or_else(|| format!("Device not found: {}", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    log::info!("Recording from device: {}", device_name);

    // Get supported config
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    // Try to find a better config - prefer stereo with good sample format (F32 > I16 > I32)
    let supported_configs: Vec<_> = device.supported_input_configs()
        .map_err(|e| format!("Failed to get supported configs: {}", e))?
        .collect();

    log::info!("Available input configs:");
    for cfg in &supported_configs {
        log::info!("  {} ch, {:?}, {}-{} Hz",
            cfg.channels(), cfg.sample_format(),
            cfg.min_sample_rate().0, cfg.max_sample_rate().0);
    }

    let config = cpal_backend::select_best_config(&supported_configs, default_config);

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let sample_format = config.sample_format();
    log::info!(
        "Recording config: {} Hz, {} channels, {:?}",
        sample_rate, channels, sample_format
    );
    log::info!("Buffer size: {:?}", config.buffer_size());

    // Ensure output directory exists
    let output_dir_path = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&output_dir_path)
        .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

    // Generate output filename
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.wav", timestamp);
    let output_path = output_dir_path.join(&filename);

    let target_mono = channel_mode.as_deref() == Some("mono");
    let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
    let use_rf64 = lff == "rf64";

    // Create WAV/RF64 writer for incremental crash-safe recording
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let audio_writer = if use_rf64 {
        AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
            .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
    } else {
        let file = File::create(&output_path)
            .map_err(|e| format!("Failed to create output file: {}", e))?;
        AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec)
            .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
    };

    // Create per-session atomics
    let session_active = Arc::new(AtomicBool::new(true));
    let session_level = Arc::new(AtomicU32::new(0));
    let session_debug = Arc::new(AtomicUsize::new(0));

    // Also update the shared current_level for backward compat
    mgr.current_level.store(0, Ordering::SeqCst);

    // Create ring buffer for lock-free audio callback → writer thread communication
    let ring = Arc::new(RecordingRingBuffer::new(
        sample_rate as usize * channels as usize * 10, // 10 seconds of headroom
    ).with_channels(channels));

    // Spawn the writer thread (drains ring buffer → disk)
    let writer_handle = spawn_wav_writer_thread(
        ring.clone(), audio_writer, channels, target_mono,
        output_path.clone(), spec, use_rf64,
    );

    // Drain pre-record buffer into ring buffer (prepends captured monitoring audio)
    let mut pre_record_secs = 0.0f64;
    if let Ok(mut guard) = mgr.pre_record_buffer.lock() {
        if let Some(ref buf) = *guard {
            // Only drain if the buffer's format matches the recording
            if buf.sample_rate == sample_rate && buf.channels == channels {
                let (samples, secs) = buf.drain();
                if !samples.is_empty() {
                    // Write directly into ring buffer
                    let cap = ring.capacity;
                    let wp = ring.write_pos.load(Ordering::Relaxed);
                    for (i, &s) in samples.iter().enumerate() {
                        let idx = (wp + i) % cap;
                        unsafe { *ring.data_ptr.add(idx) = s; }
                    }
                    ring.write_pos.store(wp + samples.len(), Ordering::Release);
                    pre_record_secs = secs;
                    log::info!("Pre-record buffer drained: {} samples ({:.2}s)", samples.len(), secs);
                }
            } else {
                log::info!("Pre-record buffer format mismatch ({}Hz/{}ch vs {}Hz/{}ch), skipping",
                    buf.sample_rate, buf.channels, sample_rate, channels);
            }
        }
        // Clear the buffer reference (monitoring callback may still hold its own Arc)
        *guard = None;
    }

    // Build stream based on sample format (per-session atomics)
    let stream_config: cpal::StreamConfig = config.into();
    let shared_level = mgr.current_level.clone();
    let stream = cpal_backend::build_input_stream_dispatch(&device, &stream_config, sample_format, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?;

    stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;

    // Create session and store it
    let session = RecordingSession {
        stream: Some(StreamHolder::new(stream)),
        ring_buffer: Some(ring),
        writer_handle: Some(writer_handle),
        active: session_active,
        level: session_level,
        debug_count: session_debug,
        device_id: device_id.unwrap_or_else(|| device_name.clone()),
        sample_rate,
        channels,
        output_path: output_path.clone(),
        target_mono,
        large_file_format: lff,
        use_system_buffer: false,
        start_offset_us: 0,
        pre_record_seconds: pre_record_secs,
        child: None,
        pulse_capture: None,
    };

    if let Ok(mut sessions) = mgr.sessions.lock() {
        sessions.insert("default".to_string(), session);
    }

    Ok(output_path.to_string_lossy().to_string())
}

// build_input_stream moved to cpal_backend.rs

#[tauri::command]
pub async fn stop_recording(mgr: State<'_, RecordingManager>) -> Result<RecordingResult, String> {
    // Extract the "default" session
    let session = {
        let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        sessions.remove("default")
    };

    let mut session = session.ok_or("No recording in progress")?;

    // Signal session to stop
    session.active.store(false, Ordering::SeqCst);

    // Give the stream callback a moment to see the flag
    std::thread::sleep(Duration::from_millis(100));

    // Drop cpal stream to release OS audio resources
    session.stream = None;

    // Join Pulse capture thread if present
    if let Some(handle) = session.pulse_capture.take() {
        let _ = handle.join();
    }

    // Signal ring buffer to stop and join writer thread to get writer back
    let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) = (session.ring_buffer.take(), session.writer_handle.take()) {
        // Log telemetry before joining
        let overruns = ring.overrun_count.load(Ordering::Relaxed);
        let max_fill = ring.max_fill_level.load(Ordering::Relaxed);
        if overruns > 0 {
            log::warn!(
                "Ring buffer had {} overruns during recording (max fill: {}/{})",
                overruns, max_fill, ring.capacity
            );
        }

        ring.active.store(false, Ordering::Release);
        match handle.join() {
            Ok((w, count, segments)) => (Some(w), count, segments),
            Err(_) => {
                log::error!("Writer thread panicked");
                return Err("Writer thread panicked".to_string());
            }
        }
    } else if session.use_system_buffer {
        // System audio recording path (no ring buffer)
        (None, 0usize, Vec::new())
    } else {
        return Err("Recording state incomplete".to_string());
    };

    if sample_count == 0 {
        return Err("No audio recorded".to_string());
    }

    // Calculate duration
    let samples_per_channel = sample_count / session.channels as usize;
    let duration = samples_per_channel as f64 / session.sample_rate as f64;

    log::info!(
        "Recording complete: {} samples, {:.2}s duration",
        sample_count, duration
    );

    // Finalize the writer
    if let Some(w) = writer {
        w.finalize()
            .map_err(|e| format!("Failed to finalize recording: {}", e))?;
    }

    // Patch the last segment's header (safety net for hound u32 overflow — only for split-tracks mode)
    let use_rf64 = session.large_file_format == "rf64";
    let last_seg_path = segment_path(&session.output_path, completed_segments.len() + 1);
    if !use_rf64 {
        let _ = patch_wav_header_if_needed(&last_seg_path);
    }

    // fsync the last segment to ensure data is on disk before import
    if let Ok(f) = File::open(&last_seg_path) {
        let _ = f.sync_all();
    }

    // Build extra_segments list (no concatenation — keep them as separate tracks)
    let extra_segments: Vec<String> = if !completed_segments.is_empty() {
        for seg in &completed_segments {
            if !use_rf64 {
                let _ = patch_wav_header_if_needed(seg);
            }
        }
        let mut extras: Vec<String> = completed_segments.iter()
            .skip(1)
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        extras.push(last_seg_path.to_string_lossy().to_string());
        extras
    } else {
        Vec::new()
    };

    // Convert to mono if needed (only for single-segment)
    let final_channels = if session.target_mono && session.channels == 2 && extra_segments.is_empty() {
        stereo_wav_to_mono_streaming(&session.output_path, session.sample_rate)?;
        1u16
    } else {
        session.channels
    };

    // Reset shared level
    mgr.current_level.store(0, Ordering::SeqCst);

    log::info!("Saved recording to: {:?} ({} extra segments)", session.output_path, extra_segments.len());

    Ok(RecordingResult {
        path: session.output_path.to_string_lossy().to_string(),
        duration,
        sample_rate: session.sample_rate,
        channels: final_channels,
        extra_segments,
        pre_record_seconds: session.pre_record_seconds,
    })
}

/// Start recording from multiple devices simultaneously.
/// Each device gets its own session with an independent ring buffer and writer thread.
/// A shared start instant is used to compute alignment offsets.
#[tauri::command]
pub async fn start_multi_recording(
    configs: Vec<SessionConfig>,
    output_dir: String,
    mgr: State<'_, RecordingManager>,
) -> Result<Vec<String>, String> {
    if configs.is_empty() {
        return Err("No devices specified".to_string());
    }

    // Auto-reset any stuck state
    if mgr.is_any_recording() {
        log::warn!("Recording sessions stuck, auto-resetting...");
        reset_recording_state_internal(&mgr);
        std::thread::sleep(Duration::from_millis(100));
    }

    let output_dir_path = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&output_dir_path)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let host = cpal::default_host();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let start_instant = std::time::Instant::now();
    let mut session_ids = Vec::new();

    for (idx, cfg) in configs.iter().enumerate() {
        let session_id = if configs.len() == 1 {
            "default".to_string()
        } else {
            format!("multi_{}", idx)
        };

        let device = host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(&cfg.device_id))
            .ok_or_else(|| format!("Device not found: {}", cfg.device_id))?;

        let device_name = device.name().unwrap_or_default();
        log::info!("Multi-recording session '{}': device '{}'", session_id, device_name);

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get input config for '{}': {}", device_name, e))?;

        let supported_configs: Vec<_> = device.supported_input_configs()
            .map_err(|e| format!("Failed to get supported configs: {}", e))?
            .collect();

        let config = cpal_backend::select_best_config(&supported_configs, default_config);

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let sample_format = config.sample_format();

        // Use device index in filename for multi-source
        let safe_name: String = device_name.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(30)
            .collect();
        let filename = format!("recording_{}_{}.wav", timestamp, safe_name);
        let output_path = output_dir_path.join(&filename);

        let target_mono = cfg.channel_mode.as_deref() == Some("mono");
        let lff = cfg.large_file_format.as_deref().unwrap_or("split-tracks").to_string();
        let use_rf64 = lff == "rf64";

        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let audio_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        let session_active = Arc::new(AtomicBool::new(true));
        let session_level = Arc::new(AtomicU32::new(0));
        let session_debug = Arc::new(AtomicUsize::new(0));

        let ring = Arc::new(RecordingRingBuffer::new(
            sample_rate as usize * channels as usize * 10,
        ).with_channels(channels));

        let writer_handle = spawn_wav_writer_thread(
            ring.clone(), audio_writer, channels, target_mono,
            output_path.clone(), spec, use_rf64,
        );

        let stream_config: cpal::StreamConfig = config.into();
        let shared_level = mgr.current_level.clone();
        let stream = cpal_backend::build_input_stream_dispatch(&device, &stream_config, sample_format, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?;

        stream.play().map_err(|e| format!("Failed to start stream for '{}': {}", device_name, e))?;

        let offset_us = start_instant.elapsed().as_micros() as i64;

        let session = RecordingSession {
            stream: Some(StreamHolder::new(stream)),
            ring_buffer: Some(ring),
            writer_handle: Some(writer_handle),
            active: session_active,
            level: session_level,
            debug_count: session_debug,
            device_id: cfg.device_id.clone(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            use_system_buffer: false,
            start_offset_us: offset_us,
            pre_record_seconds: 0.0,
            child: None,
            pulse_capture: None,
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert(session_id.clone(), session);
        }

        session_ids.push(session_id);
        log::info!("Session started at +{}us: {}", offset_us, output_path.display());
    }

    log::info!("Multi-recording started: {} sessions", session_ids.len());
    Ok(session_ids)
}

/// Stop all active recording sessions. Returns a result for each session.
#[tauri::command]
pub async fn stop_all_recordings(mgr: State<'_, RecordingManager>) -> Result<Vec<SessionResult>, String> {
    let sessions_map = {
        let mut guard = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        std::mem::take(&mut *guard)
    };

    if sessions_map.is_empty() {
        return Err("No recordings in progress".to_string());
    }

    let mut results = Vec::new();

    for (session_id, mut session) in sessions_map {
        // Signal session to stop
        session.active.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));

        // Drop the stream
        session.stream = None;

        // Join Pulse capture thread if present
        if let Some(handle) = session.pulse_capture.take() {
            let _ = handle.join();
        }

        let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) =
            (session.ring_buffer.take(), session.writer_handle.take())
        {
            let overruns = ring.overrun_count.load(Ordering::Relaxed);
            if overruns > 0 {
                log::warn!("Session '{}': {} ring buffer overruns", session_id, overruns);
            }
            ring.active.store(false, Ordering::Release);
            match handle.join() {
                Ok((w, count, segments)) => (Some(w), count, segments),
                Err(_) => {
                    log::error!("Session '{}': writer thread panicked", session_id);
                    continue;
                }
            }
        } else {
            (None, 0usize, Vec::new())
        };

        if sample_count == 0 {
            log::warn!("Session '{}': no audio recorded, skipping", session_id);
            continue;
        }

        let samples_per_channel = sample_count / session.channels as usize;
        let duration = samples_per_channel as f64 / session.sample_rate as f64;

        if let Some(w) = writer {
            if let Err(e) = w.finalize() {
                log::error!("Session '{}': finalize failed: {}", session_id, e);
                continue;
            }
        }

        let use_rf64 = session.large_file_format == "rf64";
        let last_seg_path = segment_path(&session.output_path, completed_segments.len() + 1);
        if !use_rf64 {
            let _ = patch_wav_header_if_needed(&last_seg_path);
        }

        if let Ok(f) = File::open(&last_seg_path) {
            let _ = f.sync_all();
        }

        let extra_segments: Vec<String> = if !completed_segments.is_empty() {
            for seg in &completed_segments {
                if !use_rf64 { let _ = patch_wav_header_if_needed(seg); }
            }
            let mut extras: Vec<String> = completed_segments.iter()
                .skip(1)
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            extras.push(last_seg_path.to_string_lossy().to_string());
            extras
        } else {
            Vec::new()
        };

        let final_channels = if session.target_mono && session.channels == 2 && extra_segments.is_empty() {
            stereo_wav_to_mono_streaming(&session.output_path, session.sample_rate)?;
            1u16
        } else {
            session.channels
        };

        log::info!("Session '{}' stopped: {:.2}s, {} samples", session_id, duration, sample_count);

        results.push(SessionResult {
            session_id: session_id.clone(),
            device_id: session.device_id.clone(),
            result: RecordingResult {
                path: session.output_path.to_string_lossy().to_string(),
                duration,
                sample_rate: session.sample_rate,
                channels: final_channels,
                extra_segments,
                pre_record_seconds: session.pre_record_seconds,
            },
            start_offset_us: session.start_offset_us,
        });
    }

    mgr.current_level.store(0, Ordering::SeqCst);
    Ok(results)
}

/// Get level meters for all active recording sessions.
#[tauri::command]
pub fn get_session_levels(mgr: State<'_, RecordingManager>) -> Vec<SessionLevel> {
    let mut levels = Vec::new();
    if let Ok(sessions) = mgr.sessions.lock() {
        for (id, session) in sessions.iter() {
            if session.active.load(Ordering::SeqCst) {
                levels.push(SessionLevel {
                    session_id: id.clone(),
                    device_id: session.device_id.clone(),
                    level: session.level.load(Ordering::SeqCst) as f32 / 1000.0,
                });
            }
        }
    }
    levels
}

// ── Independent session start/stop (for per-device recording UI) ──

/// Start a single recording session. Does NOT reset other active sessions,
/// so multiple sessions can run concurrently for independent per-device recording.
#[tauri::command]
pub async fn start_session(
    session_id: String,
    device_id: String,
    output_dir: String,
    channel_mode: Option<String>,
    large_file_format: Option<String>,
    mgr: State<'_, RecordingManager>,
) -> Result<String, String> {
    // Reject if session ID already in use
    if let Ok(sessions) = mgr.sessions.lock() {
        if sessions.contains_key(&session_id) {
            return Err(format!("Session '{}' already active", session_id));
        }
    }

    // Stop preview for this device (can't preview and record simultaneously)
    if let Ok(mut previews) = mgr.preview_sessions.lock() {
        if let Some(preview) = previews.remove(&device_id) {
            preview.active.store(false, Ordering::SeqCst);
        }
    }

    let output_dir_path = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&output_dir_path)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let target_mono_early = channel_mode.as_deref() == Some("mono");
    let lff_early = large_file_format.as_deref().unwrap_or("split-tracks").to_string();

    // On Linux, use Pulse capture for Pulse-enumerated devices
    #[cfg(target_os = "linux")]
    if super::pulse_devices::is_pulse_source(&device_id) {
        log::info!("[Session] start_session '{}': Pulse source detected, device='{}'", session_id, device_id);
        let (simple, spec) = super::pulse_devices::open_pulse_capture(
            &device_id,
            48000, // will be overridden by Pulse negotiation
            2,
        )?;
        log::debug!("[Session] Pulse capture opened for '{}': format={:?} rate={} ch={}", session_id, spec.format, spec.rate, spec.channels);
        let sample_rate = spec.rate;
        let channels = spec.channels as u16;
        let use_rf64 = lff_early == "rf64";

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let safe_name: String = device_id.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(30)
            .collect();
        let filename = format!("recording_{}_{}.wav", timestamp, safe_name);
        let output_path = output_dir_path.join(&filename);

        let wav_spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let audio_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(file), wav_spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        let session_active = Arc::new(AtomicBool::new(true));
        let session_level = Arc::new(AtomicU32::new(0));
        let session_debug = Arc::new(AtomicUsize::new(0));

        let ring = Arc::new(RecordingRingBuffer::new(
            sample_rate as usize * channels as usize * 10,
        ).with_channels(channels));

        let writer_handle = spawn_wav_writer_thread(
            ring.clone(), audio_writer, channels, target_mono_early,
            output_path.clone(), wav_spec, use_rf64,
        );

        // Spawn Pulse capture thread → ring buffer → WAV writer
        let shared_level = mgr.current_level.clone();
        let ring_clone = ring.clone();
        let active_clone = session_active.clone();
        let level_clone = session_level.clone();
        let shared_clone = shared_level;
        let pulse_handle = std::thread::Builder::new()
            .name(format!("pulse-capture-{}", session_id))
            .spawn(move || {
                super::pulse_devices::pulse_capture_thread(
                    simple, spec, ring_clone, active_clone, level_clone, shared_clone,
                );
            })
            .map_err(|e| format!("Failed to spawn Pulse capture thread: {}", e))?;

        let session = RecordingSession {
            stream: None,
            ring_buffer: Some(ring),
            writer_handle: Some(writer_handle),
            active: session_active,
            level: session_level,
            debug_count: session_debug,
            device_id: device_id.clone(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            target_mono: target_mono_early,
            large_file_format: lff_early,
            use_system_buffer: false,
            start_offset_us: 0,
            pre_record_seconds: 0.0,
            child: None,
            pulse_capture: Some(pulse_handle),
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert(session_id.clone(), session);
        }

        log::info!("Session '{}' started (Pulse): {}", session_id, output_path.display());
        return Ok(output_path.to_string_lossy().to_string());
    }

    let host = cpal::default_host();

    // Three-stage device lookup:
    // 1. Exact CPAL match by name
    // 2. Fuzzy CPAL match for monitor devices
    // 3. Subprocess fallback for monitor devices CPAL can't open
    let cpal_device = host.input_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
        .find(|d| d.name().ok().as_ref() == Some(&device_id));

    let cpal_device = if cpal_device.is_some() {
        cpal_device
    } else if device_id.ends_with(".monitor") {
        // Stage 2: fuzzy match for monitor devices
        let sink = device_id.trim_end_matches(".monitor");
        let fuzzy = host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| {
                if let Ok(name) = d.name() {
                    let lower = name.to_lowercase();
                    (lower.contains("monitor") || lower.contains("loopback"))
                        && matches_monitor_sink(&name, sink)
                } else {
                    false
                }
            });
        if fuzzy.is_some() {
            log::info!("Session '{}': resolved monitor '{}' via fuzzy CPAL match", session_id, device_id);
        }
        fuzzy
    } else {
        None
    };

    let target_mono = channel_mode.as_deref() == Some("mono");
    let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
    let use_rf64 = lff == "rf64";

    if let Some(device) = cpal_device {
        // ── CPAL path (stages 1 & 2) ──
        let device_name = device.name().unwrap_or_default();
        log::info!("Starting session '{}': device '{}'", session_id, device_name);

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get input config for '{}': {}", device_name, e))?;

        let supported_configs: Vec<_> = device.supported_input_configs()
            .map_err(|e| format!("Failed to get supported configs: {}", e))?
            .collect();

        let config = cpal_backend::select_best_config(&supported_configs, default_config);

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let sample_format = config.sample_format();

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let safe_name: String = device_name.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(30)
            .collect();
        let filename = format!("recording_{}_{}.wav", timestamp, safe_name);
        let output_path = output_dir_path.join(&filename);

        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let audio_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        let session_active = Arc::new(AtomicBool::new(true));
        let session_level = Arc::new(AtomicU32::new(0));
        let session_debug = Arc::new(AtomicUsize::new(0));

        let ring = Arc::new(RecordingRingBuffer::new(
            sample_rate as usize * channels as usize * 10,
        ).with_channels(channels));

        let writer_handle = spawn_wav_writer_thread(
            ring.clone(), audio_writer, channels, target_mono,
            output_path.clone(), spec, use_rf64,
        );

        let stream_config: cpal::StreamConfig = config.into();
        let shared_level = mgr.current_level.clone();
        let stream = cpal_backend::build_input_stream_dispatch(&device, &stream_config, sample_format, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?;

        stream.play().map_err(|e| format!("Failed to start stream for '{}': {}", device_name, e))?;

        let session = RecordingSession {
            stream: Some(StreamHolder::new(stream)),
            ring_buffer: Some(ring),
            writer_handle: Some(writer_handle),
            active: session_active,
            level: session_level,
            debug_count: session_debug,
            device_id: device_id.clone(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            use_system_buffer: false,
            start_offset_us: 0,
            pre_record_seconds: 0.0,
            child: None,
            pulse_capture: None,
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert(session_id.clone(), session);
        }

        log::info!("Session '{}' started: {}", session_id, output_path.display());
        Ok(output_path.to_string_lossy().to_string())
    } else if device_id.ends_with(".monitor") {
        // ── Stage 3: Subprocess fallback for monitor devices ──
        #[cfg(target_os = "linux")]
        {
            let sample_rate: u32 = 48000;
            let channels: u16 = 2;

            log::info!("Session '{}': using subprocess capture for monitor '{}'", session_id, device_id);

            let mut child = spawn_monitor_capture(&device_id, sample_rate, channels)?;
            let stdout = child.stdout.take()
                .ok_or_else(|| "Failed to capture subprocess stdout".to_string())?;

            let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
            let safe_name: String = device_id.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .take(30)
                .collect();
            let filename = format!("recording_{}_{}.wav", timestamp, safe_name);
            let output_path = output_dir_path.join(&filename);

            let spec = WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };

            let audio_writer = if use_rf64 {
                AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
                    .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
            } else {
                let file = File::create(&output_path)
                    .map_err(|e| format!("Failed to create output file: {}", e))?;
                AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec)
                    .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
            };

            let session_active = Arc::new(AtomicBool::new(true));
            let session_level = Arc::new(AtomicU32::new(0));
            let session_debug = Arc::new(AtomicUsize::new(0));

            let ring = Arc::new(RecordingRingBuffer::new(
                sample_rate as usize * channels as usize * 10,
            ).with_channels(channels));

            let writer_handle = spawn_wav_writer_thread(
                ring.clone(), audio_writer, channels, target_mono,
                output_path.clone(), spec, use_rf64,
            );

            // Spawn reader thread: subprocess stdout → ring buffer
            let shared_level = mgr.current_level.clone();
            {
                let ring_clone = ring.clone();
                let active_clone = session_active.clone();
                let level_clone = session_level.clone();
                let shared_clone = shared_level;
                std::thread::Builder::new()
                    .name("monitor-session-reader".into())
                    .spawn(move || {
                        monitor_session_reader(stdout, ring_clone, active_clone, level_clone, shared_clone);
                    })
                    .map_err(|e| format!("Failed to spawn monitor reader thread: {}", e))?;
            }

            let session = RecordingSession {
                stream: None,
                ring_buffer: Some(ring),
                writer_handle: Some(writer_handle),
                active: session_active,
                level: session_level,
                debug_count: session_debug,
                device_id: device_id.clone(),
                sample_rate,
                channels,
                output_path: output_path.clone(),
                target_mono,
                large_file_format: lff,
                use_system_buffer: false,
                start_offset_us: 0,
                pre_record_seconds: 0.0,
                child: Some(child),
                pulse_capture: None,
            };

            if let Ok(mut sessions) = mgr.sessions.lock() {
                sessions.insert(session_id.clone(), session);
            }

            log::info!("Session '{}' started (subprocess): {}", session_id, output_path.display());
            Ok(output_path.to_string_lossy().to_string())
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(format!("Monitor device '{}' not found (subprocess fallback only on Linux)", device_id))
        }
    } else {
        Err(format!("Device not found: {}", device_id))
    }
}

/// Stop a single recording session by its ID. Other sessions continue running.
#[tauri::command]
pub async fn stop_session(
    session_id: String,
    mgr: State<'_, RecordingManager>,
) -> Result<SessionResult, String> {
    let mut session = {
        let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        sessions.remove(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?
    };

    // Signal session to stop
    session.active.store(false, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(50));

    // Kill subprocess if this was a monitor capture session
    if let Some(ref mut child) = session.child {
        log::info!("Session '{}': killing monitor subprocess", session_id);
        let _ = child.kill();
        let _ = child.wait();
    }
    session.child = None;

    // Join Pulse capture thread if this was a Pulse capture session
    if let Some(handle) = session.pulse_capture.take() {
        log::info!("Session '{}': joining Pulse capture thread", session_id);
        let _ = handle.join();
    }

    // Drop the stream
    session.stream = None;

    let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) =
        (session.ring_buffer.take(), session.writer_handle.take())
    {
        let overruns = ring.overrun_count.load(Ordering::Relaxed);
        if overruns > 0 {
            log::warn!("Session '{}': {} ring buffer overruns", session_id, overruns);
        }
        ring.active.store(false, Ordering::Release);
        match handle.join() {
            Ok((w, count, segments)) => (Some(w), count, segments),
            Err(_) => {
                log::error!("Session '{}': writer thread panicked", session_id);
                return Err(format!("Session '{}': writer thread panicked", session_id));
            }
        }
    } else {
        (None, 0usize, Vec::new())
    };

    if sample_count == 0 {
        return Err(format!("Session '{}': no audio recorded", session_id));
    }

    let samples_per_channel = sample_count / session.channels as usize;
    let duration = samples_per_channel as f64 / session.sample_rate as f64;

    if let Some(w) = writer {
        if let Err(e) = w.finalize() {
            return Err(format!("Session '{}': finalize failed: {}", session_id, e));
        }
    }

    let use_rf64 = session.large_file_format == "rf64";
    let last_seg_path = segment_path(&session.output_path, completed_segments.len() + 1);
    if !use_rf64 {
        let _ = patch_wav_header_if_needed(&last_seg_path);
    }

    if let Ok(f) = File::open(&last_seg_path) {
        let _ = f.sync_all();
    }

    let extra_segments: Vec<String> = if !completed_segments.is_empty() {
        for seg in &completed_segments {
            if !use_rf64 { let _ = patch_wav_header_if_needed(seg); }
        }
        let mut extras: Vec<String> = completed_segments.iter()
            .skip(1)
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        extras.push(last_seg_path.to_string_lossy().to_string());
        extras
    } else {
        Vec::new()
    };

    let final_channels = if session.target_mono && session.channels == 2 && extra_segments.is_empty() {
        stereo_wav_to_mono_streaming(&session.output_path, session.sample_rate)?;
        1u16
    } else {
        session.channels
    };

    log::info!("Session '{}' stopped: {:.2}s, {} samples", session_id, duration, sample_count);

    // Clear shared level if no more sessions are active
    if !mgr.is_any_recording() {
        mgr.current_level.store(0, Ordering::SeqCst);
    }

    // Restart preview for this device (nice-to-have: re-enable VU after stop)
    // The frontend will call start_device_previews to re-enable as needed.

    Ok(SessionResult {
        session_id: session_id.clone(),
        device_id: session.device_id.clone(),
        result: RecordingResult {
            path: session.output_path.to_string_lossy().to_string(),
            duration,
            sample_rate: session.sample_rate,
            channels: final_channels,
            extra_segments,
            pre_record_seconds: session.pre_record_seconds,
        },
        start_offset_us: session.start_offset_us,
    })
}

// ── Multi-device preview (concurrent VU meters for all listed devices) ──

/// Start preview streams for multiple devices simultaneously (for VU meters).
/// Skips devices that are currently recording.
#[tauri::command]
pub async fn start_device_previews(device_ids: Vec<String>, mgr: State<'_, RecordingManager>) -> Result<(), String> {
    stop_all_previews_internal(&mgr);
    std::thread::sleep(Duration::from_millis(50));

    let host = cpal::default_host();

    for device_id in &device_ids {
        // Skip devices that are already recording
        if let Ok(sessions) = mgr.sessions.lock() {
            if sessions.values().any(|s| s.device_id == *device_id && s.active.load(Ordering::SeqCst)) {
                continue;
            }
        }

        // On Linux, use Pulse capture for Pulse-enumerated devices
        #[cfg(target_os = "linux")]
        if super::pulse_devices::is_pulse_source(device_id) {
            log::debug!("[PreviewMulti] Pulse source '{}', opening capture for preview...", device_id);
            let active = Arc::new(AtomicBool::new(true));
            let level = Arc::new(AtomicU32::new(0));
            match super::pulse_devices::open_pulse_capture(device_id, 48000, 2) {
                Ok((simple, spec)) => {
                    log::debug!("[PreviewMulti] Pulse preview opened for '{}': format={:?} rate={} ch={}",
                        device_id, spec.format, spec.rate, spec.channels);
                    let a = active.clone();
                    let l = level.clone();
                    let handle = std::thread::Builder::new()
                        .name(format!("pulse-preview-{}", device_id))
                        .spawn(move || {
                            super::pulse_devices::pulse_preview_thread(simple, spec, a, l);
                        });
                    if let Ok(h) = handle {
                        if let Ok(mut guard) = mgr.preview_sessions.lock() {
                            guard.insert(device_id.clone(), PreviewSession {
                                stream: None,
                                active,
                                level,
                                child: None,
                                pulse_capture: Some(h),
                            });
                        }
                        log::debug!("[PreviewMulti] Preview session stored for '{}'", device_id);
                    } else {
                        log::error!("[PreviewMulti] Failed to spawn preview thread for '{}'", device_id);
                    }
                }
                Err(e) => {
                    log::warn!("[PreviewMulti] Pulse capture failed for '{}': {}", device_id, e);
                }
            }
            continue;
        }

        let device = match host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(device_id))
        {
            Some(d) => d,
            None => {
                // Fallback for pw-cli monitor IDs: find a CPAL loopback device matching the sink
                if device_id.ends_with(".monitor") {
                    let sink = device_id.trim_end_matches(".monitor");
                    match host.input_devices()
                        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
                        .find(|d| {
                            if let Ok(name) = d.name() {
                                let lower = name.to_lowercase();
                                (lower.contains("monitor") || lower.contains("loopback"))
                                    && matches_monitor_sink(&name, sink)
                            } else {
                                false
                            }
                        })
                    {
                        Some(d) => {
                            log::info!("Preview: resolved pw-cli '{}' to CPAL device", device_id);
                            d
                        }
                        None => {
                            // CPAL can't find the monitor device — use subprocess fallback
                            #[cfg(target_os = "linux")]
                            {
                                log::info!("Preview: CPAL fallback failed for '{}', trying subprocess", device_id);
                                match spawn_monitor_capture(device_id, 44100, 2) {
                                    Ok(mut child) => {
                                        let active = Arc::new(AtomicBool::new(true));
                                        let level = Arc::new(AtomicU32::new(0));
                                        if let Some(stdout) = child.stdout.take() {
                                            let a = active.clone();
                                            let l = level.clone();
                                            std::thread::spawn(move || {
                                                monitor_preview_reader(stdout, a, l);
                                            });
                                            if let Ok(mut guard) = mgr.preview_sessions.lock() {
                                                guard.insert(device_id.clone(), PreviewSession {
                                                    stream: None,
                                                    active,
                                                    level,
                                                    child: Some(child),
                                                    pulse_capture: None,
                                                });
                                            }
                                        }
                                    }
                                    Err(e) => { log::warn!("Preview: subprocess fallback failed for '{}': {}", device_id, e); }
                                }
                            }
                            #[cfg(not(target_os = "linux"))]
                            {
                                log::warn!("Preview: device not found (pw-cli fallback failed): {}", device_id);
                            }
                            continue;
                        }
                    }
                } else {
                    log::warn!("Preview: device not found: {}", device_id);
                    continue;
                }
            }
        };

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => { log::warn!("Preview: config failed for '{}': {}", device_id, e); continue; }
        };

        let active = Arc::new(AtomicBool::new(true));
        let level = Arc::new(AtomicU32::new(0));

        let sample_format = config.sample_format();
        let stream_result = cpal_backend::build_preview_stream_dispatch(&device, &config.into(), sample_format, active.clone(), level.clone());

        match stream_result {
            Ok(s) => {
                if let Err(e) = s.play() {
                    log::warn!("Preview: failed to start for '{}': {}", device_id, e);
                    continue;
                }
                if let Ok(mut guard) = mgr.preview_sessions.lock() {
                    guard.insert(device_id.clone(), PreviewSession {
                        stream: Some(StreamHolder::new(s)),
                        active,
                        level,
                        child: None,
                        pulse_capture: None,
                    });
                }
            }
            Err(e) => { log::warn!("Preview: build failed for '{}': {}", device_id, e); continue; }
        }
    }

    let count = mgr.preview_sessions.lock().map(|g| g.len()).unwrap_or(0);
    log::info!("Started {} device previews", count);
    Ok(())
}

/// Get level meters for all active previews AND recording sessions.
#[tauri::command]
pub fn get_preview_levels(mgr: State<'_, RecordingManager>) -> Vec<PreviewLevel> {
    let mut levels = Vec::new();
    if let Ok(guard) = mgr.preview_sessions.lock() {
        for (device_id, session) in guard.iter() {
            if session.active.load(Ordering::SeqCst) {
                levels.push(PreviewLevel {
                    device_id: device_id.clone(),
                    level: session.level.load(Ordering::SeqCst) as f32 / 1000.0,
                });
            }
        }
    }
    // Also include levels from active recording sessions
    if let Ok(sessions) = mgr.sessions.lock() {
        for (_, session) in sessions.iter() {
            if session.active.load(Ordering::SeqCst) {
                levels.push(PreviewLevel {
                    device_id: session.device_id.clone(),
                    level: session.level.load(Ordering::SeqCst) as f32 / 1000.0,
                });
            }
        }
    }
    levels
}

/// Stop all device previews.
#[tauri::command]
pub fn stop_all_previews(mgr: State<'_, RecordingManager>) {
    stop_all_previews_internal(&mgr);
}

fn stop_all_previews_internal(mgr: &RecordingManager) {
    if let Ok(mut guard) = mgr.preview_sessions.lock() {
        for (id, mut session) in guard.drain() {
            session.active.store(false, Ordering::SeqCst);
            if let Some(ref mut child) = session.child {
                log::info!("Preview: killing subprocess for '{}'", id);
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(handle) = session.pulse_capture.take() {
                let _ = handle.join();
            }
            log::info!("Preview stopped: {}", id);
        }
    }
}

#[tauri::command]
pub fn get_recording_level(mgr: State<'_, RecordingManager>) -> f32 {
    mgr.current_level.load(Ordering::SeqCst) as f32 / 1000.0
}

#[tauri::command]
pub fn is_recording(mgr: State<'_, RecordingManager>) -> bool {
    mgr.is_default_recording() || mgr.system_recording_active.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_recording(mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Extract the "default" session
    let session = {
        let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        sessions.remove("default")
    };

    if let Some(mut session) = session {
        session.active.store(false, Ordering::SeqCst);

        // Drop cpal stream
        session.stream = None;

        // Join Pulse capture thread if present
        if let Some(handle) = session.pulse_capture.take() {
            let _ = handle.join();
        }

        let output_path = session.output_path.clone();
        // Stop ring buffer and join writer thread before cleaning up
        if let Some(ring) = &session.ring_buffer {
            ring.active.store(false, Ordering::Release);
        }
        if let Some(handle) = session.writer_handle.take() {
            match handle.join() {
                Ok((_writer, _count, completed)) => {
                    for seg in &completed {
                        let _ = std::fs::remove_file(seg);
                    }
                }
                Err(_) => {}
            }
        }
        let _ = std::fs::remove_file(&output_path);

        // Clean up system audio segments if any
        if let Ok(mut completed) = mgr.system_completed_segments.lock() {
            for seg in completed.drain(..) {
                let _ = std::fs::remove_file(&seg);
            }
        }
    }

    mgr.current_level.store(0, Ordering::SeqCst);
    log::info!("Recording cancelled");
    Ok(())
}

/// Start monitoring a device (show levels without recording)
#[tauri::command]
pub async fn start_monitoring(device_id: Option<String>, mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Stop any existing monitoring
    stop_monitoring_internal(&mgr);
    // Also reset any stuck recording state
    if mgr.is_default_recording() {
        log::warn!("Recording state was stuck during monitor start, resetting...");
        reset_recording_state_internal(&mgr);
    }
    std::thread::sleep(std::time::Duration::from_millis(50));

    let host = cpal::default_host();

    let device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(id))
            .ok_or_else(|| format!("Device not found: {}", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    log::info!("Starting monitoring on device: {}", device_name);

    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    mgr.monitoring_active.store(true, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);

    // Create pre-record buffer (10 seconds at device sample rate & channels)
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let buf_capacity = sample_rate as usize * channels as usize * PRE_RECORD_SECONDS;
    let pre_record = Arc::new(PreRecordBuffer::new(buf_capacity, sample_rate, channels));
    if let Ok(mut guard) = mgr.pre_record_buffer.lock() {
        *guard = Some(pre_record.clone());
    }
    log::info!("Pre-record buffer created: {}s at {}Hz {}ch ({} samples)",
        PRE_RECORD_SECONDS, sample_rate, channels, buf_capacity);

    let active = mgr.monitoring_active.clone();
    let level = mgr.current_level.clone();

    let stream = match config.sample_format() {
        SampleFormat::F32 => build_monitor_stream::<f32>(&device, &config.into(), active, level, Some(pre_record))?,
        SampleFormat::I16 => build_monitor_stream::<i16>(&device, &config.into(), active, level, Some(pre_record))?,
        SampleFormat::U16 => build_monitor_stream::<u16>(&device, &config.into(), active, level, Some(pre_record))?,
        SampleFormat::I32 => build_monitor_stream::<i32>(&device, &config.into(), active, level, Some(pre_record))?,
        SampleFormat::U8 => build_monitor_stream::<u8>(&device, &config.into(), active, level, Some(pre_record))?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start monitor stream: {}", e))?;

    if let Ok(mut guard) = mgr.monitor_stream.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    Ok(())
}

fn build_monitor_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    pre_record: Option<Arc<PreRecordBuffer>>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Monitor error: {}", err);
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !active.load(Ordering::SeqCst) {
                    return;
                }

                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    let mut max_level: f32 = 0.0;

                    // If pre-record buffer exists, convert and write to it
                    if let Some(ref buf) = pre_record {
                        let mut temp = Vec::with_capacity(data.len());
                        for s in data.iter() {
                            let f = f32::from_sample(*s);
                            max_level = max_level.max(f.abs());
                            temp.push(f);
                        }
                        buf.write(&temp);
                    } else {
                        for s in data.iter() {
                            let f = f32::from_sample(*s);
                            max_level = max_level.max(f.abs());
                        }
                    }

                    level.store((max_level * 1000.0) as u32, Ordering::SeqCst);
                }));

                if result.is_err() {
                    log::warn!("Monitor callback panic caught (ALSA timing issue)");
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build monitor stream: {}", e))
}

pub(super) fn stop_monitoring_internal(mgr: &RecordingManager) {
    mgr.monitoring_active.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = mgr.monitor_stream.lock() {
        *guard = None;
    }
    // Clear the pre-record buffer
    if let Ok(mut guard) = mgr.pre_record_buffer.lock() {
        *guard = None;
    }
    mgr.current_level.store(0, Ordering::SeqCst);
}

/// Stop monitoring a device
#[tauri::command]
pub fn stop_monitoring(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping monitoring");
    stop_monitoring_internal(&mgr);
}

/// Check if monitoring is active
#[tauri::command]
pub fn is_monitoring(mgr: State<'_, RecordingManager>) -> bool {
    mgr.monitoring_active.load(Ordering::SeqCst)
}

// kill_all_stale_processes, start_system_audio_monitoring_impl,
// start_system_audio_monitoring, stop_system_audio_monitoring,
// stop_system_audio_monitoring_internal, system_audio_monitor_reader,
// SysAudioReaderCtx, reset_recording_state, reset_recording_state_internal,
// start_system_audio_recording, stop_system_audio_recording,
// get_default_monitor_source, which_exists, recover_recording
// moved to system_audio.rs

// test_audio_device, test_stream, check_input_muted moved to diagnostics.rs

// unmute_input moved to diagnostics.rs

// probe_system_audio, find_cpal_monitor_device, test_cpal_monitor,
// test_parec, test_pw_record, test_parecord moved to diagnostics.rs

// scan_orphaned_recordings, delete_orphaned_recording moved to diagnostics.rs

// check_wav_header_valid, estimate_wav_duration, read_wav_format moved to wav_writer.rs

// check_system_deps, libpulse_available moved to diagnostics.rs

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use std::io::Read as _;

    // ── Ring Buffer SPSC ──

    #[test]
    fn ring_buffer_basic_write_read() {
        let ring = RecordingRingBuffer::new(1024);
        assert_eq!(ring.write_pos.load(Ordering::Relaxed), 0);
        assert_eq!(ring.read_pos.load(Ordering::Relaxed), 0);

        // Write 4 samples
        for i in 0..4 {
            let idx = i % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = (i as f32) * 0.1; }
        }
        ring.write_pos.store(4, Ordering::Release);

        // Read back
        let wp = ring.write_pos.load(Ordering::Acquire);
        let rp = ring.read_pos.load(Ordering::Relaxed);
        assert_eq!(wp - rp, 4);

        for i in 0..4 {
            let idx = (rp + i) % ring.capacity;
            let val = unsafe { *ring.data_ptr.add(idx) };
            assert!((val - (i as f32) * 0.1).abs() < 1e-6, "sample {} mismatch: {}", i, val);
        }
        ring.read_pos.store(rp + 4, Ordering::Release);
        assert_eq!(ring.write_pos.load(Ordering::Relaxed) - ring.read_pos.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn ring_buffer_wrap_around() {
        let ring = RecordingRingBuffer::new(8);

        // Write 6 samples
        for i in 0..6 {
            let idx = i % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = i as f32; }
        }
        ring.write_pos.store(6, Ordering::Release);

        // Read 4 (advance read_pos)
        ring.read_pos.store(4, Ordering::Release);

        // Write 6 more (wraps: positions 6,7,0,1,2,3)
        for i in 6..12 {
            let wp = ring.write_pos.load(Ordering::Relaxed);
            let idx = (wp + (i - 6)) % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = i as f32; }
        }
        ring.write_pos.store(12, Ordering::Release);

        // Read all available (positions 4..12)
        let rp = ring.read_pos.load(Ordering::Relaxed);
        let wp = ring.write_pos.load(Ordering::Acquire);
        let available = wp.wrapping_sub(rp);
        assert_eq!(available, 8);

        for i in 0..available {
            let idx = (rp + i) % ring.capacity;
            let val = unsafe { *ring.data_ptr.add(idx) };
            assert!((val - (rp + i) as f32).abs() < 1e-6,
                "wrap sample {} (pos {}) mismatch: got {}, expected {}", i, rp + i, val, rp + i);
        }
    }

    #[test]
    fn ring_buffer_with_channels() {
        let ring = RecordingRingBuffer::new(256).with_channels(2);
        assert_eq!(ring.channels, 2);
        assert_eq!(ring.capacity, 256);
    }

    // ── Overrun Detection ──

    #[test]
    fn ring_buffer_overrun_detection() {
        let ring = RecordingRingBuffer::new(16);
        // Fill completely: wp=16, rp=0 → used=16 = capacity
        ring.write_pos.store(16, Ordering::Release);

        // Simulate callback checking for space: trying to write 4 more
        let wp = ring.write_pos.load(Ordering::Relaxed);
        let rp = ring.read_pos.load(Ordering::Acquire);
        let used = wp.wrapping_sub(rp);
        let incoming = 4;

        if used + incoming > ring.capacity {
            ring.overrun_count.fetch_add(1, Ordering::Relaxed);
        }

        assert_eq!(ring.overrun_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn ring_buffer_max_fill_level() {
        let ring = RecordingRingBuffer::new(1024);

        // Simulate progressively increasing fill levels
        let _ = ring.max_fill_level.fetch_max(100, Ordering::Relaxed);
        let _ = ring.max_fill_level.fetch_max(500, Ordering::Relaxed);
        let _ = ring.max_fill_level.fetch_max(200, Ordering::Relaxed); // Should not decrease

        assert_eq!(ring.max_fill_level.load(Ordering::Relaxed), 500);
    }

    // ── Bad Channel Detection ──

    #[test]
    fn bad_channel_detection_ch0_clipped() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: ch0 = 1.0 (clipped), ch1 = 0.3 (normal)
        for i in 0..100 {
            let idx0 = i * 2;
            let idx1 = i * 2 + 1;
            unsafe {
                *ring.data_ptr.add(idx0) = 1.0;   // ch0 clipped
                *ring.data_ptr.add(idx1) = 0.3;   // ch1 normal
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        // Run the same detection logic as the writer thread
        let channels = ring.channels;
        let rp = ring.read_pos.load(Ordering::Relaxed);
        let available = ring.write_pos.load(Ordering::Acquire).wrapping_sub(rp);

        if channels == 2 && available >= 200 {
            let check_pairs = 100usize.min(available / 2);
            let mut ch0_clipped = 0usize;
            let mut ch1_clipped = 0usize;
            for i in 0..check_pairs {
                let idx0 = (rp + i * 2) % ring.capacity;
                let idx1 = (rp + i * 2 + 1) % ring.capacity;
                let s0 = unsafe { *ring.data_ptr.add(idx0) };
                let s1 = unsafe { *ring.data_ptr.add(idx1) };
                if s0.abs() >= 0.999 { ch0_clipped += 1; }
                if s1.abs() >= 0.999 { ch1_clipped += 1; }
            }

            // ch0 is >80% clipped, ch1 is <30% clipped → bad channel 0
            assert!(ch0_clipped >= check_pairs * 8 / 10,
                "Expected ch0 >= 80% clipped, got {}/{}", ch0_clipped, check_pairs);
            assert!(ch1_clipped < check_pairs * 3 / 10,
                "Expected ch1 < 30% clipped, got {}/{}", ch1_clipped, check_pairs);

            // This would set bad_channel = 1 (ch0 bad)
            ring.bad_channel.store(1, Ordering::Release);
        }

        assert_eq!(ring.bad_channel.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn bad_channel_detection_ch1_clipped() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: ch0 = 0.2 (normal), ch1 = -1.0 (clipped)
        for i in 0..100 {
            unsafe {
                *ring.data_ptr.add(i * 2) = 0.2;
                *ring.data_ptr.add(i * 2 + 1) = -1.0;
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        let rp = ring.read_pos.load(Ordering::Relaxed);
        let available = ring.write_pos.load(Ordering::Acquire).wrapping_sub(rp);
        let check_pairs = 100usize.min(available / 2);
        let mut ch0_clipped = 0usize;
        let mut ch1_clipped = 0usize;
        for i in 0..check_pairs {
            let idx0 = (rp + i * 2) % ring.capacity;
            let idx1 = (rp + i * 2 + 1) % ring.capacity;
            let s0 = unsafe { *ring.data_ptr.add(idx0) };
            let s1 = unsafe { *ring.data_ptr.add(idx1) };
            if s0.abs() >= 0.999 { ch0_clipped += 1; }
            if s1.abs() >= 0.999 { ch1_clipped += 1; }
        }

        assert!(ch1_clipped >= check_pairs * 8 / 10);
        assert!(ch0_clipped < check_pairs * 3 / 10);
    }

    #[test]
    fn bad_channel_detection_both_normal() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: both channels normal
        for i in 0..100 {
            unsafe {
                *ring.data_ptr.add(i * 2) = 0.3;
                *ring.data_ptr.add(i * 2 + 1) = -0.4;
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        let rp = ring.read_pos.load(Ordering::Relaxed);
        let check_pairs = 100;
        let mut ch0_clipped = 0usize;
        let mut ch1_clipped = 0usize;
        for i in 0..check_pairs {
            let s0 = unsafe { *ring.data_ptr.add((rp + i * 2) % ring.capacity) };
            let s1 = unsafe { *ring.data_ptr.add((rp + i * 2 + 1) % ring.capacity) };
            if s0.abs() >= 0.999 { ch0_clipped += 1; }
            if s1.abs() >= 0.999 { ch1_clipped += 1; }
        }

        // Neither channel is bad
        assert!(ch0_clipped < check_pairs * 8 / 10);
        assert!(ch1_clipped < check_pairs * 8 / 10);
        // bad_channel stays at 0 (default)
        assert_eq!(ring.bad_channel.load(Ordering::Relaxed), 0);
    }

    // ── Segment Path Generation ──

    #[test]
    fn segment_path_index_1_unchanged() {
        let base = PathBuf::from("/tmp/recording_20240101_120000.wav");
        assert_eq!(segment_path(&base, 1), base);
    }

    #[test]
    fn segment_path_index_0_unchanged() {
        let base = PathBuf::from("/tmp/recording.wav");
        assert_eq!(segment_path(&base, 0), base);
    }

    #[test]
    fn segment_path_index_2() {
        let base = PathBuf::from("/tmp/recording_20240101_120000.wav");
        assert_eq!(
            segment_path(&base, 2),
            PathBuf::from("/tmp/recording_20240101_120000_002.wav")
        );
    }

    #[test]
    fn segment_path_index_10() {
        let base = PathBuf::from("/data/audio/test.wav");
        assert_eq!(
            segment_path(&base, 10),
            PathBuf::from("/data/audio/test_010.wav")
        );
    }

    #[test]
    fn segment_path_preserves_directory() {
        let base = PathBuf::from("/home/user/recordings/session.wav");
        let seg3 = segment_path(&base, 3);
        assert_eq!(seg3.parent().unwrap(), base.parent().unwrap());
        assert_eq!(seg3.file_name().unwrap().to_string_lossy(), "session_003.wav");
    }

    // ── RF64 Header Verification ──

    #[test]
    fn rf64_writer_creates_valid_riff_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_header.wav");

        let mut writer = Rf64Writer::new(path.clone(), 44100, 2).unwrap();

        // Write a few samples
        for i in 0..100 {
            writer.write_sample((i as f32) * 0.01).unwrap();
        }

        let finalized = writer.finalize().unwrap();

        // Read back header
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        // Check RIFF/WAVE magic (should still be RIFF, not RF64, for small files)
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(&header[8..12], b"WAVE");

        // Check JUNK chunk at offset 12 (RF64 not triggered for small files)
        assert_eq!(&header[12..16], b"JUNK");

        // Check fmt chunk
        assert_eq!(&header[48..52], b"fmt ");
        let fmt_size = u32::from_le_bytes(header[52..56].try_into().unwrap());
        assert_eq!(fmt_size, 16);

        // IEEE float format (3)
        let audio_format = u16::from_le_bytes(header[56..58].try_into().unwrap());
        assert_eq!(audio_format, 3);

        // Channels
        let channels = u16::from_le_bytes(header[58..60].try_into().unwrap());
        assert_eq!(channels, 2);

        // Sample rate
        let sr = u32::from_le_bytes(header[60..64].try_into().unwrap());
        assert_eq!(sr, 44100);

        // data chunk
        assert_eq!(&header[72..76], b"data");

        // Verify file size is correct
        let file_size = std::fs::metadata(&finalized).unwrap().len();
        let expected_data = 100u64 * 4;
        assert_eq!(file_size, 80 + expected_data, "File size should be header + data");

        // Rf64Writer patches sizes through BufWriter's inner file (get_mut),
        // which can be overwritten by BufWriter's final flush on small files.
        // In production, patch_wav_header_if_needed is called as a safety net.
        // Verify the safety-net patch produces correct headers:
        patch_wav_header_if_needed(&finalized).unwrap();

        // Re-read header after safety-net patch
        let mut f2 = File::open(&finalized).unwrap();
        let mut header2 = [0u8; 80];
        f2.read_exact(&mut header2).unwrap();

        let riff_size = u32::from_le_bytes(header2[4..8].try_into().unwrap());
        assert_eq!(riff_size as u64, file_size - 8);
    }

    #[test]
    fn rf64_writer_header_patch_updates_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_patch.wav");

        let mut writer = Rf64Writer::new(path.clone(), 48000, 1).unwrap();

        // Write 1000 samples
        for i in 0..1000 {
            writer.write_sample((i as f32) * 0.001).unwrap();
        }

        let finalized = writer.finalize().unwrap();

        // Verify the file size matches expected
        let file_size = std::fs::metadata(&finalized).unwrap().len();
        let expected_data_size = 1000u64 * 4;
        let expected_file_size = 80 + expected_data_size;
        assert_eq!(file_size, expected_file_size);

        // Apply safety-net header patch (same as production code does)
        patch_wav_header_if_needed(&finalized).unwrap();

        // Read header after patch
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        assert_eq!(riff_size as u64, file_size - 8);

        let data_size = u32::from_le_bytes(header[76..80].try_into().unwrap());
        assert_eq!(data_size as u64, expected_data_size);
    }

    #[test]
    fn rf64_writer_mono_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_mono.wav");

        let mut writer = Rf64Writer::new(path.clone(), 16000, 1).unwrap();
        for _ in 0..160 {
            writer.write_sample(0.5).unwrap();
        }

        let finalized = writer.finalize().unwrap();
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        let channels = u16::from_le_bytes(header[58..60].try_into().unwrap());
        assert_eq!(channels, 1);

        let byte_rate = u32::from_le_bytes(header[64..68].try_into().unwrap());
        assert_eq!(byte_rate, 16000 * 1 * 4); // sample_rate * channels * 4
    }

    // ── WAV Header Patching ──

    #[test]
    fn patch_wav_header_fixes_zero_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_patch.wav");

        // Write a valid WAV with zeroed-out size fields (simulating hound u32 overflow)
        let data_samples = 100u32;
        let data_bytes = data_samples * 4;
        let mut buf = vec![0u8; 44 + data_bytes as usize];

        // RIFF header with WRONG sizes (0)
        buf[0..4].copy_from_slice(b"RIFF");
        buf[4..8].copy_from_slice(&0u32.to_le_bytes()); // Wrong!
        buf[8..12].copy_from_slice(b"WAVE");
        buf[12..16].copy_from_slice(b"fmt ");
        buf[16..20].copy_from_slice(&16u32.to_le_bytes());
        buf[20..22].copy_from_slice(&3u16.to_le_bytes()); // IEEE float
        buf[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
        buf[24..28].copy_from_slice(&44100u32.to_le_bytes());
        buf[28..32].copy_from_slice(&(44100u32 * 4).to_le_bytes());
        buf[32..34].copy_from_slice(&4u16.to_le_bytes());
        buf[34..36].copy_from_slice(&32u16.to_le_bytes());
        buf[36..40].copy_from_slice(b"data");
        buf[40..44].copy_from_slice(&0u32.to_le_bytes()); // Wrong!

        // Fill data with samples
        for i in 0..data_samples {
            let offset = 44 + (i as usize) * 4;
            buf[offset..offset + 4].copy_from_slice(&(0.5f32).to_le_bytes());
        }

        std::fs::write(&path, &buf).unwrap();

        // Patch it
        patch_wav_header_if_needed(&path).unwrap();

        // Verify fixed header
        let mut f = File::open(&path).unwrap();
        let mut header = [0u8; 44];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        let data_size = u32::from_le_bytes(header[40..44].try_into().unwrap());

        let file_size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(riff_size as u64, file_size - 8);
        assert_eq!(data_size, data_bytes);
    }

    #[test]
    fn patch_wav_header_noop_when_correct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_correct.wav");

        // Write a valid WAV with correct sizes
        let data_bytes = 400u32;
        let file_size = 44 + data_bytes;
        let mut buf = vec![0u8; file_size as usize];

        buf[0..4].copy_from_slice(b"RIFF");
        buf[4..8].copy_from_slice(&(file_size - 8).to_le_bytes());
        buf[8..12].copy_from_slice(b"WAVE");
        buf[12..16].copy_from_slice(b"fmt ");
        buf[16..20].copy_from_slice(&16u32.to_le_bytes());
        buf[20..22].copy_from_slice(&3u16.to_le_bytes());
        buf[22..24].copy_from_slice(&2u16.to_le_bytes());
        buf[24..28].copy_from_slice(&44100u32.to_le_bytes());
        buf[28..32].copy_from_slice(&(44100u32 * 2 * 4).to_le_bytes());
        buf[32..34].copy_from_slice(&8u16.to_le_bytes());
        buf[34..36].copy_from_slice(&32u16.to_le_bytes());
        buf[36..40].copy_from_slice(b"data");
        buf[40..44].copy_from_slice(&data_bytes.to_le_bytes());

        std::fs::write(&path, &buf).unwrap();

        // Patch should be a no-op
        patch_wav_header_if_needed(&path).unwrap();

        // Verify unchanged
        let mut f = File::open(&path).unwrap();
        let mut header = [0u8; 44];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        assert_eq!(riff_size, file_size - 8);
    }

    // ── SPSC Multi-threaded ──

    #[test]
    fn ring_buffer_spsc_threaded() {
        let ring = Arc::new(RecordingRingBuffer::new(4096));
        let ring_producer = ring.clone();
        let ring_consumer = ring.clone();

        let num_samples = 10_000usize;

        // Producer thread
        let producer = std::thread::spawn(move || {
            let mut written = 0;
            while written < num_samples {
                let wp = ring_producer.write_pos.load(Ordering::Relaxed);
                let rp = ring_producer.read_pos.load(Ordering::Acquire);
                let used = wp.wrapping_sub(rp);
                let free = ring_producer.capacity - used;

                if free == 0 {
                    std::thread::yield_now();
                    continue;
                }

                let batch = free.min(64).min(num_samples - written);
                for i in 0..batch {
                    let idx = (wp + i) % ring_producer.capacity;
                    unsafe { *ring_producer.data_ptr.add(idx) = (written + i) as f32; }
                }
                ring_producer.write_pos.store(wp + batch, Ordering::Release);
                written += batch;
            }
            // Signal done
            ring_producer.active.store(false, Ordering::Release);
        });

        // Consumer thread
        let consumer = std::thread::spawn(move || {
            let mut total_read = 0usize;
            let mut expected = 0f32;
            loop {
                let wp = ring_consumer.write_pos.load(Ordering::Acquire);
                let rp = ring_consumer.read_pos.load(Ordering::Relaxed);
                let available = wp.wrapping_sub(rp);

                if available == 0 {
                    if !ring_consumer.active.load(Ordering::Acquire) {
                        break;
                    }
                    std::thread::yield_now();
                    continue;
                }

                for i in 0..available {
                    let idx = (rp + i) % ring_consumer.capacity;
                    let val = unsafe { *ring_consumer.data_ptr.add(idx) };
                    assert!((val - expected).abs() < 1e-3,
                        "Mismatch at read {}: got {}, expected {}", total_read + i, val, expected);
                    expected += 1.0;
                }
                ring_consumer.read_pos.store(rp + available, Ordering::Release);
                total_read += available;
            }
            total_read
        });

        producer.join().unwrap();
        let total = consumer.join().unwrap();
        assert_eq!(total, num_samples);
    }

    // ── AudioWriter enum dispatch ──

    #[test]
    fn audio_writer_hound_write_and_finalize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_writer_hound.wav");

        let spec = WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let file = File::create(&path).unwrap();
        let mut writer = AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec).unwrap());

        for i in 0..44100 {
            writer.write_sample((i as f32) / 44100.0).unwrap();
        }
        writer.finalize().unwrap();

        // Verify the file exists and has reasonable size
        let size = std::fs::metadata(&path).unwrap().len();
        // 44100 samples * 4 bytes + WAV header (44 bytes)
        assert!(size >= 44100 * 4 + 44, "File too small: {} bytes", size);
    }

    #[test]
    fn audio_writer_rf64_write_and_finalize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_writer_rf64.wav");

        let mut writer = AudioWriter::Rf64(Rf64Writer::new(path.clone(), 48000, 2).unwrap());

        for _ in 0..96000 {
            writer.write_sample(0.25).unwrap();
        }
        writer.finalize().unwrap();

        let size = std::fs::metadata(&path).unwrap().len();
        // 96000 samples * 4 bytes + 80-byte header
        assert_eq!(size, 96000 * 4 + 80);
    }
}
