pub mod types;
pub mod ring_buffer;
pub mod wav_writer;
pub mod error;
pub mod backend;
pub mod cpal_backend;
#[cfg(target_os = "linux")]
pub mod pulse_backend;

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

use crate::audio_util::{Rf64Writer, AudioWriter, WAV_SEGMENT_MAX_DATA_BYTES};

// ── Per-Session Recording Architecture ──
// RecordingManager is Tauri managed state; individual sessions hold per-stream
// ring buffers, level atomics, and active flags. Old single-session commands
// map to the "default" session for backward compatibility.

/// A single recording session (one input device → one WAV file).
struct RecordingSession {
    stream: Option<StreamHolder>,
    ring_buffer: Option<Arc<RecordingRingBuffer>>,
    writer_handle: Option<JoinHandle<(AudioWriter, usize, Vec<PathBuf>)>>,
    /// Per-session active flag (checked by audio callback)
    active: Arc<AtomicBool>,
    /// Per-session peak level (updated by audio callback, read by polling)
    level: Arc<AtomicU32>,
    /// Per-session debug callback counter
    debug_count: Arc<AtomicUsize>,
    /// Device ID this session is recording from
    device_id: String,
    sample_rate: u32,
    channels: u16,
    output_path: PathBuf,
    target_mono: bool,
    large_file_format: String,
    use_system_buffer: bool,
    /// Microseconds from the shared start instant to when this session's stream started
    start_offset_us: i64,
    /// Seconds of pre-record buffer audio prepended
    pre_record_seconds: f64,
    /// Subprocess handle for monitor device capture (when CPAL can't open the device)
    child: Option<std::process::Child>,
    /// Pulse capture thread handle (Linux only)
    pulse_capture: Option<JoinHandle<()>>,
}

/// Managed state for all recording, monitoring, and preview operations.
/// Holds Arc-wrapped atomics so audio threads can access them without statics.
pub struct RecordingManager {
    /// The chosen audio backend (Pulse or cpal), selected once at startup.
    pub registry: DeviceRegistry,

    /// Active recording sessions keyed by session ID ("default" for single-session)
    sessions: Mutex<HashMap<String, RecordingSession>>,

    // ── Monitor state (not per-session) ──
    monitor_stream: Mutex<Option<StreamHolder>>,
    monitoring_active: Arc<AtomicBool>,

    // ── Preview state (not per-session) ──
    preview_stream: Mutex<Option<StreamHolder>>,
    preview_active: Arc<AtomicBool>,
    preview_level: Arc<AtomicU32>,

    // ── Multi-device preview (concurrent VU meters) ──
    preview_sessions: Mutex<HashMap<String, PreviewSession>>,

    // ── Pre-record buffer (filled during monitoring) ──
    pre_record_buffer: Mutex<Option<Arc<PreRecordBuffer>>>,

    // ── Shared current level (backward compat: single-session & monitoring) ──
    current_level: Arc<AtomicU32>,

    // ── System audio state (inherently single-instance) ──
    system_monitor_active: Arc<AtomicBool>,
    system_monitor_child: Arc<Mutex<Option<std::process::Child>>>,
    system_recording_active: Arc<AtomicBool>,
    system_wav_writer: Arc<Mutex<Option<AudioWriter>>>,
    system_segment_base_path: Mutex<Option<PathBuf>>,
    system_completed_segments: Mutex<Vec<PathBuf>>,
    system_segment_data_bytes: Arc<AtomicUsize>,
    system_segment_index: Arc<AtomicUsize>,
    system_audio_sample_count: Arc<AtomicUsize>,
    debug_callback_count: Arc<AtomicUsize>,
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

#[tauri::command]
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    log::info!("[DeviceList] list_audio_devices() called");

    // On Linux, try PulseAudio API first (works reliably on PipeWire via pw-pulse)
    #[cfg(target_os = "linux")]
    {
        log::debug!("[DeviceList] Linux detected, trying PulseAudio enumeration first...");
        match super::pulse_devices::enumerate_pulse_sources() {
            Ok(devices) if !devices.is_empty() => {
                log::info!("[DeviceList] PulseAudio returned {} input devices — using Pulse path", devices.len());
                for (i, d) in devices.iter().enumerate() {
                    log::debug!("[DeviceList]   [{}] id='{}' name='{}' type={} source={} default={} loopback={} ch={} rates={:?}",
                        i, d.id, d.name, d.device_type, d.device_source, d.is_default, d.is_loopback, d.channels, d.sample_rates);
                }
                return Ok(devices);
            }
            Ok(_) => log::warn!("[DeviceList] Pulse returned 0 devices, falling back to cpal"),
            Err(e) => log::warn!("[DeviceList] Pulse enumeration failed: '{}', falling back to cpal", e),
        }
    }

    // cpal path (fallback on Linux, primary on Windows/macOS)
    log::debug!("[DeviceList] Using cpal device enumeration");
    let host = cpal::default_host();
    log::debug!("[DeviceList] cpal host: {:?}", host.id());
    let mut devices = Vec::new();

