use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::panic;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    pub is_loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

// Global recording state
lazy_static::lazy_static! {
    static ref RECORDING_STATE: Arc<Mutex<Option<RecordingState>>> = Arc::new(Mutex::new(None));
    static ref RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref MONITORING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref CURRENT_LEVEL: AtomicU32 = AtomicU32::new(0);
}

struct RecordingState {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    output_path: PathBuf,
}

#[tauri::command]
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Get default input device name for comparison
    let default_input_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    // List input devices from cpal
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                // Skip problematic ALSA devices that cause issues
                let name_lower = name.to_lowercase();
                if name_lower.contains("dmix")
                    || name_lower.contains("surround")
                    || name_lower.contains("iec958")
                    || name_lower.contains("spdif")
                    || name == "null"
                {
                    continue;
                }

                // Try to verify the device can actually be opened for input
                let has_input_config = device.default_input_config().is_ok();
                if !has_input_config {
                    continue;
                }

                let is_default = default_input_name.as_ref() == Some(&name);
                let is_loopback = name_lower.contains("monitor")
                    || name_lower.contains("loopback")
                    || name_lower.contains("stereo mix");

                devices.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_default,
                    is_input: true,
                    is_loopback,
                });
            }
        }
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

                            // Check if we already have this device
                            if !devices.iter().any(|d| d.id == monitor_name) {
                                devices.push(AudioDevice {
                                    id: monitor_name,
                                    name: display_name,
                                    is_default: false,
                                    is_input: true,
                                    is_loopback: true,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!("Found {} audio devices", devices.len());
    for d in &devices {
        log::info!("  Device: {} (loopback: {})", d.name, d.is_loopback);
    }

    Ok(devices)
}

#[tauri::command]
pub async fn start_recording(device_id: Option<String>, output_dir: String) -> Result<String, String> {
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Err("Recording already in progress".to_string());
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
    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    log::info!(
        "Recording config: {} Hz, {} channels, {:?}",
        sample_rate,
        channels,
        config.sample_format()
    );

    // Generate output filename
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.wav", timestamp);
    let output_path = PathBuf::from(&output_dir).join(&filename);

    // Initialize recording state
    {
        let mut state = RECORDING_STATE.lock().unwrap();
        *state = Some(RecordingState {
            samples: Vec::new(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
        });
    }

    RECORDING_ACTIVE.store(true, Ordering::SeqCst);

    // Build stream based on sample format
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_input_stream::<f32>(&device, &config.into())?,
        SampleFormat::I16 => build_input_stream::<i16>(&device, &config.into())?,
        SampleFormat::U16 => build_input_stream::<u16>(&device, &config.into())?,
        _ => return Err("Unsupported sample format".to_string()),
    };

    stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;

    // Keep stream alive by leaking it (will be stopped when recording ends)
    std::mem::forget(stream);

    Ok(output_path.to_string_lossy().to_string())
}

fn build_input_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Recording error: {}", err);
        // Don't panic on stream errors, just log them
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
                    return;
                }

                // Wrap in catch_unwind to prevent ALSA timing panics from crashing
                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    // Convert samples to f32 and calculate level
                    let mut max_level: f32 = 0.0;
                    let samples: Vec<f32> = data
                        .iter()
                        .map(|s| {
                            let f = f32::from_sample(*s);
                            max_level = max_level.max(f.abs());
                            f
                        })
                        .collect();

                    // Update level (convert to 0-1000 range for AtomicU32)
                    let level_int = (max_level * 1000.0) as u32;
                    CURRENT_LEVEL.store(level_int, Ordering::SeqCst);

                    // Append to recording buffer
                    if let Ok(mut state) = RECORDING_STATE.lock() {
                        if let Some(ref mut s) = *state {
                            s.samples.extend(samples);
                        }
                    }
                }));

                if result.is_err() {
                    log::warn!("Audio callback panic caught (ALSA timing issue)");
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {}", e))
}

