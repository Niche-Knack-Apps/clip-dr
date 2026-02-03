use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use rubato::{SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction, Resampler};

use super::transcribe::Word;

/// Configuration for streaming transcription
#[derive(Debug, Clone)]
pub struct StreamingConfig {
    pub chunk_duration_secs: f32,  // 5.0
    pub overlap_secs: f32,         // 0.5
}

impl Default for StreamingConfig {
    fn default() -> Self {
        Self {
            chunk_duration_secs: 5.0,
            overlap_secs: 0.5,
        }
    }
}

/// Partial transcription result emitted during recording
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTranscription {
    pub words: Vec<Word>,
    pub chunk_index: usize,
    pub is_final: bool,
}

// Global state for sharing audio between recording and transcription threads
lazy_static::lazy_static! {
    pub static ref TRANSCRIPTION_BUFFER: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    pub static ref BUFFER_SAMPLE_COUNT: AtomicUsize = AtomicUsize::new(0);
    pub static ref TRANSCRIPTION_ENABLED: AtomicBool = AtomicBool::new(false);
    pub static ref RECORDING_SAMPLE_RATE: AtomicU32 = AtomicU32::new(44100);
    pub static ref RECORDING_CHANNELS: AtomicU16 = AtomicU16::new(1);
}

// Maximum buffer size to prevent memory issues during long recordings
// 10 minutes at 48kHz stereo (worst case source rate)
const MAX_BUFFER_SAMPLES: usize = 48000 * 60 * 10 * 2;

/// Clear the transcription buffer and reset state
pub fn clear_transcription_buffer() {
    if let Ok(mut buf) = TRANSCRIPTION_BUFFER.lock() {
        buf.clear();
    }
    BUFFER_SAMPLE_COUNT.store(0, Ordering::SeqCst);
}

/// Append samples to the transcription buffer (called from recording thread)
pub fn append_to_transcription_buffer(samples: &[f32]) {
    if !TRANSCRIPTION_ENABLED.load(Ordering::SeqCst) {
        return;
    }

    // Use try_lock to avoid blocking the audio thread
    if let Ok(mut buf) = TRANSCRIPTION_BUFFER.try_lock() {
        buf.extend_from_slice(samples);
        BUFFER_SAMPLE_COUNT.fetch_add(samples.len(), Ordering::SeqCst);
    }
}

/// Set the recording format for resampling
pub fn set_recording_format(sample_rate: u32, channels: u16) {
    RECORDING_SAMPLE_RATE.store(sample_rate, Ordering::SeqCst);
    RECORDING_CHANNELS.store(channels, Ordering::SeqCst);
}

/// Resample audio to 16kHz mono (required by whisper)
fn resample_to_16khz(samples: &[f32], source_rate: u32, channels: u16) -> Vec<f32> {
    // 1. Mix to mono
    let mono: Vec<f32> = if channels > 1 {
        samples.chunks(channels as usize)
            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        samples.to_vec()
    };

    // 2. Resample using rubato
    if source_rate == 16000 {
        return mono;
    }

    // If we don't have enough samples, just return what we have with simple resampling
    if mono.len() < 256 {
        let ratio = 16000.0 / source_rate as f64;
        let new_len = (mono.len() as f64 * ratio) as usize;
        let mut resampled = Vec::with_capacity(new_len);
        for i in 0..new_len {
            let src_pos = i as f64 / ratio;
            let src_idx = src_pos as usize;
            if src_idx < mono.len() {
                resampled.push(mono[src_idx]);
            }
        }
        return resampled;
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let resample_ratio = 16000.0 / source_rate as f64;

    match SincFixedIn::<f32>::new(
        resample_ratio,
        2.0,
        params,
        mono.len(),
        1,
    ) {
        Ok(mut resampler) => {
            let waves_in = vec![mono];
            match resampler.process(&waves_in, None) {
                Ok(waves_out) => waves_out.into_iter().next().unwrap_or_default(),
                Err(e) => {
                    log::warn!("Resampling failed: {}, using simple resampling", e);
                    simple_resample(&waves_in[0], source_rate, 16000)
                }
            }
        }
        Err(e) => {
            log::warn!("Failed to create resampler: {}, using simple resampling", e);
            let mono_ref: Vec<f32> = samples.chunks(channels as usize)
                .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                .collect();
            simple_resample(&mono_ref, source_rate, 16000)
        }
    }
}

/// Simple linear resampling fallback
fn simple_resample(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    let ratio = target_rate as f64 / source_rate as f64;
    let new_len = (samples.len() as f64 * ratio) as usize;
    let mut resampled = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_pos = i as f64 / ratio;
        let src_idx = src_pos as usize;
        let frac = src_pos - src_idx as f64;

        if src_idx + 1 < samples.len() {
            let sample = samples[src_idx] * (1.0 - frac as f32)
                + samples[src_idx + 1] * frac as f32;
            resampled.push(sample);
        } else if src_idx < samples.len() {
            resampled.push(samples[src_idx]);
        }
    }

    resampled
}