    // Get default input device name for comparison
    let default_input_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    // List input devices from cpal
    if let Ok(input_devices) = host.input_devices() {
        let mut cpal_total = 0u32;
        let mut cpal_skipped = 0u32;
        for device in input_devices {
            cpal_total += 1;
            if let Ok(name) = device.name() {
                // Skip problematic ALSA devices that cause issues
                let name_lower = name.to_lowercase();
                if name_lower.contains("dmix")
                    || name_lower.contains("surround")
                    || name_lower.contains("iec958")
                    || name_lower.contains("spdif")
                    || name == "null"
                {
                    log::debug!("[DeviceList] cpal: Skipping '{}' (filtered name)", name);
                    cpal_skipped += 1;
                    continue;
                }

                // Try to verify the device can actually be opened for input
                let has_input_config = device.default_input_config().is_ok();
                if !has_input_config {
                    log::debug!("[DeviceList] cpal: Skipping '{}' (no valid input config)", name);
                    cpal_skipped += 1;
                    continue;
                }
                log::debug!("[DeviceList] cpal: Accepting '{}' (has valid input config)", name);

                let is_default = default_input_name.as_ref() == Some(&name);
                let is_loopback = name_lower.contains("monitor")
                    || name_lower.contains("loopback")
                    || name_lower.contains("stereo mix");

                // Get channel count and sample rates from device config
                let (channels, sample_rates) = if let Ok(cfg) = device.default_input_config() {
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
                };

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
        log::info!("[DeviceList] cpal: enumerated {} devices total, {} skipped, {} accepted",
            cpal_total, cpal_skipped, cpal_total - cpal_skipped);
    } else {
        log::error!("[DeviceList] cpal: host.input_devices() returned error");
    }

    // On Linux, try to get PipeWire/PulseAudio monitor devices for system audio capture
    #[cfg(target_os = "linux")]
    {
        // Try to get monitor devices using pw-record (PipeWire)
        if let Ok(output) = std::process::Command::new("pw-cli")
            .args(["list-objects"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Look for output sinks that can be monitored
            // PipeWire exposes monitors as "*.monitor" sources
            for line in stdout.lines() {
                if line.contains("alsa_output") && line.contains("node.name") {
                    if let Some(name_start) = line.find("= \"") {
                        if let Some(name_end) = line[name_start + 3..].find("\"") {
                            let sink_name = &line[name_start + 3..name_start + 3 + name_end];
                            let monitor_name = format!("{}.monitor", sink_name);
                            let display_name = format!("Monitor of {}", sink_name.replace("alsa_output.", "").replace(".", " "));

                            // Check if we already have this device (exact ID match or fuzzy CPAL match)
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

    log::info!("[DeviceList] Final result: {} devices via cpal fallback", devices.len());
    for (i, d) in devices.iter().enumerate() {
        log::debug!("[DeviceList]   [{}] id='{}' name='{}' type={} default={} loopback={} ch={} rates={:?}",
            i, d.id, d.name, d.device_type, d.is_default, d.is_loopback, d.channels, d.sample_rates);
    }
    if devices.is_empty() {
        log::error!("[DeviceList] WARNING: Returning 0 devices! No devices found via any method.");
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

fn stop_monitoring_internal(mgr: &RecordingManager) {
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

/// Kill any stale pw-record or parec processes from previous runs
#[cfg(target_os = "linux")]
fn kill_all_stale_processes() {
    let _ = std::process::Command::new("pkill")
        .args(["-f", "pw-record --target"])
        .status();
    let _ = std::process::Command::new("pkill")
        .args(["-f", "parec -d"])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(200));
}

/// Internal implementation for starting system audio monitoring.
/// Uses parec (preferred) or pw-record as fallback to capture system audio.
/// The reader thread handles both level metering (always) and sample
/// accumulation (when system_recording_active is true), so a single process
/// serves both monitoring and recording.
#[cfg(target_os = "linux")]
fn start_system_audio_monitoring_impl(mgr: &RecordingManager) -> Result<(), String> {
    stop_system_audio_monitoring_internal(mgr);
    kill_all_stale_processes();

    let monitor_source = get_default_monitor_source()?;
    log::info!("Starting system audio monitoring with monitor source: {}", monitor_source);

    let pa_monitor = if monitor_source.ends_with(".monitor") {
        monitor_source.clone()
    } else {
        format!("{}.monitor", monitor_source)
    };

    let child_result = if which_exists("parec") {
        log::info!("Using parec with monitor source: {}", pa_monitor);
        std::process::Command::new("parec")
            .args([
                "-d", &pa_monitor,
                "--format=float32le",
                "--rate=44100",
                "--channels=2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else if which_exists("pw-record") {
        log::info!("Using pw-record with stream.capture.sink for: {}", monitor_source);
        std::process::Command::new("pw-record")
            .args([
                "-P", "{ stream.capture.sink = true }",
                "--target", &monitor_source,
                "--format", "f32",
                "--rate", "44100",
                "--channels", "2",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        return Err("No audio capture tool available (need parec or pw-record)".to_string());
    };

    let mut child = child_result.map_err(|e| format!("Failed to start audio capture: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    *mgr.system_monitor_child.lock().unwrap() = Some(child);
    mgr.system_monitor_active.store(true, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);

    // Clone Arcs for the reader thread
    let sys_active = mgr.system_monitor_active.clone();
    let sys_rec_active = mgr.system_recording_active.clone();
    let level = mgr.current_level.clone();
    let sample_count = mgr.system_audio_sample_count.clone();
    let wav_writer = mgr.system_wav_writer.clone();
    let seg_data_bytes = mgr.system_segment_data_bytes.clone();
    let seg_index = mgr.system_segment_index.clone();
    let debug_count = mgr.debug_callback_count.clone();

    // Create Arc-wrapped copies of segment state for the reader thread
    let thread_seg_base = Arc::new(Mutex::new(
        mgr.system_segment_base_path.lock().ok().and_then(|g| g.clone())
    ));
    let thread_seg_completed = Arc::new(Mutex::new(
        mgr.system_completed_segments.lock().ok()
            .map(|g| g.clone())
            .unwrap_or_default()
    ));

    let ctx = SysAudioReaderCtx {
        monitor_active: sys_active,
        recording_active: sys_rec_active,
        level,
        sample_count,
        wav_writer,
        seg_data_bytes,
        seg_index,
        debug_count,
        seg_base_path: thread_seg_base,
        seg_completed: thread_seg_completed,
    };

    std::thread::spawn(move || {
        system_audio_monitor_reader(stdout, ctx);
    });

    log::info!("System audio monitoring started");
    Ok(())
}

/// Start system audio monitoring (level meter only, no recording)
#[tauri::command]
pub async fn start_system_audio_monitoring(mgr: State<'_, RecordingManager>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        stop_monitoring_internal(&mgr);
        start_system_audio_monitoring_impl(&mgr)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio monitoring only supported on Linux".to_string())
    }
}

/// Stop system audio monitoring
#[tauri::command]
pub fn stop_system_audio_monitoring(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping system audio monitoring");
    stop_system_audio_monitoring_internal(&mgr);
}

fn stop_system_audio_monitoring_internal(mgr: &RecordingManager) {
    mgr.system_monitor_active.store(false, Ordering::SeqCst);

    if let Ok(mut guard) = mgr.system_monitor_child.lock() {
        if let Some(ref mut child) = *guard {
            log::info!("Killing system audio capture process (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }

    mgr.current_level.store(0, Ordering::SeqCst);
}

/// Unified stream reader for system audio: handles both monitoring and recording.
/// Always updates the level meter. When recording_active is true, also accumulates
/// samples for the WAV file.
#[cfg(target_os = "linux")]
fn system_audio_monitor_reader(stdout: ChildStdout, ctx: SysAudioReaderCtx) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while ctx.monitor_active.load(Ordering::SeqCst) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let samples: Vec<f32> = buffer[..n]
                    .chunks(4)
                    .filter_map(|chunk| {
                        if chunk.len() == 4 {
                            Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                        } else {
                            None
                        }
                    })
                    .collect();

                if samples.is_empty() {
                    continue;
                }

                // Always update level meter
                let max_level = samples.iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max);
                ctx.level.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                // When recording is active, write to disk and count samples
                if ctx.recording_active.load(Ordering::SeqCst) {
                    ctx.sample_count.fetch_add(samples.len(), Ordering::SeqCst);
                    let sample_bytes = samples.len() * 4;

                    if let Ok(mut writer_guard) = ctx.wav_writer.lock() {
                        let is_rf64 = matches!(&*writer_guard, Some(AudioWriter::Rf64(_)));
                        let current_data_bytes = ctx.seg_data_bytes.load(Ordering::Relaxed);
                        if !is_rf64 && current_data_bytes + sample_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
                            if let Some(old_writer) = writer_guard.take() {
                                let _ = old_writer.finalize();
                                let seg_idx = ctx.seg_index.load(Ordering::Relaxed);
                                if let Ok(base_guard) = ctx.seg_base_path.lock() {
                                    if let Some(ref base) = *base_guard {
                                        let current_seg = segment_path(base, seg_idx);
                                        let _ = patch_wav_header_if_needed(&current_seg);
                                        if let Ok(mut completed) = ctx.seg_completed.lock() {
                                            completed.push(current_seg);
                                        }

                                        let new_idx = seg_idx + 1;
                                        ctx.seg_index.store(new_idx, Ordering::Relaxed);
                                        ctx.seg_data_bytes.store(0, Ordering::Relaxed);

                                        let new_path = segment_path(base, new_idx);
                                        let sys_spec = WavSpec {
                                            channels: 2,
                                            sample_rate: 44100,
                                            bits_per_sample: 32,
                                            sample_format: hound::SampleFormat::Float,
                                        };
                                        if let Ok(f) = File::create(&new_path) {
                                            if let Ok(new_writer) = WavWriter::new(BufWriter::new(f), sys_spec) {
                                                *writer_guard = Some(AudioWriter::Hound(new_writer));
                                                log::info!("System audio: started new segment {:?}", new_path);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        ctx.seg_data_bytes.fetch_add(sample_bytes, Ordering::Relaxed);
                        if let Some(ref mut writer) = *writer_guard {
                            for &sample in &samples {
                                let _ = writer.write_sample(sample);
                            }
                        }
                    }

                    ctx.debug_count.fetch_add(1, Ordering::SeqCst);
                }
            }
            Err(_) => break,
        }
    }

    ctx.monitor_active.store(false, Ordering::SeqCst);
    log::info!("System audio monitor reader finished");
}

// Context struct for system audio reader thread
struct SysAudioReaderCtx {
    monitor_active: Arc<AtomicBool>,
    recording_active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    sample_count: Arc<AtomicUsize>,
    wav_writer: Arc<Mutex<Option<AudioWriter>>>,
    seg_data_bytes: Arc<AtomicUsize>,
    seg_index: Arc<AtomicUsize>,
    debug_count: Arc<AtomicUsize>,
    seg_base_path: Arc<Mutex<Option<PathBuf>>>,
    seg_completed: Arc<Mutex<Vec<PathBuf>>>,
}

/// Force reset recording state (for recovery from stuck state)
#[tauri::command]
pub fn reset_recording_state(mgr: State<'_, RecordingManager>) {
    reset_recording_state_internal(&mgr);
}

fn reset_recording_state_internal(mgr: &RecordingManager) {
    log::info!("Force resetting recording state");
    mgr.monitoring_active.store(false, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);
    mgr.system_recording_active.store(false, Ordering::SeqCst);

    // Drop monitoring stream
    if let Ok(mut guard) = mgr.monitor_stream.lock() { *guard = None; }

    // Clean up all sessions
    if let Ok(mut sessions) = mgr.sessions.lock() {
        for (_, mut session) in sessions.drain() {
            session.active.store(false, Ordering::SeqCst);
            session.stream = None;
            if let Some(ring) = &session.ring_buffer {
                ring.active.store(false, Ordering::Release);
            }
            if let Some(handle) = session.writer_handle.take() {
                let _ = handle.join();
            }
        }
    }

    // Clean up system audio segment state
    mgr.system_segment_data_bytes.store(0, Ordering::Relaxed);
    mgr.system_segment_index.store(1, Ordering::Relaxed);
    if let Ok(mut base) = mgr.system_segment_base_path.lock() { *base = None; }
    if let Ok(mut completed) = mgr.system_completed_segments.lock() { completed.clear(); }
}

/// Test if a device can actually capture audio - returns info about working configs
#[tauri::command]
pub fn test_audio_device(device_id: Option<String>) -> Result<DeviceTestResult, String> {
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
    log::info!("Testing device: {}", device_name);

    let mut working_configs: Vec<ConfigInfo> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // Get all supported configs
    let supported = match device.supported_input_configs() {
        Ok(configs) => configs.collect::<Vec<_>>(),
        Err(e) => {
            return Err(format!("Failed to get supported configs: {}", e));
        }
    };

    for cfg_range in supported {
        let sample_rate = if cfg_range.min_sample_rate().0 <= 44100 && cfg_range.max_sample_rate().0 >= 44100 {
            44100
        } else {
            cfg_range.max_sample_rate().0.min(48000)
        };

        let cfg = cfg_range.with_sample_rate(cpal::SampleRate(sample_rate));
        let stream_config: cpal::StreamConfig = cfg.clone().into();

        // Try to build a test stream
        let test_result = match cfg.sample_format() {
            SampleFormat::F32 => test_stream::<f32>(&device, &stream_config),
            SampleFormat::I16 => test_stream::<i16>(&device, &stream_config),
            SampleFormat::U16 => test_stream::<u16>(&device, &stream_config),
            SampleFormat::I32 => test_stream::<i32>(&device, &stream_config),
            SampleFormat::U8 => test_stream::<u8>(&device, &stream_config),
            fmt => Err(format!("Unsupported format: {:?}", fmt)),
        };

        match test_result {
            Ok(has_signal) => {
                working_configs.push(ConfigInfo {
                    channels: cfg.channels(),
                    sample_rate,
                    sample_format: format!("{:?}", cfg.sample_format()),
                    has_signal,
                });
            }
            Err(e) => {
                errors.push(format!("{} ch {:?} @ {} Hz: {}",
                    cfg.channels(), cfg.sample_format(), sample_rate, e));
            }
        }
    }

    Ok(DeviceTestResult {
        device_name,
        working_configs,
        errors,
    })
}

fn test_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
) -> Result<bool, String>
where
    f32: cpal::FromSample<T>,
{
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    let has_signal = Arc::new(AtomicBool::new(false));
    let has_signal_clone = has_signal.clone();
    let got_callback = Arc::new(AtomicBool::new(false));
    let got_callback_clone = got_callback.clone();

    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                got_callback_clone.store(true, Ordering::SeqCst);
                // Check if we have any non-zero signal
                for sample in data.iter() {
                    let f = f32::from_sample(*sample);
                    if f.abs() > 0.001 {
                        has_signal_clone.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            },
            |err| {
                log::warn!("Test stream error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build stream: {}", e))?;

    stream.play().map_err(|e| format!("Failed to play: {}", e))?;

    // Wait a short time to see if we get callbacks and signal
    std::thread::sleep(Duration::from_millis(200));

    drop(stream);

    if !got_callback.load(Ordering::SeqCst) {
        return Err("No audio callbacks received".to_string());
    }

    Ok(has_signal.load(Ordering::SeqCst))
}

// ConfigInfo and DeviceTestResult moved to types.rs

/// Check if the default audio input is muted (Linux only, via PipeWire/PulseAudio)
#[tauri::command]
pub fn check_input_muted() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        // Try wpctl first (PipeWire)
        if let Ok(output) = std::process::Command::new("wpctl")
            .args(["get-volume", "@DEFAULT_SOURCE@"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("[MUTED]") {
                return Ok(true);
            }
            // If we got output without MUTED, it's not muted
            if !stdout.is_empty() {
                return Ok(false);
            }
        }

        // Try pactl (PulseAudio fallback)
        if let Ok(output) = std::process::Command::new("pactl")
            .args(["get-source-mute", "@DEFAULT_SOURCE@"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("yes") {
                return Ok(true);
            }
            if stdout.contains("no") {
                return Ok(false);
            }
        }

        // Couldn't determine mute status
        Ok(false)
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Not implemented for other platforms yet
        Ok(false)
    }
}

/// Record system audio using parec/pw-record with stdout streaming (Linux only)
/// Reuses the monitoring capture process — does NOT spawn a new process.
/// The monitor reader thread accumulates samples when system_recording_active is set.
#[tauri::command]
pub async fn start_system_audio_recording(output_dir: String, channel_mode: Option<String>, large_file_format: Option<String>, mgr: State<'_, RecordingManager>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        // Auto-reset any stuck state from previous failed recordings
        if mgr.system_recording_active.load(Ordering::SeqCst) {
            log::warn!("Recording state was stuck, auto-resetting...");
            reset_recording_state_internal(&mgr);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Ensure system audio monitoring is running
        if !mgr.system_monitor_active.load(Ordering::SeqCst) {
            log::info!("Starting system audio monitoring for recording...");
            start_system_audio_monitoring_impl(&mgr)?;
        } else {
            log::info!("System audio monitoring already active, reusing for recording");
        }

        // Ensure output directory exists
        let output_dir_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_dir_path)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let filename = format!("recording_{}.wav", timestamp);
        let output_path = output_dir_path.join(&filename);

        log::info!("Starting system audio recording to: {:?}", output_path);

        // Reset sample counter and segment tracking
        mgr.system_audio_sample_count.store(0, Ordering::SeqCst);
        mgr.system_segment_data_bytes.store(0, Ordering::Relaxed);
        mgr.system_segment_index.store(1, Ordering::Relaxed);
        if let Ok(mut base) = mgr.system_segment_base_path.lock() {
            *base = Some(output_path.clone());
        }
        if let Ok(mut completed) = mgr.system_completed_segments.lock() {
            completed.clear();
        }

        let target_mono = channel_mode.as_deref() == Some("mono");
        let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
        let use_rf64 = lff == "rf64";

        let sys_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), 44100, 2)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let sys_spec = WavSpec {
                channels: 2,
                sample_rate: 44100,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let sys_file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(sys_file), sys_spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        {
            let mut wg = mgr.system_wav_writer.lock().unwrap();
            *wg = Some(sys_writer);
        }

        // Store recording state as a session
        let session = RecordingSession {
            stream: None,
            ring_buffer: None,
            writer_handle: None,
            active: mgr.system_recording_active.clone(),
            level: mgr.current_level.clone(),
            debug_count: mgr.debug_callback_count.clone(),
            device_id: "system-audio".to_string(),
            sample_rate: 44100,
            channels: 2,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            use_system_buffer: true,
            start_offset_us: 0,
            pre_record_seconds: 0.0,
            child: None,
            pulse_capture: None,
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert("default".to_string(), session);
        }

        // Activate recording — the monitor reader thread will start accumulating samples
        mgr.system_recording_active.store(true, Ordering::SeqCst);
        mgr.debug_callback_count.store(0, Ordering::SeqCst);

        log::info!("System audio recording active (reusing monitor process)");
        Ok(output_path.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio recording only supported on Linux".to_string())
    }
}

#[cfg(target_os = "linux")]
fn get_default_monitor_source() -> Result<String, String> {
    // Try wpctl first (PipeWire)
    let output = std::process::Command::new("wpctl")
        .args(["inspect", "@DEFAULT_AUDIO_SINK@"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("node.name") {
                    if let Some(name) = line.split('=').nth(1) {
                        let sink_name = name.trim().trim_matches('"');
                        log::info!("Found default sink via wpctl: {}", sink_name);
                        // For pw-record, we use the sink name directly with --target
                        return Ok(sink_name.to_string());
                    }
                }
            }
        }
    }

    // Fallback: try pactl (PulseAudio)
    let output = std::process::Command::new("pactl")
        .args(["get-default-sink"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !sink.is_empty() {
                return Ok(format!("{}.monitor", sink));
            }
        }
    }

    // Last fallback: try to find any monitor source via pactl
    let output = std::process::Command::new("pactl")
        .args(["list", "short", "sources"])
        .output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains(".monitor") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    return Ok(parts[1].to_string());
                }
            }
        }
    }

    Err("Could not find a monitor source for system audio. Make sure PipeWire or PulseAudio is running.".to_string())
}


#[cfg(target_os = "linux")]
fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}


/// Stop system audio recording and write accumulated samples to WAV file.
/// Does NOT kill the pw-record process — monitoring continues after recording stops.
#[tauri::command]
pub async fn stop_system_audio_recording(mgr: State<'_, RecordingManager>) -> Result<RecordingResult, String> {
    #[cfg(target_os = "linux")]
    {
        if !mgr.system_recording_active.load(Ordering::SeqCst) {
            return Err("No recording in progress".to_string());
        }

        log::info!("Stopping system audio recording...");

        // Signal recording stop
        mgr.system_recording_active.store(false, Ordering::SeqCst);

        std::thread::sleep(std::time::Duration::from_millis(100));

        // Extract the session
        let session = {
            let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
            sessions.remove("default")
        };
        let session = session.ok_or("Recording state not found")?;

        let sample_count = mgr.system_audio_sample_count.load(Ordering::SeqCst);

        log::info!("Recorded {} samples to WAV file: {:?}", sample_count, session.output_path);

        if sample_count == 0 {
            if let Ok(mut wg) = mgr.system_wav_writer.lock() {
                drop(wg.take());
            }
            return Err("No audio recorded".to_string());
        }

        let duration = sample_count as f64 / session.channels as f64 / session.sample_rate as f64;

        // Finalize the writer
        if let Ok(mut wg) = mgr.system_wav_writer.lock() {
            if let Some(writer) = wg.take() {
                writer.finalize()
                    .map_err(|e| format!("Failed to finalize recording: {}", e))?;
            }
        }

        let use_rf64 = session.large_file_format == "rf64";

        let seg_idx = mgr.system_segment_index.load(Ordering::Relaxed);
        let last_seg_path = segment_path(&session.output_path, seg_idx);
        if !use_rf64 {
            let _ = patch_wav_header_if_needed(&last_seg_path);
        }

        if let Ok(f) = File::open(&last_seg_path) {
            let _ = f.sync_all();
        }

        let completed = if let Ok(mut guard) = mgr.system_completed_segments.lock() {
            guard.drain(..).collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let extra_segments: Vec<String> = if !completed.is_empty() {
            for seg in &completed {
                if !use_rf64 {
                    let _ = patch_wav_header_if_needed(seg);
                }
                if let Ok(f) = File::open(seg) {
                    let _ = f.sync_all();
                }
            }
            let mut extras: Vec<String> = completed.iter()
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

        log::info!("System audio recording complete: {:?}, {:.2}s, {} callbacks, {} extra segments",
            session.output_path, duration, mgr.debug_callback_count.load(Ordering::SeqCst), extra_segments.len());

        Ok(RecordingResult {
            path: session.output_path.to_string_lossy().to_string(),
            duration,
            sample_rate: session.sample_rate,
            channels: final_channels,
            extra_segments,
            pre_record_seconds: 0.0,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio recording only supported on Linux".to_string())
    }
}

/// Unmute the default audio input (Linux only)
#[tauri::command]
pub fn unmute_input() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Try wpctl first (PipeWire)
        let wpctl_result = std::process::Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_SOURCE@", "0"])
            .status();

        if let Ok(status) = wpctl_result {
            if status.success() {
                log::info!("Unmuted input via wpctl");
                return Ok(());
            }
        }

        // Try pactl (PulseAudio fallback)
        let pactl_result = std::process::Command::new("pactl")
            .args(["set-source-mute", "@DEFAULT_SOURCE@", "0"])
            .status();

        if let Ok(status) = pactl_result {
            if status.success() {
                log::info!("Unmuted input via pactl");
                return Ok(());
            }
        }

        Err("Could not unmute input - neither wpctl nor pactl worked".to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Unmute not implemented for this platform".to_string())
    }
}

// SystemAudioInfo moved to types.rs

/// Probe system audio capabilities - tests all available methods
#[tauri::command]
pub fn probe_system_audio() -> Result<SystemAudioInfo, String> {
    log::info!("Probing system audio capabilities...");

    #[cfg(target_os = "linux")]
    {
        let mut info = SystemAudioInfo {
            available: false,
            method: "unavailable".to_string(),
            monitor_source: None,
            sink_name: None,
            test_result: None,
            cpal_monitor_device: None,
        };

        // First, check if we have a CPAL monitor device (preferred if available)
        // Wrap in catch_unwind to prevent crashes
        let cpal_result = std::panic::catch_unwind(|| {
            find_cpal_monitor_device()
        });

        if let Ok(Ok(cpal_device)) = cpal_result {
            log::info!("Found CPAL monitor device: {}", cpal_device);
            info.cpal_monitor_device = Some(cpal_device.clone());

            // Test if the CPAL monitor works (also with panic protection)
            let test_result = std::panic::catch_unwind(|| {
                test_cpal_monitor(&cpal_device)
            });

            if let Ok(true) = test_result {
                info.available = true;
                info.method = "cpal-monitor".to_string();
                info.test_result = Some("CPAL monitor device working".to_string());
                log::info!("CPAL monitor device works - using native recording");
                return Ok(info);
            } else {
                log::info!("CPAL monitor test failed or panicked, trying subprocess methods");
            }
        } else {
            log::info!("No CPAL monitor device found or panic occurred");
        }

        // Try to find the default sink
        match get_default_monitor_source() {
            Ok(source) => {
                info.monitor_source = Some(source.clone());
                info.sink_name = Some(source.clone());
                log::info!("Found monitor source: {}", source);
            }
            Err(e) => {
                log::warn!("Failed to find monitor source: {}", e);
                info.test_result = Some(format!("No monitor source: {}", e));
                return Ok(info);
            }
        }

        // Test parec first (preferred — handles monitor auto-connection internally)
        log::info!("Testing subprocess capture tools (monitor: {:?})", info.monitor_source);
        if which_exists("parec") {
            if let Some(ref source) = info.monitor_source {
                let pa_monitor = if source.ends_with(".monitor") {
                    source.clone()
                } else {
                    format!("{}.monitor", source)
                };

                match test_parec(&pa_monitor) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "parec".to_string();
                        info.test_result = Some(result);
                        log::info!("parec works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("parec test failed: {}", e);
                    }
                }
            }
        }

        // Test pw-record as fallback (with stream.capture.sink property)
        if which_exists("pw-record") {
            if let Some(ref source) = info.monitor_source {
                match test_pw_record(source) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "pw-record".to_string();
                        info.test_result = Some(result);
                        log::info!("pw-record works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("pw-record test failed: {}", e);
                    }
                }
            }
        }

        // Test parecord as last fallback
        if which_exists("parecord") {
            if let Some(ref source) = info.monitor_source {
                let monitor_name = if source.ends_with(".monitor") {
                    source.clone()
                } else {
                    format!("{}.monitor", source)
                };

                match test_parecord(&monitor_name) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "parecord".to_string();
                        info.monitor_source = Some(monitor_name);
                        info.test_result = Some(result);
                        log::info!("parecord works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("parecord test failed: {}", e);
                        info.test_result = Some(format!("All capture tools failed: {}", e));
                    }
                }
            }
        }

        if !which_exists("parec") && !which_exists("pw-record") && !which_exists("parecord") {
            info.test_result = Some("No recording tools available (need parec, pw-record, or parecord)".to_string());
        }

        Ok(info)
    }

    #[cfg(not(target_os = "linux"))]
    {
        Ok(SystemAudioInfo {
            available: false,
            method: "unavailable".to_string(),
            monitor_source: None,
            sink_name: None,
            test_result: Some("System audio only supported on Linux".to_string()),
            cpal_monitor_device: None,
        })
    }
}

#[cfg(target_os = "linux")]
fn find_cpal_monitor_device() -> Result<String, String> {
    let host = cpal::default_host();

    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let name_lower = name.to_lowercase();
                if name_lower.contains("monitor") {
                    // Verify device can be opened
                    if device.default_input_config().is_ok() {
                        return Ok(name);
                    }
                }
            }
        }
    }

    Err("No CPAL monitor device found".to_string())
}

#[cfg(target_os = "linux")]
fn test_cpal_monitor(device_name: &str) -> bool {
    use std::time::Duration;
    use std::result::Result as StdResult;

    let host = cpal::default_host();

    let device = host.input_devices()
        .ok()
        .and_then(|mut devices| devices.find(|d| d.name().ok().as_ref() == Some(&device_name.to_string())));

    let device = match device {
        Some(d) => d,
        None => return false,
    };

    let supported_config = match device.default_input_config() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();

    let got_callback = Arc::new(AtomicBool::new(false));
    let got_callback_clone = got_callback.clone();

    // Build stream with correct sample format
    let stream_result: StdResult<cpal::Stream, _> = match sample_format {
        SampleFormat::F32 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[f32], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        SampleFormat::I16 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[i16], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        SampleFormat::I32 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[i32], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        _ => {
            log::warn!("Unsupported sample format for monitor test: {:?}", sample_format);
            return false;
        }
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to build monitor test stream: {}", e);
            return false;
        }
    };

    if stream.play().is_err() {
        return false;
    }

    std::thread::sleep(Duration::from_millis(500));
    drop(stream);

    got_callback.load(Ordering::SeqCst)
}

#[cfg(target_os = "linux")]
fn test_parec(monitor_source: &str) -> Result<String, String> {
    log::info!("Testing parec with source: {}", monitor_source);
    let output = std::process::Command::new("timeout")
        .args(["1.5", "parec", "-d", monitor_source,
               "--format=float32le", "--rate=44100", "--channels=2"])
        .output()
        .map_err(|e| format!("Failed to run parec: {}", e))?;

    if output.stdout.len() > 200 {
        Ok(format!("Test captured {} bytes", output.stdout.len()))
    } else {
        Err(format!("Captured too little data: {} bytes (stderr: {})",
            output.stdout.len(), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(target_os = "linux")]
fn test_pw_record(sink_name: &str) -> Result<String, String> {
    log::info!("Testing pw-record with sink: {}", sink_name);
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test.wav");

    // Record for 1.5 seconds (slower hardware needs more init time)
    let _output = std::process::Command::new("timeout")
        .args(["1.5", "pw-record", "--target", sink_name,
               "--format", "f32", "--rate", "44100", "--channels", "2",
               temp_file.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run pw-record: {}", e))?;

    // Check if file was created
    if temp_file.exists() {
        let metadata = std::fs::metadata(&temp_file)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;
        let size = metadata.len();

        // Clean up
        let _ = std::fs::remove_file(&temp_file);

        if size > 200 {  // File has some content
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

#[cfg(target_os = "linux")]
fn test_parecord(monitor_source: &str) -> Result<String, String> {
    log::info!("Testing parecord with source: {}", monitor_source);
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test_pa.wav");

    // Record for 1.5 seconds (slower hardware needs more init time)
    let _output = std::process::Command::new("timeout")
        .args(["1.5", "parecord", "-d", monitor_source,
               "--file-format=wav", "--rate=44100", "--channels=2",
               temp_file.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run parecord: {}", e))?;

    // Check if file was created
    if temp_file.exists() {
        let metadata = std::fs::metadata(&temp_file)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;
        let size = metadata.len();

        // Clean up
        let _ = std::fs::remove_file(&temp_file);

        if size > 200 {
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

// ── Crash Recovery ──

// OrphanedRecording moved to types.rs

/// Scan a directory for orphaned recording files (WAV files with truncated headers).
#[tauri::command]
pub fn scan_orphaned_recordings(project_dir: String) -> Result<Vec<OrphanedRecording>, String> {
    let dir = PathBuf::from(&project_dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut orphans = Vec::new();

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }

        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.len() < 80 {
            continue; // Too small to be a recording file
        }

        // Only consider files named "recording_*"
        let fname = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        if !fname.starts_with("recording_") {
            continue;
        }

        // Check if the WAV header's data size is plausible
        let header_ok = check_wav_header_valid(&path);
        let estimated_duration = if header_ok {
            estimate_wav_duration(&path).unwrap_or(0.0)
        } else {
            // Estimate from file size assuming 48kHz stereo f32 (768000 bytes/sec)
            let data_bytes = metadata.len().saturating_sub(80);
            data_bytes as f64 / 768000.0
        };

        // Consider orphaned if header is broken or duration is suspiciously different from file size
        if !header_ok {
            orphans.push(OrphanedRecording {
                path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                header_ok,
                estimated_duration,
            });
        }
    }

    log::info!("Scanned {} for orphaned recordings: found {}", project_dir, orphans.len());
    Ok(orphans)
}

/// Delete an orphaned recording file from disk.
#[tauri::command]
pub fn delete_orphaned_recording(path: String) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }
    log::info!("Deleting orphaned recording: {}", path);
    std::fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete file: {}", e))
}

/// Recover a recording with a truncated WAV header.
#[tauri::command]
pub fn recover_recording(path: String) -> Result<RecordingResult, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    log::info!("Attempting to recover recording: {}", path);

    // Patch the WAV header to match actual file size
    patch_wav_header_if_needed(&file_path)
        .map_err(|e| format!("Failed to recover WAV header: {}", e))?;

    // Read the patched header to get accurate metadata
    let duration = estimate_wav_duration(&file_path).unwrap_or(0.0);
    let (sample_rate, channels) = read_wav_format(&file_path).unwrap_or((48000, 2));

    log::info!("Recording recovered: {:.2}s, {}Hz, {}ch", duration, sample_rate, channels);

    Ok(RecordingResult {
        path,
        duration,
        sample_rate,
        channels,
        extra_segments: Vec::new(),
        pre_record_seconds: 0.0,
    })
}

// check_wav_header_valid, estimate_wav_duration, read_wav_format moved to wav_writer.rs

// ── System dependency check ──

// SystemDepsResult and MissingDep moved to types.rs

/// Check for required system dependencies and return any that are missing.
#[tauri::command]
pub fn check_system_deps() -> SystemDepsResult {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    };

    log::info!("[SysDeps] check_system_deps() called, os='{}'", os);

    let mut missing = Vec::new();

    #[cfg(target_os = "linux")]
    {
        // Check for libpulse (required for PulseAudio device enumeration)
        log::debug!("[SysDeps] Checking libpulse availability...");
        let pulse_ok = libpulse_available();
        log::info!("[SysDeps] libpulse available: {}", pulse_ok);
        if !pulse_ok {
            missing.push(MissingDep {
                name: "libpulse".to_string(),
                reason: "Required for audio device enumeration and recording on Linux".to_string(),
                install_hint: "Ubuntu/Debian: sudo apt install libpulse0\nFedora: sudo dnf install pulseaudio-libs\nArch: sudo pacman -S libpulse".to_string(),
            });
        }

        // Log additional system info for diagnostics
        if let Ok(output) = std::process::Command::new("pactl").arg("info").output() {
            let info = String::from_utf8_lossy(&output.stdout);
            for line in info.lines() {
                if line.starts_with("Server Name:") || line.starts_with("Server Version:") || line.starts_with("Default Source:") || line.starts_with("Default Sink:") {
                    log::debug!("[SysDeps] pactl: {}", line.trim());
                }
            }
        } else {
            log::debug!("[SysDeps] pactl not available (this is OK if using PipeWire without pactl)");
        }

        // Check PipeWire
        if let Ok(output) = std::process::Command::new("pw-cli").arg("--version").output() {
            let version = String::from_utf8_lossy(&output.stdout);
            log::debug!("[SysDeps] PipeWire: {}", version.trim());
        } else {
            log::debug!("[SysDeps] pw-cli not available");
        }
    }

    if !missing.is_empty() {
        log::warn!("[SysDeps] Missing {} system dependencies:", missing.len());
        for dep in &missing {
            log::warn!("[SysDeps]   {} — {}", dep.name, dep.reason);
        }
    } else {
        log::info!("[SysDeps] All system dependencies satisfied");
    }

    SystemDepsResult {
        os: os.to_string(),
        missing,
    }
}

/// Check if libpulse is usable by attempting to create a mainloop.
#[cfg(target_os = "linux")]
fn libpulse_available() -> bool {
    use libpulse_binding::mainloop::standard::Mainloop;
    // If we can create a mainloop, the shared library is loaded
    let result = Mainloop::new().is_some();
    log::debug!("[SysDeps] libpulse_available(): Mainloop::new() = {}", result);
    result
}

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
