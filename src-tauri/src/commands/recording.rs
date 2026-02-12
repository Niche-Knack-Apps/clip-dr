use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::panic;
use std::path::PathBuf;
use std::process::{ChildStdout, Stdio};
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
    static ref SYSTEM_MONITOR_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref SYSTEM_MONITOR_CHILD: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
    static ref CURRENT_LEVEL: AtomicU32 = AtomicU32::new(0);
    static ref DEBUG_CALLBACK_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static ref RECORDING_EPOCH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    // For streaming system audio - accumulate samples from stdout
    static ref SYSTEM_AUDIO_SAMPLES: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
}

struct RecordingState {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    output_path: PathBuf,
    use_system_buffer: bool,
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
    // Auto-reset any stuck state from previous failed recordings
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        log::warn!("Recording state was stuck, auto-resetting...");
        reset_recording_state();
        std::thread::sleep(std::time::Duration::from_millis(100));
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

    // Score configs: prefer stereo, prefer F32/I16, prefer matching sample rate
    fn config_score(cfg: &cpal::SupportedStreamConfigRange, target_rate: u32) -> i32 {
        let mut score = 0;
        // Prefer stereo for higher-quality recording (transcription handles mono downmix separately)
        if cfg.channels() == 2 { score += 100; }
        else if cfg.channels() == 1 { score += 50; }
        // Prefer good sample formats
        match cfg.sample_format() {
            SampleFormat::F32 => score += 50,
            SampleFormat::I16 => score += 40,
            SampleFormat::I32 => score += 30,
            SampleFormat::F64 => score += 25,
            SampleFormat::U16 => score += 20,
            _ => {} // U8 and others get no bonus
        }
        // Prefer configs that support the target sample rate
        let rate_range = cfg.min_sample_rate().0..=cfg.max_sample_rate().0;
        if rate_range.contains(&target_rate) { score += 10; }
        if rate_range.contains(&44100) { score += 5; }
        score
    }

    let target_rate = default_config.sample_rate().0;
    let best_supported = supported_configs.iter()
        .max_by_key(|cfg| config_score(cfg, target_rate));

    let config = if let Some(best) = best_supported {
        let rate_range = best.min_sample_rate().0..=best.max_sample_rate().0;
        let sample_rate = if rate_range.contains(&target_rate) {
            target_rate
        } else if rate_range.contains(&44100) {
            44100
        } else {
            best.max_sample_rate().0.min(48000)
        };
        let cfg = best.clone().with_sample_rate(cpal::SampleRate(sample_rate));
        log::info!("Selected config: {} ch, {:?}, {} Hz (score: {})",
            cfg.channels(), cfg.sample_format(), sample_rate, config_score(best, target_rate));
        cfg
    } else {
        log::info!("Using default config");
        default_config
    };

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let sample_format = config.sample_format();
    log::info!(
        "Recording config: {} Hz, {} channels, {:?}",
        sample_rate,
        channels,
        sample_format
    );

    // Debug: Log more details about the device config
    log::info!("Buffer size: {:?}", config.buffer_size());

    // Ensure output directory exists
    let output_dir_path = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&output_dir_path)
        .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

    // Generate output filename
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.wav", timestamp);
    let output_path = output_dir_path.join(&filename);

    // Initialize recording state
    {
        let mut state = RECORDING_STATE.lock().unwrap();
        *state = Some(RecordingState {
            samples: Vec::new(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            use_system_buffer: false,
        });
    }

    RECORDING_ACTIVE.store(true, Ordering::SeqCst);
    DEBUG_CALLBACK_COUNT.store(0, Ordering::SeqCst);

    // Increment epoch so any leaked streams from previous recordings stop writing
    let epoch = RECORDING_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;

    // Build stream based on sample format
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_input_stream::<f32>(&device, &config.into(), epoch)?,
        SampleFormat::I16 => build_input_stream::<i16>(&device, &config.into(), epoch)?,
        SampleFormat::U16 => build_input_stream::<u16>(&device, &config.into(), epoch)?,
        SampleFormat::I32 => build_input_stream::<i32>(&device, &config.into(), epoch)?,
        SampleFormat::U8 => build_input_stream::<u8>(&device, &config.into(), epoch)?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;

    // Keep stream alive by leaking it (will be stopped when recording ends)
    std::mem::forget(stream);

    Ok(output_path.to_string_lossy().to_string())
}