/// Extract words from whisper state after transcription
fn extract_words_from_state(
    state: &whisper_rs::WhisperState,
    chunk_index: usize,
    time_offset: f64,
) -> Vec<Word> {
    let num_segments = match state.full_n_segments() {
        Ok(n) => n,
        Err(_) => return Vec::new(),
    };

    let mut words = Vec::new();

    for i in 0..num_segments {
        let segment_text = match state.full_get_segment_text(i) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let start_time = state.full_get_segment_t0(i).unwrap_or(0) as f64 / 100.0 + time_offset;
        let end_time = state.full_get_segment_t1(i).unwrap_or(0) as f64 / 100.0 + time_offset;

        // Get number of tokens
        let num_tokens = state.full_n_tokens(i).unwrap_or(0);

        let mut segment_words: Vec<(String, f64, f64)> = Vec::new();
        let mut current_word = String::new();
        let mut word_start: Option<f64> = None;
        let mut word_end = start_time;

        for j in 0..num_tokens {
            let token_text = state.full_get_token_text(i, j).unwrap_or_default();
            let token_data = state.full_get_token_data(i, j).ok();

            let starts_new_word = token_text.starts_with(' ') || token_text.starts_with('\n');

            if starts_new_word && !current_word.is_empty() {
                if let Some(start) = word_start {
                    segment_words.push((current_word.clone(), start, word_end));
                }
                current_word.clear();
                word_start = None;
            }

            if let Some(data) = token_data {
                let t = data.t0 as f64 / 100.0 + time_offset;
                if word_start.is_none() && !token_text.trim().is_empty() {
                    word_start = Some(t);
                }
                word_end = data.t1 as f64 / 100.0 + time_offset;
            }

            let trimmed = token_text.trim();
            if !trimmed.is_empty() {
                if current_word.is_empty() {
                    current_word = trimmed.to_string();
                } else {
                    current_word.push_str(trimmed);
                }
            }
        }

        // Don't forget the last word
        if !current_word.is_empty() {
            if let Some(start) = word_start {
                segment_words.push((current_word, start, word_end));
            }
        }

        // Fallback: split segment by whitespace if no word-level timestamps
        if segment_words.is_empty() && !segment_text.trim().is_empty() {
            let text_words: Vec<&str> = segment_text.split_whitespace().collect();
            let duration = end_time - start_time;
            let word_duration = if !text_words.is_empty() {
                duration / text_words.len() as f64
            } else {
                duration
            };

            for (j, word_text) in text_words.iter().enumerate() {
                let w_start = start_time + (j as f64 * word_duration);
                let w_end = start_time + ((j + 1) as f64 * word_duration);
                segment_words.push((word_text.to_string(), w_start, w_end));
            }
        }

        // Convert to Word structs
        for (text, start, end) in segment_words {
            words.push(Word {
                id: format!("live-{}-{}", chunk_index, words.len()),
                text,
                start,
                end,
                confidence: 0.9,
            });
        }
    }

    words
}

/// Prune the buffer to prevent unbounded memory growth
fn maybe_prune_buffer(processed_up_to: &mut usize) {
    let mut buf = match TRANSCRIPTION_BUFFER.lock() {
        Ok(b) => b,
        Err(_) => return,
    };

    if buf.len() > MAX_BUFFER_SAMPLES {
        let drain_count = buf.len() / 2;
        buf.drain(0..drain_count);
        *processed_up_to = processed_up_to.saturating_sub(drain_count);
        BUFFER_SAMPLE_COUNT.store(buf.len(), Ordering::SeqCst);
        log::info!("Pruned transcription buffer, {} samples remaining", buf.len());
    }
}

