use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub words: Vec<Word>,
    pub text: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub filename: String,
    pub size_mb: u64,
    pub download_url: String,
    pub path: Option<String>,
    pub available: bool,
}

// Model definitions: (name, possible filenames, size_mb)
// Supports standard and English-only variants
const WHISPER_MODELS: &[(&str, &[&str], u64)] = &[
    ("tiny", &["ggml-tiny.bin", "ggml-tiny.en.bin", "whisper-tiny.bin"], 75),
    ("base", &["ggml-base.bin", "ggml-base.en.bin", "whisper-base.bin"], 142),
    ("small", &["ggml-small.bin", "ggml-small.en.bin", "whisper-small.bin"], 466),
    ("medium", &["ggml-medium.bin", "ggml-medium.en.bin", "whisper-medium.bin"], 1500),
    ("large", &["ggml-large.bin", "ggml-large-v1.bin", "whisper-large.bin"], 3000),
    ("large-v2", &["ggml-large-v2.bin", "whisper-large-v2.bin"], 3000),
    ("large-v3", &["ggml-large-v3.bin", "whisper-large-v3.bin"], 3000),
];

/// Get the path to the whisper models directory
fn get_models_dir() -> Result<std::path::PathBuf, String> {
    crate::services::path_service::get_models_dir()
}

/// Get all possible filenames for a model
fn get_model_filenames(model_name: &str) -> Vec<String> {
    // Find the model in our definitions
    for (name, filenames, _) in WHISPER_MODELS {
        if *name == model_name {
            return filenames.iter().map(|s| s.to_string()).collect();
        }
    }
    // Fallback: generate common patterns
    vec![
        format!("ggml-{}.bin", model_name),
        format!("ggml-{}.en.bin", model_name),
        format!("whisper-{}.bin", model_name),
    ]
}

/// Get path to the whisper model, checking common locations
fn find_model_path(model_name: &str, custom_path: Option<&str>) -> Result<std::path::PathBuf, String> {
    find_model_path_internal(model_name, custom_path, None)
}

/// Internal model path finder with optional bundled resources check
fn find_model_path_internal(
    model_name: &str,
    custom_path: Option<&str>,
    resource_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let model_files = get_model_filenames(model_name);

    // Check custom path first if provided
    if let Some(custom) = custom_path {
        if !custom.is_empty() {
            let custom_dir = Path::new(custom);
            for model_file in &model_files {
                let custom_model = custom_dir.join(model_file);
                if custom_model.exists() {
                    log::info!("Found model at custom path: {:?}", custom_model);
                    return Ok(custom_model);
                }
            }
        }
    }

    // Check bundled resources if available (production builds)
    if let Some(res_dir) = resource_dir {
        for model_file in &model_files {
            let bundled = res_dir.join("models").join(model_file);
            if bundled.exists() {
                log::info!("Found bundled model: {:?}", bundled);
                return Ok(bundled);
            }
        }
    }

    // Dev mode fallback: check src-tauri/resources/models via CARGO_MANIFEST_DIR
    let dev_models_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models");
    if dev_models_dir.exists() {
        for model_file in &model_files {
            let dev_model = dev_models_dir.join(model_file);
            if dev_model.exists() {
                log::info!("Found model at dev path: {:?}", dev_model);
                return Ok(dev_model);
            }
        }
    }

    // Check app data directory
    if let Ok(models_dir) = get_models_dir() {
        for model_file in &model_files {
            let app_model = models_dir.join(model_file);
            if app_model.exists() {
                log::info!("Found model at app data: {:?}", app_model);
                return Ok(app_model);
            }
        }
    }

    // Check common locations
    let home = std::env::var("HOME").unwrap_or_default();
    let common_dirs = [
        "models".to_string(),
        "/usr/share/whisper".to_string(),
        format!("{}/.local/share/whisper", home),
        format!("{}/.cache/whisper", home),
    ];

    for dir in &common_dirs {
        let dir_path = Path::new(dir);
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

/// Scan a directory for any whisper model files
fn scan_for_models(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let mut found = Vec::new();

    log::info!("Scanning directory for models: {:?}", dir);

    if !dir.exists() {
        log::warn!("Directory does not exist: {:?}", dir);
        return found;
    }

    if !dir.is_dir() {
        log::warn!("Path is not a directory: {:?}", dir);
        return found;
    }

    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                    let filename_lower = filename.to_lowercase();

                    // Check if it looks like a whisper model - be flexible with naming
                    // Accept: ggml-*.bin, whisper*.bin, *whisper*.bin, or any .bin with model size names
                    let is_whisper_model = filename_lower.ends_with(".bin") && (
                        filename_lower.starts_with("ggml-") ||
                        filename_lower.starts_with("ggml_") ||
                        filename_lower.contains("whisper") ||
                        // Common model size names
                        filename_lower.contains("tiny") ||
                        filename_lower.contains("base") ||
                        filename_lower.contains("small") ||
                        filename_lower.contains("medium") ||
                        filename_lower.contains("large")
                    );

                    if is_whisper_model {
                        // Extract model name from filename
                        let name = filename
                            .trim_start_matches("ggml-")
                            .trim_start_matches("ggml_")
                            .trim_start_matches("whisper-")
                            .trim_start_matches("whisper_")
                            .trim_end_matches(".bin")
                            .trim_end_matches(".en")
                            .to_string();

                        log::info!("Found model: {} at {:?}", name, path);
                        found.push((name, path));
                    }
                }
            }
        }
        Err(e) => {
            log::error!("Failed to read directory {:?}: {}", dir, e);
        }
    }

    log::info!("Total models found in {:?}: {}", dir, found.len());
    found
}

