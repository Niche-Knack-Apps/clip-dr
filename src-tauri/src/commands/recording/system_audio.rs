//! System audio capture (monitoring + recording) for Linux.
//!
//! Extracted from mod.rs to keep the module manageable.
//! Uses parec / pw-record subprocesses to capture system audio output.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::PathBuf;
use std::process::{ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use hound::{WavSpec, WavWriter};
use tauri::State;

use crate::audio_util::{AudioWriter, Rf64Writer, WAV_SEGMENT_MAX_DATA_BYTES};

use super::{
    RecordingManager, RecordingSession,
    segment_path, patch_wav_header_if_needed, stereo_wav_to_mono_streaming,
    estimate_wav_duration, read_wav_format,
    RecordingResult,
};

// ── Helper utilities (pub(crate) for use by diagnostics.rs) ──

#[cfg(target_os = "linux")]
pub(crate) fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub(crate) fn get_default_monitor_source() -> Result<String, String> {
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

// ── Context struct for system audio reader thread ──

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

// ── Internal helpers ──

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

// ── Tauri commands ──

/// Start system audio monitoring (level meter only, no recording)
#[tauri::command]
pub async fn start_system_audio_monitoring(mgr: State<'_, RecordingManager>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        super::stop_monitoring_internal(&mgr);
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

/// Force reset recording state (for recovery from stuck state)
#[tauri::command]
pub fn reset_recording_state(mgr: State<'_, RecordingManager>) {
    reset_recording_state_internal(&mgr);
}

pub(super) fn reset_recording_state_internal(mgr: &RecordingManager) {
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

/// Record system audio using parec/pw-record with stdout streaming (Linux only)
/// Reuses the monitoring capture process -- does NOT spawn a new process.
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

        // Activate recording -- the monitor reader thread will start accumulating samples
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

/// Stop system audio recording and write accumulated samples to WAV file.
/// Does NOT kill the pw-record process -- monitoring continues after recording stops.
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