/// Main transcription worker thread function
fn transcription_worker(
    app_handle: AppHandle,
    model_path: PathBuf,
    config: StreamingConfig,
) {
    log::info!("Starting transcription worker with model: {:?}", model_path);

    // Load whisper context (once, reuse for all chunks)
    let ctx = match WhisperContext::new_with_params(
        model_path.to_str().unwrap_or(""),
        WhisperContextParameters::default(),
    ) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to load whisper model: {}", e);
            return;
        }
    };

    let mut state = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to create whisper state: {}", e);
            return;
        }
    };

    let chunk_samples_16k = (config.chunk_duration_secs * 16000.0) as usize;
    let mut processed_up_to: usize = 0;
    let mut chunk_index: usize = 0;
    let mut total_processed_seconds: f64 = 0.0;

    log::info!("Transcription worker ready, chunk size: {} samples at 16kHz", chunk_samples_16k);

    while TRANSCRIPTION_ENABLED.load(Ordering::SeqCst) {
        let current_count = BUFFER_SAMPLE_COUNT.load(Ordering::SeqCst);
        let sample_rate = RECORDING_SAMPLE_RATE.load(Ordering::SeqCst);
        let channels = RECORDING_CHANNELS.load(Ordering::SeqCst);

        // Calculate source samples needed for one chunk
        let ratio = sample_rate as f64 / 16000.0;
        let source_samples_needed = (chunk_samples_16k as f64 * ratio) as usize * channels as usize;

        if current_count >= processed_up_to + source_samples_needed {
            // Get samples from buffer
            let samples = {
                let buf = match TRANSCRIPTION_BUFFER.lock() {
                    Ok(b) => b,
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                };
                buf[processed_up_to..current_count.min(processed_up_to + source_samples_needed * 2)].to_vec()
            };

            if samples.is_empty() {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }

            // Resample to 16kHz mono
            let audio_16k = resample_to_16khz(&samples, sample_rate, channels);

            if audio_16k.len() < 1600 { // Less than 0.1s
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }

            // Run whisper
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("en"));
            params.set_token_timestamps(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);

            match state.full(params, &audio_16k) {
                Ok(_) => {
                    // Extract words and emit event
                    let words = extract_words_from_state(&state, chunk_index, total_processed_seconds);

                    if !words.is_empty() {
                        log::info!("Chunk {} transcribed: {} words", chunk_index, words.len());

                        let _ = app_handle.emit("transcription-partial", PartialTranscription {
                            words,
                            chunk_index,
                            is_final: false,
                        });
                    }
                }
                Err(e) => {
                    log::warn!("Transcription failed for chunk {}: {}", chunk_index, e);
                }
            }

            // Calculate how much time we processed
            let processed_seconds = audio_16k.len() as f64 / 16000.0;
            let overlap_seconds = config.overlap_secs as f64;

            // Advance with overlap
            let overlap_source = (config.overlap_secs * sample_rate as f32) as usize * channels as usize;
            let advance = source_samples_needed.saturating_sub(overlap_source);
            processed_up_to += advance;
            total_processed_seconds += processed_seconds - overlap_seconds;
            chunk_index += 1;

            // Check if we need to prune the buffer
            maybe_prune_buffer(&mut processed_up_to);
        }

        std::thread::sleep(Duration::from_millis(100));
    }

    log::info!("Transcription worker stopped after {} chunks", chunk_index);
}

/// Find model path checking bundled resources first
pub fn find_model_path_with_bundled(
    model_name: &str,
    custom_path: Option<&str>,
    app_handle: &AppHandle,
) -> Result<PathBuf, String> {
    // 1. Custom path first (user override)
    if let Some(custom) = custom_path {
        if !custom.is_empty() {
            let custom_dir = std::path::Path::new(custom);
            let model_files = get_model_filenames(model_name);
            for model_file in &model_files {
                let custom_model = custom_dir.join(model_file);
                if custom_model.exists() {
                    log::info!("Found model at custom path: {:?}", custom_model);
                    return Ok(custom_model);
                }
            }
        }
    }

    // 2. Check bundled resources
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled = resource_dir.join("models").join("ggml-tiny.bin");
        if bundled.exists() {
            log::info!("Found bundled model: {:?}", bundled);
            return Ok(bundled);
        }
        // Also check for ggml-tiny.en.bin
        let bundled_en = resource_dir.join("models").join("ggml-tiny.en.bin");
        if bundled_en.exists() {
            log::info!("Found bundled model: {:?}", bundled_en);
            return Ok(bundled_en);
        }
    }

    // 3. App data directory (downloaded models)
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("clip-doctor-scrubs")
        .join("models");

    let model_files = get_model_filenames(model_name);
    for model_file in &model_files {
        let app_model = data_dir.join(model_file);
        if app_model.exists() {
            log::info!("Found model at app data: {:?}", app_model);
            return Ok(app_model);
        }
    }

    // 4. System locations
    let home = std::env::var("HOME").unwrap_or_default();
    let common_dirs = [
        "models".to_string(),
        "/usr/share/whisper".to_string(),
        format!("{}/.local/share/whisper", home),
        format!("{}/.cache/whisper", home),
    ];

    for dir in &common_dirs {
        let dir_path = std::path::Path::new(dir);
        for model_file in &model_files {
            let path = dir_path.join(model_file);
            if path.exists() {
                log::info!("Found model at common location: {:?}", path);
                return Ok(path);
            }
        }
    }

    Err(format!(
        "Whisper model '{}' not found. Searched for: {:?}",
        model_name, model_files
    ))
}