fn build_input_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    epoch: usize,
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
                // Check epoch to prevent leaked streams from previous recordings
                // from writing to the current recording's buffer
                if RECORDING_EPOCH.load(Ordering::SeqCst) != epoch {
                    return;
                }

                // Wrap in catch_unwind to prevent ALSA timing panics from crashing
                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    // Convert samples to f32
                    let raw_samples: Vec<f32> = data
                        .iter()
                        .map(|s| f32::from_sample(*s))
                        .collect();

                    // For stereo input, check if one channel is bad (clipped/saturated)
                    // and extract only the good channel if needed
                    let samples: Vec<f32> = if let Ok(state) = RECORDING_STATE.lock() {
                        if let Some(ref s) = *state {
                            if s.channels == 2 && raw_samples.len() >= 20 {
                                // Check first 10 samples of each channel for clipping
                                let mut ch0_clipped = 0;
                                let mut ch1_clipped = 0;
                                for i in 0..10 {
                                    let idx = i * 2;
                                    if idx + 1 < raw_samples.len() {
                                        if raw_samples[idx].abs() >= 0.999 {
                                            ch0_clipped += 1;
                                        }
                                        if raw_samples[idx + 1].abs() >= 0.999 {
                                            ch1_clipped += 1;
                                        }
                                    }
                                }

                                // If one channel is mostly clipped, use only the other
                                if ch0_clipped >= 8 && ch1_clipped < 3 {
                                    // Channel 0 is bad, use channel 1 only
                                    let mono: Vec<f32> = raw_samples.chunks(2)
                                        .filter_map(|chunk| chunk.get(1).copied())
                                        .collect();
                                    let count = DEBUG_CALLBACK_COUNT.load(Ordering::SeqCst);
                                    if count < 3 {
                                        log::info!("Detected bad channel 0, using channel 1 only");
                                    }
                                    // Duplicate to stereo for WAV output
                                    mono.iter().flat_map(|&s| [s, s]).collect()
                                } else if ch1_clipped >= 8 && ch0_clipped < 3 {
                                    // Channel 1 is bad, use channel 0 only
                                    let mono: Vec<f32> = raw_samples.chunks(2)
                                        .filter_map(|chunk| chunk.first().copied())
                                        .collect();
                                    let count = DEBUG_CALLBACK_COUNT.load(Ordering::SeqCst);
                                    if count < 3 {
                                        log::info!("Detected bad channel 1, using channel 0 only");
                                    }
                                    // Duplicate to stereo for WAV output
                                    mono.iter().flat_map(|&s| [s, s]).collect()
                                } else {
                                    raw_samples
                                }
                            } else {
                                raw_samples
                            }
                        } else {
                            raw_samples
                        }
                    } else {
                        raw_samples
                    };

                    // Calculate level
                    let mut max_level: f32 = 0.0;
                    let mut min_sample: f32 = 0.0;
                    let mut max_sample: f32 = 0.0;
                    for &s in &samples {
                        max_level = max_level.max(s.abs());
                        min_sample = min_sample.min(s);
                        max_sample = max_sample.max(s);
                    }

                    // Debug logging every ~1 second
                    let count = DEBUG_CALLBACK_COUNT.fetch_add(1, Ordering::SeqCst);
                    if count % 43 == 0 {
                        log::info!(
                            "Recording callback #{}: {} samples, range [{:.4}, {:.4}], max_level={:.4}",
                            count, samples.len(), min_sample, max_sample, max_level
                        );
                        if samples.len() >= 10 {
                            log::info!(
                                "  First 10 samples: {:.4}, {:.4}, {:.4}, {:.4}, {:.4}, {:.4}, {:.4}, {:.4}, {:.4}, {:.4}",
                                samples[0], samples[1], samples[2], samples[3], samples[4],
                                samples[5], samples[6], samples[7], samples[8], samples[9]
                            );
                        }
                    }

                    // Update level (convert to 0-1000 range for AtomicU32)
                    let level_int = (max_level * 1000.0) as u32;
                    CURRENT_LEVEL.store(level_int, Ordering::SeqCst);

                    // Append to recording buffer
                    if let Ok(mut state) = RECORDING_STATE.lock() {
                        if let Some(ref mut s) = *state {
                            s.samples.extend(samples.iter().copied());
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
    // Also reset any stuck recording state that might interfere
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        log::warn!("Recording state was stuck during monitor start, resetting...");
        reset_recording_state();
    }
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
        SampleFormat::I32 => build_monitor_stream::<i32>(&device, &config.into())?,
        SampleFormat::U8 => build_monitor_stream::<u8>(&device, &config.into())?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
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
/// accumulation (when RECORDING_ACTIVE is true), so a single process
/// serves both monitoring and recording.
#[cfg(target_os = "linux")]
fn start_system_audio_monitoring_impl() -> Result<(), String> {
    // Stop any existing monitoring first
    stop_system_audio_monitoring_internal();
    kill_all_stale_processes();

    let monitor_source = get_default_monitor_source()?;
    log::info!("Starting system audio monitoring with monitor source: {}", monitor_source);

    // Append .monitor for PulseAudio API if not already present
    let pa_monitor = if monitor_source.ends_with(".monitor") {
        monitor_source.clone()
    } else {
        format!("{}.monitor", monitor_source)
    };

    // Try parec first (most reliable), fall back to pw-record
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

    // Store the Child properly for cleanup (not mem::forget)
    *SYSTEM_MONITOR_CHILD.lock().unwrap() = Some(child);
    SYSTEM_MONITOR_ACTIVE.store(true, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);

    // Spawn reader thread: updates level meter always, accumulates samples when recording
    std::thread::spawn(move || {
        system_audio_monitor_reader(stdout);
    });

    log::info!("System audio monitoring started");
    Ok(())
}

/// Start system audio monitoring (level meter only, no recording)
/// Uses parec or pw-record to capture system audio and update CURRENT_LEVEL
#[tauri::command]
pub async fn start_system_audio_monitoring() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        stop_monitoring_internal();
        start_system_audio_monitoring_impl()
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("System audio monitoring only supported on Linux".to_string())
    }
}