/// Find any available model, preferring smaller ones for speed
fn find_any_model(custom_path: Option<&str>) -> Result<std::path::PathBuf, String> {
    // First, scan custom directory if provided
    if let Some(custom) = custom_path {
        if !custom.is_empty() {
            let custom_dir = Path::new(custom);
            if custom_dir.is_dir() {
                let models = scan_for_models(custom_dir);
                log::info!("Found {} models in custom path {:?}: {:?}", models.len(), custom_dir, models);

                // Prefer smaller models: tiny > base > small > medium > large
                let preference = ["tiny", "base", "small", "medium", "large"];
                for pref in &preference {
                    for (name, path) in &models {
                        if name.contains(pref) {
                            log::info!("Selecting model: {} at {:?}", name, path);
                            return Ok(path.clone());
                        }
                    }
                }

                // Return first found if no preference matched
                if let Some((name, path)) = models.first() {
                    log::info!("Using first available model: {} at {:?}", name, path);
                    return Ok(path.clone());
                }
            }
        }
    }

    // Fall back to named model search
    find_model_path("tiny", custom_path)
        .or_else(|_| find_model_path("base", custom_path))
        .or_else(|_| find_model_path("small", custom_path))
        .or_else(|_| find_model_path("medium", custom_path))
        .or_else(|_| find_model_path("large", custom_path))
}