/// Get all possible filenames for a model
fn get_model_filenames(model_name: &str) -> Vec<String> {
    vec![
        format!("ggml-{}.bin", model_name),
        format!("ggml-{}.en.bin", model_name),
        format!("whisper-{}.bin", model_name),
    ]
}

/// Start recording with live transcription
#[tauri::command]
pub async fn start_recording_with_transcription(
    app_handle: AppHandle,
    device_id: Option<String>,
    output_dir: String,
    models_path: Option<String>,
) -> Result<String, String> {
    // Find model (bundled or external)
    let model_path = find_model_path_with_bundled("tiny", models_path.as_deref(), &app_handle)?;

    // Clear transcription buffer
    clear_transcription_buffer();
    TRANSCRIPTION_ENABLED.store(true, Ordering::SeqCst);

    // Start recording (existing logic)
    let recording_path = super::recording::start_recording(device_id, output_dir).await?;

    // Spawn transcription thread
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        transcription_worker(handle, model_path, StreamingConfig::default());
    });

    Ok(recording_path)
}

/// Stop recording with live transcription
#[tauri::command]
pub async fn stop_recording_with_transcription(
    app_handle: AppHandle,
) -> Result<super::recording::RecordingResult, String> {
    // Signal transcription thread to stop
    TRANSCRIPTION_ENABLED.store(false, Ordering::SeqCst);

    // Small delay for thread to finish current chunk
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Stop recording
    let result = super::recording::stop_recording().await?;

    // Emit final event
    let _ = app_handle.emit("transcription-partial", PartialTranscription {
        words: vec![],
        chunk_index: usize::MAX,
        is_final: true,
    });

    Ok(result)
}

/// Check if a bundled model exists
#[tauri::command]
pub fn get_bundled_model_info(app_handle: AppHandle) -> Result<Option<String>, String> {
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled = resource_dir.join("models").join("ggml-tiny.bin");
        if bundled.exists() {
            return Ok(Some(bundled.to_string_lossy().to_string()));
        }
        let bundled_en = resource_dir.join("models").join("ggml-tiny.en.bin");
        if bundled_en.exists() {
            return Ok(Some(bundled_en.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// Check if live transcription is available (model exists)
#[tauri::command]
pub fn check_live_transcription_available(
    app_handle: AppHandle,
    models_path: Option<String>,
) -> Result<bool, String> {
    match find_model_path_with_bundled("tiny", models_path.as_deref(), &app_handle) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Start only the transcription worker (for use with system audio recording)
/// This is called when recording is already started via start_system_audio_recording
/// and we just need to enable live transcription on the audio being fed to the buffer.
#[tauri::command]
pub async fn start_transcription_worker(
    app_handle: AppHandle,
    models_path: Option<String>,
) -> Result<(), String> {
    // Find model (bundled or external)
    let model_path = find_model_path_with_bundled("tiny", models_path.as_deref(), &app_handle)?;

    // Clear transcription buffer and enable
    clear_transcription_buffer();
    TRANSCRIPTION_ENABLED.store(true, Ordering::SeqCst);

    log::info!("Starting transcription worker (standalone) with model: {:?}", model_path);

    // Spawn transcription thread
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        transcription_worker(handle, model_path, StreamingConfig::default());
    });

    Ok(())
}

/// Stop only the transcription worker (for use with system audio recording)
#[tauri::command]
pub async fn stop_transcription_worker(
    app_handle: AppHandle,
) -> Result<(), String> {
    // Signal transcription thread to stop
    TRANSCRIPTION_ENABLED.store(false, Ordering::SeqCst);

    // Small delay for thread to finish current chunk
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Emit final event
    let _ = app_handle.emit("transcription-partial", PartialTranscription {
        words: vec![],
        chunk_index: usize::MAX,
        is_final: true,
    });

    log::info!("Transcription worker stopped");

    Ok(())
}