#[tauri::command]
pub async fn stop_recording() -> Result<RecordingResult, String> {
    if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Err("No recording in progress".to_string());
    }

    RECORDING_ACTIVE.store(false, Ordering::SeqCst);

    // Give the stream a moment to stop
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Extract recording state
    let state = {
        let mut state_guard = RECORDING_STATE.lock().unwrap();
        state_guard.take()
    };

    let state = state.ok_or("Recording state not found")?;

    if state.samples.is_empty() {
        return Err("No audio recorded".to_string());
    }

    // Calculate duration
    let total_samples = state.samples.len();
    let samples_per_channel = total_samples / state.channels as usize;
    let duration = samples_per_channel as f64 / state.sample_rate as f64;

    log::info!(
        "Recording complete: {} samples, {:.2}s duration",
        total_samples,
        duration
    );

    // Write WAV file
    let spec = WavSpec {
        channels: state.channels,
        sample_rate: state.sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let file = File::create(&state.output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let writer = BufWriter::new(file);
    let mut wav_writer = WavWriter::new(writer, spec)
        .map_err(|e| format!("Failed to create WAV writer: {}", e))?;

    for sample in &state.samples {
        wav_writer
            .write_sample(*sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    wav_writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    log::info!("Saved recording to: {:?}", state.output_path);

    Ok(RecordingResult {
        path: state.output_path.to_string_lossy().to_string(),
        duration,
        sample_rate: state.sample_rate,
        channels: state.channels,
    })
}

#[tauri::command]
pub fn get_recording_level() -> f32 {
    let level_int = CURRENT_LEVEL.load(Ordering::SeqCst);
    level_int as f32 / 1000.0
}

#[tauri::command]
pub fn is_recording() -> bool {
    RECORDING_ACTIVE.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_recording() -> Result<(), String> {
    if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Ok(());
    }

    RECORDING_ACTIVE.store(false, Ordering::SeqCst);

    // Clear the recording state without saving
    let mut state = RECORDING_STATE.lock().unwrap();
    *state = None;

    log::info!("Recording cancelled");
    Ok(())
}

/// Start monitoring a device (show levels without recording)
#[tauri::command]
pub async fn start_monitoring(device_id: Option<String>) -> Result<(), String> {
    // Stop any existing monitoring and give the old stream callback time to see the flag
    stop_monitoring_internal();
    std::thread::sleep(std::time::Duration::from_millis(50));

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
    log::info!("Starting monitoring on device: {}", device_name);

    // Get supported config
    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    MONITORING_ACTIVE.store(true, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);

    // Build stream based on sample format
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_monitor_stream::<f32>(&device, &config.into())?,
        SampleFormat::I16 => build_monitor_stream::<i16>(&device, &config.into())?,
        SampleFormat::U16 => build_monitor_stream::<u16>(&device, &config.into())?,
        _ => return Err("Unsupported sample format".to_string()),
    };

    stream.play().map_err(|e| format!("Failed to start monitor stream: {}", e))?;

    // Keep stream alive by leaking it (will stop processing when MONITORING_ACTIVE is false)
    // This is the same approach used for recording streams
    std::mem::forget(stream);

    Ok(())
}

fn build_monitor_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Monitor error: {}", err);
        // Don't panic on stream errors, just log them
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !MONITORING_ACTIVE.load(Ordering::SeqCst) {
                    return;
                }

                // Wrap in catch_unwind to prevent ALSA timing panics from crashing
                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    // Calculate level from samples
                    let mut max_level: f32 = 0.0;
                    for s in data.iter() {
                        let f = f32::from_sample(*s);
                        max_level = max_level.max(f.abs());
                    }

                    // Update level (convert to 0-1000 range for AtomicU32)
                    let level_int = (max_level * 1000.0) as u32;
                    CURRENT_LEVEL.store(level_int, Ordering::SeqCst);
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

fn stop_monitoring_internal() {
    MONITORING_ACTIVE.store(false, Ordering::SeqCst);
    // The stream was leaked with mem::forget, so we can't drop it.
    // The callback will stop processing when MONITORING_ACTIVE is false.
    CURRENT_LEVEL.store(0, Ordering::SeqCst);
}

/// Stop monitoring a device
#[tauri::command]
pub fn stop_monitoring() {
    log::info!("Stopping monitoring");
    stop_monitoring_internal();
}

/// Check if monitoring is active
#[tauri::command]
pub fn is_monitoring() -> bool {
    MONITORING_ACTIVE.load(Ordering::SeqCst)
}

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
