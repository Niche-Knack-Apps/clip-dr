//! System audio capture (monitoring + recording) for Linux.
//!
//! Extracted from mod.rs to keep the module manageable.
//! Uses parec / pw-record subprocesses to capture system audio output.
//!
//! Recording uses the same ring-buffer → wav_writer_thread path as mic
//! recording.  The reader thread always updates the level meter, and
//! when a ring buffer is available (recording active), it pushes
//! interleaved f32 samples there for the writer thread to drain.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::PathBuf;
use std::process::{ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use hound::{WavSpec, WavWriter};
use tauri::State;

use crate::audio_util::{AudioWriter, Rf64Writer};

use super::{
    RecordingManager, RecordingSession, RecordingRingBuffer,
    segment_path, spawn_wav_writer_thread, patch_wav_header_if_needed,
    stereo_wav_to_mono_streaming, estimate_wav_duration, read_wav_format,
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

/// Minimal context for the reader thread.  Level metering always runs;
/// when `ring` contains `Some(ring_buf)`, samples are also pushed there
/// for the writer thread to drain.
struct SysAudioReaderCtx {
    monitor_active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    /// Shared with RecordingManager.system_ring.
    /// Some(ring) when recording is active; None otherwise.
    ring: Arc<Mutex<Option<Arc<RecordingRingBuffer>>>>,
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
/// The reader thread handles level metering (always) and pushes samples
/// into the shared ring buffer when recording is active.
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

    let ctx = SysAudioReaderCtx {
        monitor_active: mgr.system_monitor_active.clone(),
        level: mgr.current_level.clone(),
        ring: mgr.system_ring.clone(),
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

/// Unified stream reader for system audio.
/// Always updates the level meter.  When a ring buffer is available (recording
/// active), pushes interleaved f32 samples into it for the wav writer thread.
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

                // When a ring buffer is available, push samples into it
                if let Ok(guard) = ctx.ring.lock() {
                    if let Some(ref ring) = *guard {
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
                        let fill = wp.wrapping_sub(rp) + samples.len();
                        let _ = ring.max_fill_level.fetch_max(fill, Ordering::Relaxed);
                    }
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

    // Clear system ring so reader thread stops pushing
    if let Ok(mut guard) = mgr.system_ring.lock() { *guard = None; }

    // Drop monitoring stream
    if let Ok(mut guard) = mgr.monitor_stream.lock() { *guard = None; }

    // Clean up all sessions
    if let Ok(mut sessions) = mgr.sessions.lock() {
        for (_, mut session) in sessions.drain() {
            session.active.store(false, Ordering::SeqCst);
            if let Some(mut input) = session.input.take() {
                let _ = input.stop();
            }
            if let Some(ring) = &session.ring_buffer {
                ring.active.store(false, Ordering::Release);
            }
            if let Some(handle) = session.writer_handle.take() {
                let _ = handle.join();
            }
        }
    }
}

/// Record system audio using the ring-buffer path (Linux only).
/// Reuses the monitoring capture process — does NOT spawn a new process.
/// Creates a ring buffer + wav writer thread; the monitor reader thread
/// pushes samples into the ring buffer when it's available.
#[tauri::command]
pub async fn start_system_audio_recording(output_dir: String, channel_mode: Option<String>, large_file_format: Option<String>, mgr: State<'_, RecordingManager>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        // Auto-reset any stuck state from previous failed recordings
        let has_system_session = mgr.sessions.lock()
            .map(|s| s.contains_key("system-audio"))
            .unwrap_or(false);
        if has_system_session {
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

        let target_mono = channel_mode.as_deref() == Some("mono");
        let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
        let use_rf64 = lff == "rf64";

        let sample_rate: u32 = 44100;
        let channels: u16 = 2;

        // Create ring buffer (10s at 44.1kHz stereo)
        let ring = Arc::new(RecordingRingBuffer::new(sample_rate as usize * channels as usize * 10).with_channels(channels));

        // Create WAV writer
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

        // Spawn writer thread (drains ring buffer → disk)
        let writer_handle = spawn_wav_writer_thread(
            ring.clone(), audio_writer, channels, target_mono,
            output_path.clone(), spec, use_rf64,
        );

        // Make ring buffer available to reader thread
        if let Ok(mut guard) = mgr.system_ring.lock() {
            *guard = Some(ring.clone());
        }

        let session_active = Arc::new(AtomicBool::new(true));

        // Store recording state as a session
        let session = RecordingSession {
            input: None,
            ring_buffer: Some(ring),
            writer_handle: Some(writer_handle),
            active: session_active,
            level: mgr.current_level.clone(),
            debug_count: mgr.debug_callback_count.clone(),
            device_id: "system-audio".to_string(),
            sample_rate,
            channels,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            start_offset_us: 0,
            pre_record_seconds: 0.0,
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert("system-audio".to_string(), session);
        }

        mgr.debug_callback_count.store(0, Ordering::SeqCst);

        log::info!("System audio recording active (ring-buffer path, reusing monitor process)");
        Ok(output_path.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (output_dir, channel_mode, large_file_format, mgr);
        Err("System audio recording only supported on Linux".to_string())
    }
}

/// Stop system audio recording and finalize the WAV file.
/// Does NOT kill the subprocess — monitoring continues after recording stops.
#[tauri::command]
pub async fn stop_system_audio_recording(mgr: State<'_, RecordingManager>) -> Result<RecordingResult, String> {
    #[cfg(target_os = "linux")]
    {
        // Take ring from shared state so reader thread stops pushing
        if let Ok(mut guard) = mgr.system_ring.lock() {
            *guard = None;
        }

        // Give the reader thread a moment to finish any in-progress push
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Extract the session
        let session = {
            let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
            sessions.remove("system-audio")
        };
        let mut session = session.ok_or("No system audio recording in progress")?;

        session.active.store(false, Ordering::SeqCst);

        log::info!("Stopping system audio recording...");

        // Signal ring buffer to stop and join writer thread (same path as mic recording)
        let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) =
            (session.ring_buffer.take(), session.writer_handle.take())
        {
            let overruns = ring.overrun_count.load(Ordering::Relaxed);
            let max_fill = ring.max_fill_level.load(Ordering::Relaxed);
            if overruns > 0 {
                log::warn!(
                    "System audio ring buffer had {} overruns (max fill: {}/{})",
                    overruns, max_fill, ring.capacity
                );
            }

            ring.active.store(false, Ordering::Release);
            match handle.join() {
                Ok((w, count, segments)) => (Some(w), count, segments),
                Err(_) => {
                    log::error!("System audio writer thread panicked");
                    return Err("Writer thread panicked".to_string());
                }
            }
        } else {
            return Err("Recording state incomplete".to_string());
        };

        if sample_count == 0 {
            return Err("No audio recorded".to_string());
        }

        let samples_per_channel = sample_count / session.channels as usize;
        let duration = samples_per_channel as f64 / session.sample_rate as f64;

        log::info!("System audio recorded {} samples ({:.2}s)", sample_count, duration);

        // Finalize the writer
        if let Some(w) = writer {
            w.finalize()
                .map_err(|e| format!("Failed to finalize recording: {}", e))?;
        }

        let use_rf64 = session.large_file_format == "rf64";
        let last_seg_path = segment_path(&session.output_path, completed_segments.len() + 1);
        if !use_rf64 {
            let _ = patch_wav_header_if_needed(&last_seg_path);
        }

        // fsync to ensure data is on disk before frontend import
        if let Ok(f) = File::open(&last_seg_path) {
            let _ = f.sync_all();
        }

        // Build extra_segments list
        let extra_segments: Vec<String> = if !completed_segments.is_empty() {
            for seg in &completed_segments {
                if !use_rf64 {
                    let _ = patch_wav_header_if_needed(seg);
                }
                if let Ok(f) = File::open(seg) {
                    let _ = f.sync_all();
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

    patch_wav_header_if_needed(&file_path)
        .map_err(|e| format!("Failed to recover WAV header: {}", e))?;

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