/// Load audio and convert to 16kHz mono f32 samples (required by whisper)
fn load_audio_16khz(path: &Path) -> Result<Vec<f32>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Failed to probe format: {}", e))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("No audio tracks found")?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100) as f64;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    // Size guard: estimate 16kHz mono samples and reject files >6 hours
    let max_16k_samples = 16000 * 3600 * 6; // 6 hours at 16kHz
    if let Some(n_frames) = track.codec_params.n_frames {
        let estimated_16k = (n_frames as f64 / sample_rate * 16000.0) as usize;
        if estimated_16k > max_16k_samples {
            let hours = n_frames as f64 / sample_rate / 3600.0;
            return Err(format!(
                "Audio file is too long for transcription ({:.1} hours). Maximum supported duration is 6 hours.",
                hours
            ));
        }
    }

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Collect all mono samples with capacity hint
    let estimated_mono = track.codec_params.n_frames
        .map(|n| (n as f64 / sample_rate * 16000.0) as usize)
        .unwrap_or(0);
    let mut mono_samples: Vec<f32> = Vec::with_capacity(estimated_mono);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let duration = decoded.capacity() as u64;

        let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let samples = sample_buf.samples();

        // Mix to mono
        for chunk in samples.chunks(channels) {
            let mono = chunk.iter().sum::<f32>() / channels as f32;
            mono_samples.push(mono);
        }
    }

    // Resample to 16kHz if needed
    const TARGET_RATE: f64 = 16000.0;
    if (sample_rate - TARGET_RATE).abs() < 1.0 {
        // Already 16kHz
        return Ok(mono_samples);
    }

    // Simple linear resampling (for better quality, use rubato)
    let ratio = TARGET_RATE / sample_rate;
    let new_len = (mono_samples.len() as f64 * ratio) as usize;
    let mut resampled = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_pos = i as f64 / ratio;
        let src_idx = src_pos as usize;
        let frac = src_pos - src_idx as f64;

        if src_idx + 1 < mono_samples.len() {
            let sample = mono_samples[src_idx] * (1.0 - frac as f32)
                + mono_samples[src_idx + 1] * frac as f32;
            resampled.push(sample);
        } else if src_idx < mono_samples.len() {
            resampled.push(mono_samples[src_idx]);
        }
    }

    Ok(resampled)
}