/// Stop system audio monitoring
#[tauri::command]
pub fn stop_system_audio_monitoring() {
    log::info!("Stopping system audio monitoring");
    stop_system_audio_monitoring_internal();
}

fn stop_system_audio_monitoring_internal() {
    SYSTEM_MONITOR_ACTIVE.store(false, Ordering::SeqCst);

    if let Ok(mut guard) = SYSTEM_MONITOR_CHILD.lock() {
        if let Some(ref mut child) = *guard {
            log::info!("Killing system audio capture process (pid {})", child.id());
            let _ = child.kill();     // Send SIGKILL
            let _ = child.wait();     // Reap zombie
        }
        *guard = None;
    }

    CURRENT_LEVEL.store(0, Ordering::SeqCst);
}

/// Unified stream reader for system audio: handles both monitoring and recording.
/// Always updates the level meter. When RECORDING_ACTIVE is true, also accumulates
/// samples for the WAV file and feeds the transcription buffer.
#[cfg(target_os = "linux")]
fn system_audio_monitor_reader(stdout: ChildStdout) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while SYSTEM_MONITOR_ACTIVE.load(Ordering::SeqCst) {
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
                CURRENT_LEVEL.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                // When recording is active, accumulate samples
                if RECORDING_ACTIVE.load(Ordering::SeqCst) {
                    if let Ok(mut accumulated) = SYSTEM_AUDIO_SAMPLES.lock() {
                        accumulated.extend(&samples);
                    }

                    DEBUG_CALLBACK_COUNT.fetch_add(1, Ordering::SeqCst);
                }
            }
            Err(_) => break,
        }
    }

    // Signal that monitoring has stopped (reader died or EOF)
    SYSTEM_MONITOR_ACTIVE.store(false, Ordering::SeqCst);
    log::info!("System audio monitor reader finished");
}

/// Force reset recording state (for recovery from stuck state)
#[tauri::command]
pub fn reset_recording_state() {
    log::info!("Force resetting recording state");
    RECORDING_ACTIVE.store(false, Ordering::SeqCst);
    MONITORING_ACTIVE.store(false, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);
    if let Ok(mut state) = RECORDING_STATE.lock() {
        *state = None;
    }
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
/// The monitor reader thread accumulates samples when RECORDING_ACTIVE is set.
#[tauri::command]
pub async fn start_system_audio_recording(output_dir: String) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        // Auto-reset any stuck state from previous failed recordings
        if RECORDING_ACTIVE.load(Ordering::SeqCst) {
            log::warn!("Recording state was stuck, auto-resetting...");
            reset_recording_state();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Ensure system audio monitoring is running (reuse existing pw-record process).
        // The monitor reader thread handles both level metering and sample accumulation.
        if !SYSTEM_MONITOR_ACTIVE.load(Ordering::SeqCst) {
            log::info!("Starting system audio monitoring for recording...");
            start_system_audio_monitoring_impl()?;
        } else {
            log::info!("System audio monitoring already active, reusing for recording");
        }

        // Ensure output directory exists
        let output_dir_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_dir_path)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

        // Generate output filename
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let filename = format!("recording_{}.wav", timestamp);
        let output_path = output_dir_path.join(&filename);

        log::info!("Starting system audio recording to: {:?}", output_path);

        // Clear accumulated samples
        {
            let mut samples = SYSTEM_AUDIO_SAMPLES.lock().unwrap();
            samples.clear();
        }

        // Store recording state
        {
            let mut state = RECORDING_STATE.lock().unwrap();
            *state = Some(RecordingState {
                samples: Vec::new(),
                sample_rate: 44100,
                channels: 2,
                output_path: output_path.clone(),
                use_system_buffer: true,
            });
        }

        // Activate recording — the monitor reader thread will start accumulating samples
        RECORDING_ACTIVE.store(true, Ordering::SeqCst);
        DEBUG_CALLBACK_COUNT.store(0, Ordering::SeqCst);

        log::info!("System audio recording active (reusing monitor process)");
        Ok(output_path.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
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
pub async fn stop_system_audio_recording() -> Result<RecordingResult, String> {
    #[cfg(target_os = "linux")]
    {
        if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
            return Err("No recording in progress".to_string());
        }

        log::info!("Stopping system audio recording...");

        // Signal recording stop — monitor reader stops accumulating but continues level metering
        RECORDING_ACTIVE.store(false, Ordering::SeqCst);

        // Brief pause to let the reader finish any in-flight data
        std::thread::sleep(std::time::Duration::from_millis(100));

        // NOTE: Don't kill the pw-record process — monitoring continues.
        // The process will be killed when the user stops monitoring or leaves the screen.

        // Get recording state
        let state = {
            let mut state_guard = RECORDING_STATE.lock().unwrap();
            state_guard.take()
        };
        let state = state.ok_or("Recording state not found")?;

        // Get accumulated samples
        let samples = {
            let mut samples_guard = SYSTEM_AUDIO_SAMPLES.lock().unwrap();
            std::mem::take(&mut *samples_guard)
        };

        log::info!("Writing {} samples to WAV file: {:?}", samples.len(), state.output_path);

        if samples.is_empty() {
            return Err("No audio recorded".to_string());
        }

        // Write samples to WAV file
        let duration = write_system_audio_wav(&state.output_path, &samples, state.sample_rate, state.channels)?;

        log::info!("System audio recording complete: {:?}, {:.2}s, {} callbacks",
            state.output_path, duration, DEBUG_CALLBACK_COUNT.load(Ordering::SeqCst));

        // Don't reset CURRENT_LEVEL — monitoring is still running and will keep updating it

        Ok(RecordingResult {
            path: state.output_path.to_string_lossy().to_string(),
            duration,
            sample_rate: state.sample_rate,
            channels: state.channels,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("System audio recording only supported on Linux".to_string())
    }
}

/// Write accumulated samples to a WAV file
#[cfg(target_os = "linux")]
fn write_system_audio_wav(path: &PathBuf, samples: &[f32], sample_rate: u32, channels: u16) -> Result<f64, String> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let file = File::create(path)
        .map_err(|e| format!("Failed to create WAV file: {}", e))?;
    let writer = BufWriter::new(file);
    let mut wav_writer = WavWriter::new(writer, spec)
        .map_err(|e| format!("Failed to create WAV writer: {}", e))?;

    for sample in samples {
        wav_writer.write_sample(*sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    wav_writer.finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    // Calculate duration
    let duration = samples.len() as f64 / channels as f64 / sample_rate as f64;
    Ok(duration)
}

#[cfg(target_os = "linux")]
fn get_wav_duration(path: &PathBuf) -> Option<f64> {
    let file = std::fs::File::open(path).ok()?;
    let reader = hound::WavReader::new(file).ok()?;
    let spec = reader.spec();
    let samples = reader.len() as f64;
    Some(samples / spec.channels as f64 / spec.sample_rate as f64)
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

    std::thread::sleep(Duration::from_millis(100));
    drop(stream);

    got_callback.load(Ordering::SeqCst)
}

#[cfg(target_os = "linux")]
fn test_parec(monitor_source: &str) -> Result<String, String> {
    let output = std::process::Command::new("timeout")
        .args(["0.5", "parec", "-d", monitor_source,
               "--format=float32le", "--rate=44100", "--channels=2"])
        .output()
        .map_err(|e| format!("Failed to run parec: {}", e))?;

    if output.stdout.len() > 1000 {
        Ok(format!("Test captured {} bytes", output.stdout.len()))
    } else {
        Err(format!("Captured too little data: {} bytes (stderr: {})",
            output.stdout.len(), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(target_os = "linux")]
fn test_pw_record(sink_name: &str) -> Result<String, String> {
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test.wav");

    // Record for 0.5 seconds
    let _output = std::process::Command::new("timeout")
        .args(["0.5", "pw-record", "--target", sink_name,
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

        if size > 1000 {  // File has some content
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

#[cfg(target_os = "linux")]
fn test_parecord(monitor_source: &str) -> Result<String, String> {
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test_pa.wav");

    // Record for 0.5 seconds
    let _output = std::process::Command::new("timeout")
        .args(["0.5", "parecord", "-d", monitor_source,
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

        if size > 1000 {
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}