/// Transcribe audio file using Whisper
#[tauri::command]
pub async fn transcribe_audio(
    path: String,
    models_path: Option<String>,
    beam_size: Option<i32>,
    best_of: Option<i32>,
    temperature: Option<f32>,
) -> Result<TranscriptionResult, String> {
    let audio_path = Path::new(&path);
    let custom_path = models_path.as_deref();

    log::info!("Transcribing audio: {}", path);
    log::info!("Models path: {:?}", custom_path);

    // Try to find any available model
    let model_path = find_any_model(custom_path)?;

    log::info!("Using model: {:?}", model_path);

    // Load audio
    let samples = load_audio_16khz(audio_path)?;
    log::info!("Loaded {} samples at 16kHz", samples.len());

    // Create whisper context
    let ctx = WhisperContext::new_with_params(
        model_path.to_str().unwrap(),
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("Failed to load whisper model: {}", e))?;

    // Create state for this transcription
    let mut state = ctx.create_state()
        .map_err(|e| format!("Failed to create whisper state: {}", e))?;

    // Configure parameters — use BeamSearch when beam_size > 1
    let bs = beam_size.unwrap_or(1);
    let bo = best_of.unwrap_or(1);
    let temp = temperature.unwrap_or(0.0);

    let mut params = if bs > 1 {
        FullParams::new(SamplingStrategy::BeamSearch { beam_size: bs, patience: 1.0 })
    } else {
        FullParams::new(SamplingStrategy::Greedy { best_of: bo })
    };
    params.set_temperature(temp);
    params.set_language(Some("en"));
    params.set_token_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    // Run transcription
    state.full(params, &samples)
        .map_err(|e| format!("Transcription failed: {}", e))?;

    // Extract segments and create word-level timestamps
    let num_segments = state.full_n_segments()
        .map_err(|e| format!("Failed to get segments: {}", e))?;

    let mut words: Vec<Word> = Vec::new();
    let mut full_text = String::new();

    let mut skipped_segments = 0;

    for i in 0..num_segments {
        // Non-fatal: skip segments that fail to extract (e.g., UTF-8 errors)
        let segment_text = match state.full_get_segment_text(i) {
            Ok(text) => text,
            Err(e) => {
                log::warn!("Skipping segment {}/{}: failed to get text: {}", i, num_segments, e);
                skipped_segments += 1;
                continue;
            }
        };

        let start_time = match state.full_get_segment_t0(i) {
            Ok(t) => t as f64 / 100.0,
            Err(e) => {
                log::warn!("Skipping segment {}/{}: failed to get start time: {}", i, num_segments, e);
                skipped_segments += 1;
                continue;
            }
        };
        let end_time = match state.full_get_segment_t1(i) {
            Ok(t) => t as f64 / 100.0,
            Err(e) => {
                log::warn!("Skipping segment {}/{}: failed to get end time: {}", i, num_segments, e);
                skipped_segments += 1;
                continue;
            }
        };

        // Get number of tokens in this segment
        let num_tokens = match state.full_n_tokens(i) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("Skipping segment {}/{}: failed to get token count: {}", i, num_segments, e);
                skipped_segments += 1;
                continue;
            }
        };

        // Try to get word-level timestamps from tokens
        let mut segment_words: Vec<(String, f64, f64)> = Vec::new();
        let mut current_word = String::new();
        let mut word_start: Option<f64> = None;
        let mut word_end = start_time;

        for j in 0..num_tokens {
            let token_text = state.full_get_token_text(i, j)
                .unwrap_or_default();

            // Skip special tokens (timestamps like [_TT_1501_], language tags like <|en|>, etc.)
            let trimmed_check = token_text.trim();
            if trimmed_check.starts_with('[') || trimmed_check.starts_with("<|") {
                continue;
            }

            let token_data = state.full_get_token_data(i, j)
                .ok();

            // Check if this starts a new word (tokens starting with space)
            let starts_new_word = token_text.starts_with(' ') || token_text.starts_with('\n');

            if starts_new_word && !current_word.is_empty() {
                // Save current word
                if let Some(start) = word_start {
                    segment_words.push((current_word.clone(), start, word_end));
                }
                current_word.clear();
                word_start = None;
            }

            // Get timestamp for this token
            if let Some(data) = token_data {
                let t = data.t0 as f64 / 100.0;
                if word_start.is_none() && !token_text.trim().is_empty() {
                    word_start = Some(t);
                }
                word_end = data.t1 as f64 / 100.0;
            }

            // Add token text to current word
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

        // If we couldn't get word-level timestamps, fall back to splitting the segment
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

        // Add words to result
        for (text, start, end) in segment_words {
            if !full_text.is_empty() {
                full_text.push(' ');
            }
            full_text.push_str(&text);

            words.push(Word {
                id: uuid::Uuid::new_v4().to_string(),
                text,
                start,
                end,
                confidence: 0.9, // Whisper doesn't provide per-word confidence
            });
        }
    }

    if skipped_segments > 0 {
        log::warn!("Transcription finished with {} skipped segments (out of {})", skipped_segments, num_segments);
    }
    log::info!("Transcription complete: {} words from {} segments", words.len(), num_segments - skipped_segments);

    Ok(TranscriptionResult {
        words,
        text: full_text,
        language: "en".to_string(),
    })
}

/// Check if whisper model is available
#[tauri::command]
pub async fn check_whisper_model(app_handle: AppHandle, custom_path: Option<String>) -> Result<String, String> {
    let path_ref = custom_path.as_deref();
    log::info!("Checking for whisper model, custom path: {:?}", path_ref);

    // Try find_any_model first (custom path, app data, system locations)
    if let Ok(path) = find_any_model(path_ref) {
        return Ok(path.to_string_lossy().to_string());
    }

    // Also check bundled resources (production)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled = resource_dir.join("models").join("ggml-tiny.bin");
        if bundled.exists() {
            log::info!("Found bundled model: {:?}", bundled);
            return Ok(bundled.to_string_lossy().to_string());
        }
        let bundled_en = resource_dir.join("models").join("ggml-tiny.en.bin");
        if bundled_en.exists() {
            log::info!("Found bundled model: {:?}", bundled_en);
            return Ok(bundled_en.to_string_lossy().to_string());
        }
    }

    // Dev mode fallback
    let dev_models_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models");
    for model_file in &["ggml-tiny.bin", "ggml-tiny.en.bin"] {
        let dev_model = dev_models_dir.join(model_file);
        if dev_model.exists() {
            log::info!("Found model at dev path: {:?}", dev_model);
            return Ok(dev_model.to_string_lossy().to_string());
        }
    }

    Err("Whisper model not found".to_string())
}

/// Get the models directory path
#[tauri::command]
pub async fn get_models_directory() -> Result<String, String> {
    get_models_dir().map(|p| p.to_string_lossy().to_string())
}

/// Debug: List all files in a directory
#[tauri::command]
pub async fn debug_list_directory(path: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&path);
    let mut files = Vec::new();

    if !dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if let Some(name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    files.push(name.to_string());
                }
            }
        }
        Err(e) => {
            return Err(format!("Failed to read directory: {}", e));
        }
    }

    files.sort();
    Ok(files)
}

/// List all available whisper models with their status
#[tauri::command]
pub async fn list_available_models(app_handle: AppHandle, custom_path: Option<String>) -> Result<Vec<ModelInfo>, String> {
    let path_ref = custom_path.as_deref();
    let mut models = Vec::new();

    // Get bundled resource directory for checking bundled models
    let resource_dir = app_handle.path().resource_dir().ok();

    // Also scan custom directory for additional models
    let mut found_in_custom: Vec<(String, std::path::PathBuf)> = Vec::new();
    if let Some(custom) = path_ref {
        if !custom.is_empty() {
            found_in_custom = scan_for_models(Path::new(custom));
            log::info!("Scanned custom path, found: {:?}", found_in_custom);
        }
    }

    for (name, filenames, size_mb) in WHISPER_MODELS {
        let found_path = find_model_path_internal(name, path_ref, resource_dir.as_deref()).ok();
        let available = found_path.is_some();

        models.push(ModelInfo {
            name: name.to_string(),
            filename: filenames.first().unwrap_or(&"").to_string(),
            size_mb: *size_mb,
            download_url: format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
                filenames.first().unwrap_or(&"")
            ),
            path: found_path.map(|p| p.to_string_lossy().to_string()),
            available,
        });
    }

    // Add any models found in custom path that aren't in our predefined list
    for (found_name, found_path) in found_in_custom {
        let already_listed = models.iter().any(|m| {
            m.path.as_ref().map(|p| p == &found_path.to_string_lossy().to_string()).unwrap_or(false)
        });

        if !already_listed {
            let filename = found_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            models.push(ModelInfo {
                name: found_name,
                filename: filename.clone(),
                size_mb: 0, // Unknown size
                download_url: String::new(),
                path: Some(found_path.to_string_lossy().to_string()),
                available: true,
            });
        }
    }

    Ok(models)
}

/// Check if a bundled model exists
#[tauri::command]
pub fn get_bundled_model_info(app_handle: AppHandle) -> Result<Option<String>, String> {
    // Production: Tauri resource dir
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

    // Dev mode fallback
    let dev_models_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models");
    for model_file in &["ggml-tiny.bin", "ggml-tiny.en.bin"] {
        let dev_model = dev_models_dir.join(model_file);
        if dev_model.exists() {
            return Ok(Some(dev_model.to_string_lossy().to_string()));
        }
    }

    Ok(None)
}

/// Download a model file to the specified directory
#[tauri::command]
pub async fn download_model(
    url: String,
    filename: String,
    custom_path: Option<String>,
) -> Result<String, String> {
    // Determine target directory
    let target_dir = if let Some(custom) = custom_path.as_ref().filter(|p| !p.is_empty()) {
        std::path::PathBuf::from(custom)
    } else {
        get_models_dir()?
    };

    // Ensure directory exists
    if !target_dir.exists() {
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let target_path = target_dir.join(&filename);
    log::info!("Downloading {} to {:?}", url, target_path);

    // Download the file
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to download file: {}", e))?;

    // Write to file
    let mut file = File::create(&target_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    log::info!("Download complete: {:?}", target_path);
    Ok(target_path.to_string_lossy().to_string())
}
