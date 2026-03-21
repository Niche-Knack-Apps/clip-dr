use ndarray::{Array2, ArrayD, IxDyn};
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use tauri::Manager;
use super::transcribe::{TranscriptionMetrics, TranscriptionResult, Word};

/// Cached ONNX sessions to avoid reloading models on every transcription (~10s load time).
/// Key: model directory path string. Value: (encoder, decoder) sessions.
static SESSION_CACHE: std::sync::OnceLock<Mutex<Option<(String, Session, Session)>>> = std::sync::OnceLock::new();

fn get_or_load_sessions(model_dir: &Path) -> Result<(Session, Session), String> {
    let cache = SESSION_CACHE.get_or_init(|| Mutex::new(None));
    let model_key = model_dir.to_string_lossy().to_string();

    let mut guard = cache.lock().expect("SESSION_CACHE mutex poisoned");
    if let Some((ref key, _, _)) = *guard {
        if key == &model_key {
            let (_, enc, dec) = guard.take().expect("just checked Some");
            log::info!("Reusing cached moonshine sessions");
            return Ok((enc, dec));
        }
        // Different model — drop old cache
        guard.take();
    }
    drop(guard);

    let encoder_path = model_dir.join("encoder_model.onnx");
    let decoder_path = model_dir.join("decoder_model_merged.onnx");
    log::info!("Loading moonshine encoder: {:?}", encoder_path);
    let enc = init_session(&encoder_path)?;
    log::info!("Loading moonshine decoder: {:?}", decoder_path);
    let dec = init_session(&decoder_path)?;
    Ok((enc, dec))
}

fn return_sessions_to_cache(model_dir: &Path, encoder: Session, decoder: Session) {
    let cache = SESSION_CACHE.get_or_init(|| Mutex::new(None));
    let model_key = model_dir.to_string_lossy().to_string();
    let mut guard = cache.lock().expect("SESSION_CACHE mutex poisoned");
    *guard = Some((model_key, encoder, decoder));
}

// ── Constants ──

const DECODER_START_TOKEN_ID: i64 = 1;
const EOS_TOKEN_ID: i64 = 2;
const SAMPLE_RATE: u32 = 16000;
/// Moonshine tiny generates ~6 tokens per second of audio
const TOKENS_PER_SECOND: f64 = 6.0;

// ── Model definitions ──

/// (name, subdirectory under models/moonshine/, encoder_mb, decoder_mb)
const MOONSHINE_MODELS: &[(&str, &str, u64, u64)] = &[
    ("tiny", "tiny", 8, 21),
    ("base", "base", 22, 56),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoonshineModelInfo {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub encoder_size_mb: u64,
    pub decoder_size_mb: u64,
}

// ── KV Cache ──

struct KVCache {
    cache: HashMap<String, Vec<f32>>,
    shapes: HashMap<String, Vec<usize>>,
    num_layers: usize,
}

impl KVCache {
    fn new(num_layers: usize, num_heads: usize, head_dim: usize) -> Self {
        let mut cache = HashMap::new();
        let mut shapes = HashMap::new();

        for layer in 0..num_layers {
            for attn_type in &["decoder", "encoder"] {
                for kv in &["key", "value"] {
                    let name = format!("past_key_values.{}.{}.{}", layer, attn_type, kv);
                    // Shape: [1, num_heads, 0, head_dim] — empty sequence initially
                    cache.insert(name.clone(), Vec::new());
                    shapes.insert(name, vec![1, num_heads, 0, head_dim]);
                }
            }
        }

        KVCache { cache, shapes, num_layers }
    }

    fn get_inputs(&self) -> Vec<(String, ArrayD<f32>)> {
        let mut inputs = Vec::new();
        for layer in 0..self.num_layers {
            for attn_type in &["decoder", "encoder"] {
                for kv in &["key", "value"] {
                    let name = format!("past_key_values.{}.{}.{}", layer, attn_type, kv);
                    if let (Some(data), Some(shape)) = (self.cache.get(&name), self.shapes.get(&name)) {
                        let arr = ArrayD::from_shape_vec(IxDyn(shape), data.clone())
                            .unwrap_or_else(|_| ArrayD::zeros(IxDyn(shape)));
                        inputs.push((name, arr));
                    }
                }
            }
        }
        inputs
    }

    fn update_from_outputs(
        &mut self,
        outputs: &ort::session::SessionOutputs<'_>,
        use_cache_branch: bool,
    ) -> Result<(), String> {
        for layer in 0..self.num_layers {
            for attn_type in &["decoder", "encoder"] {
                if use_cache_branch && *attn_type == "encoder" {
                    continue;
                }
                for kv in &["key", "value"] {
                    let output_name = format!("present.{}.{}.{}", layer, attn_type, kv);
                    let cache_name = format!("past_key_values.{}.{}.{}", layer, attn_type, kv);

                    if let Some(tensor) = outputs.get(&*output_name) {
                        let arr = tensor
                            .try_extract_array::<f32>()
                            .map_err(|e| format!("Failed to extract cache {}: {}", output_name, e))?;
                        let shape = arr.shape().to_vec();
                        let data = arr.iter().copied().collect::<Vec<f32>>();
                        self.cache.insert(cache_name.clone(), data);
                        self.shapes.insert(cache_name, shape);
                    }
                }
            }
        }
        Ok(())
    }
}

// ── Tokenizer ──

struct MoonshineTokenizer {
    id_to_token: HashMap<i64, String>,
    special_token_ids: Vec<i64>,
}

impl MoonshineTokenizer {
    fn load(model_dir: &Path) -> Result<Self, String> {
        let tokenizer_path = model_dir.join("tokenizer.json");
        if !tokenizer_path.exists() {
            return Err(format!(
                "Tokenizer not found: {}",
                tokenizer_path.display()
            ));
        }

        let content = std::fs::read_to_string(&tokenizer_path)
            .map_err(|e| format!("Failed to read tokenizer: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse tokenizer JSON: {}", e))?;

        let mut id_to_token = HashMap::new();
        if let Some(vocab) = json
            .get("model")
            .and_then(|m| m.get("vocab"))
            .and_then(|v| v.as_object())
        {
            for (token, id_val) in vocab {
                if let Some(id) = id_val.as_i64() {
                    id_to_token.insert(id, token.clone());
                }
            }
        }

        let mut special_token_ids = Vec::new();
        if let Some(added) = json.get("added_tokens").and_then(|v| v.as_array()) {
            for entry in added {
                if entry.get("special").and_then(|s| s.as_bool()).unwrap_or(false) {
                    if let Some(id) = entry.get("id").and_then(|i| i.as_i64()) {
                        special_token_ids.push(id);
                    }
                }
            }
        }

        log::info!(
            "Loaded moonshine tokenizer: {} vocab entries, {} special tokens",
            id_to_token.len(),
            special_token_ids.len()
        );

        Ok(MoonshineTokenizer {
            id_to_token,
            special_token_ids,
        })
    }

    fn decode(&self, token_ids: &[i64]) -> Result<String, String> {
        let mut bytes: Vec<u8> = Vec::new();

        for &id in token_ids {
            if self.special_token_ids.contains(&id) {
                continue;
            }
            if let Some(token) = self.id_to_token.get(&id) {
                let text = token.replace('\u{2581}', " ");
                if text.starts_with("<0x") && text.ends_with('>') && text.len() == 6 {
                    if let Ok(byte) = u8::from_str_radix(&text[3..5], 16) {
                        bytes.push(byte);
                        continue;
                    }
                }
                bytes.extend_from_slice(text.as_bytes());
            }
        }

        let result = String::from_utf8_lossy(&bytes).trim().to_string();
        Ok(result)
    }
}

// ── Model variant config ──

struct VariantConfig {
    num_layers: usize,
    num_heads: usize,
    head_dim: usize,
}

fn variant_config(name: &str) -> VariantConfig {
    match name {
        "base" => VariantConfig {
            num_layers: 8,
            num_heads: 8,
            head_dim: 64,
        },
        _ => VariantConfig {
            num_layers: 6,
            num_heads: 8,
            head_dim: 64,
        },
    }
}

// ── Model path resolution ──

fn get_models_dir() -> Result<std::path::PathBuf, String> {
    crate::services::path_service::get_models_dir()
}

fn find_moonshine_model(
    variant: &str,
    custom_path: Option<&str>,
    resource_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let subdir = format!("moonshine/{}", variant);

    if let Some(custom) = custom_path {
        if !custom.is_empty() {
            let dir = Path::new(custom).join(&subdir);
            if is_valid_moonshine_dir(&dir) {
                log::info!("Found moonshine {} at custom path: {:?}", variant, dir);
                return Ok(dir);
            }
        }
    }

    // Check bundled resources (Tauri resource_dir — set in release builds)
    if let Some(res_dir) = resource_dir {
        let dir = res_dir.join("models").join(&subdir);
        if is_valid_moonshine_dir(&dir) {
            log::info!("Found moonshine {} at bundled resources: {:?}", variant, dir);
            return Ok(dir);
        }
    }

    // Check adjacent to executable (Flatpak, portable installs)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let dir = exe_dir.join("models").join(&subdir);
            if is_valid_moonshine_dir(&dir) {
                log::info!("Found moonshine {} next to executable: {:?}", variant, dir);
                return Ok(dir);
            }
        }
    }

    // Dev mode: check src-tauri/resources/models via CARGO_MANIFEST_DIR
    let dev_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models")
        .join(&subdir);
    if is_valid_moonshine_dir(&dev_dir) {
        log::info!("Found moonshine {} at dev path: {:?}", variant, dev_dir);
        return Ok(dev_dir);
    }

    // App data directory (user-installed models)
    if let Ok(models_dir) = get_models_dir() {
        let dir = models_dir.join(&subdir);
        if is_valid_moonshine_dir(&dir) {
            log::info!("Found moonshine {} at app data: {:?}", variant, dir);
            return Ok(dir);
        }
    }

    Err(format!(
        "Moonshine {} model not found. Expected encoder_model.onnx + decoder_model_merged.onnx + tokenizer.json in a 'moonshine/{}' subdirectory.",
        variant, variant
    ))
}

fn is_valid_moonshine_dir(dir: &Path) -> bool {
    dir.join("encoder_model.onnx").exists()
        && dir.join("decoder_model_merged.onnx").exists()
        && dir.join("tokenizer.json").exists()
}

fn find_any_moonshine_model(custom_path: Option<&str>, resource_dir: Option<&std::path::Path>) -> Result<(String, std::path::PathBuf), String> {
    for (name, _, _, _) in MOONSHINE_MODELS {
        if let Ok(path) = find_moonshine_model(name, custom_path, resource_dir) {
            return Ok((name.to_string(), path));
        }
    }
    Err("No moonshine model found. Download models to <models-dir>/moonshine/tiny/ (encoder_model.onnx + decoder_model_merged.onnx + tokenizer.json)".to_string())
}

// ── Inference ──

fn run_moonshine_inference(
    encoder: &mut Session,
    decoder: &mut Session,
    variant_name: &str,
    samples: &[f32],
) -> Result<Vec<i64>, String> {
    let config = variant_config(variant_name);

    let duration_secs = samples.len() as f32 / SAMPLE_RATE as f32;
    if duration_secs < 0.1 || duration_secs > 64.0 {
        return Err(format!(
            "Moonshine requires audio between 0.1s and 64s, got {:.2}s.",
            duration_secs
        ));
    }

    let encoder_input_names: Vec<String> =
        encoder.inputs().iter().map(|i| i.name().to_string()).collect();
    let decoder_input_names: Vec<String> =
        decoder.inputs().iter().map(|i| i.name().to_string()).collect();

    log::debug!("Encoder inputs: {:?}", encoder_input_names);
    log::debug!("Decoder inputs: {:?}", decoder_input_names);

    // Encode
    let audio = Array2::from_shape_vec((1, samples.len()), samples.to_vec())
        .map_err(|e| format!("Audio shape error: {}", e))?;
    let audio_dyn = audio.clone().into_dyn();

    let encoder_outputs = if encoder_input_names.contains(&"attention_mask".to_string()) {
        let mask = Array2::<i64>::ones((1, samples.len())).into_dyn();
        encoder
            .run(inputs![
                "input_values" => TensorRef::from_array_view(audio_dyn.view())
                    .map_err(|e| format!("Encoder input error: {}", e))?,
                "attention_mask" => TensorRef::from_array_view(mask.view())
                    .map_err(|e| format!("Encoder mask error: {}", e))?
            ])
            .map_err(|e| format!("Encoder inference failed: {}", e))?
    } else {
        encoder
            .run(inputs![
                "input_values" => TensorRef::from_array_view(audio_dyn.view())
                    .map_err(|e| format!("Encoder input error: {}", e))?
            ])
            .map_err(|e| format!("Encoder inference failed: {}", e))?
    };

    let hidden_states_view = encoder_outputs
        .get("last_hidden_state")
        .ok_or_else(|| "Encoder output 'last_hidden_state' not found".to_string())?
        .try_extract_array::<f32>()
        .map_err(|e| format!("Failed to extract encoder output: {}", e))?;
    // Store as flat data + shape to avoid ndarray version conflicts
    let hs_shape = hidden_states_view.shape().to_vec();
    let hs_data: Vec<f32> = hidden_states_view.iter().copied().collect();

    log::debug!("Encoder output shape: {:?}", hs_shape);

    // Decode autoregressively
    let max_tokens = ((duration_secs as f64) * TOKENS_PER_SECOND * 1.5) as usize + 10;
    let mut cache = KVCache::new(config.num_layers, config.num_heads, config.head_dim);
    let mut tokens: Vec<i64> = vec![DECODER_START_TOKEN_ID];
    let audio_attention_mask = Array2::<i64>::ones((1, samples.len()));

    for i in 0..max_tokens {
        let use_cache_branch = i > 0;
        let last_token = *tokens.last().expect("tokens vec initialized non-empty");

        let input_ids = Array2::from_shape_vec((1, 1), vec![last_token])
            .map_err(|e| format!("input_ids shape error: {}", e))?;
        let encoder_hidden_states = ArrayD::from_shape_vec(IxDyn(&hs_shape), hs_data.clone())
            .map_err(|e| format!("encoder_hidden_states shape error: {}", e))?;
        let use_cache_arr = ndarray::arr1(&[use_cache_branch]).into_dyn();

        let cache_inputs = cache.get_inputs();

        let mut ort_inputs: Vec<(std::borrow::Cow<'_, str>, ort::value::DynValue)> = Vec::new();

        ort_inputs.push((
            "input_ids".into(),
            ort::value::Value::from_array(input_ids.into_dyn())
                .map_err(|e| format!("input_ids tensor: {}", e))?
                .into_dyn(),
        ));
        ort_inputs.push((
            "encoder_hidden_states".into(),
            ort::value::Value::from_array(encoder_hidden_states)
                .map_err(|e| format!("encoder_hidden_states tensor: {}", e))?
                .into_dyn(),
        ));
        ort_inputs.push((
            "use_cache_branch".into(),
            ort::value::Value::from_array(use_cache_arr)
                .map_err(|e| format!("use_cache_branch tensor: {}", e))?
                .into_dyn(),
        ));

        if decoder_input_names.contains(&"encoder_attention_mask".to_string()) {
            ort_inputs.push((
                "encoder_attention_mask".into(),
                ort::value::Value::from_array(audio_attention_mask.clone().into_dyn())
                    .map_err(|e| format!("encoder_attention_mask tensor: {}", e))?
                    .into_dyn(),
            ));
        }

        for (name, arr) in cache_inputs {
            ort_inputs.push((
                name.into(),
                ort::value::Value::from_array(arr)
                    .map_err(|e| format!("Cache tensor error: {}", e))?
                    .into_dyn(),
            ));
        }

        let outputs = decoder
            .run(ort_inputs)
            .map_err(|e| format!("Decoder failed at step {}: {}", i, e))?;

        // Greedy decode: argmax of last position logits
        let logits = outputs
            .get("logits")
            .ok_or_else(|| "Decoder output 'logits' not found".to_string())?
            .try_extract_array::<f32>()
            .map_err(|e| format!("Failed to extract logits: {}", e))?;

        let logits_shape = logits.shape();
        let vocab_size = logits_shape[2];
        let last_pos = logits_shape[1] - 1;

        // Manual indexing to avoid ndarray version-sensitive slice API
        let mut best_token = EOS_TOKEN_ID;
        let mut best_score = f32::NEG_INFINITY;
        for v in 0..vocab_size {
            let score = logits[[0, last_pos, v]];
            if score > best_score {
                best_score = score;
                best_token = v as i64;
            }
        }

        tokens.push(best_token);

        if best_token == EOS_TOKEN_ID {
            log::debug!("Moonshine EOS at step {}", i + 1);
            break;
        }

        cache.update_from_outputs(&outputs, use_cache_branch)?;
    }

    log::debug!("Moonshine generated {} tokens", tokens.len());
    Ok(tokens)
}

fn init_session(path: &Path) -> Result<Session, String> {
    let providers = vec![CPUExecutionProvider::default().build()];

    Session::builder()
        .map_err(|e| format!("Session builder error: {}", e))?
        .with_optimization_level(GraphOptimizationLevel::Level1)
        .map_err(|e| format!("Optimization level error: {}", e))?
        .with_execution_providers(providers)
        .map_err(|e| format!("Execution provider error: {}", e))?
        .with_parallel_execution(true)
        .map_err(|e| format!("Parallel execution error: {}", e))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load ONNX model {:?}: {}", path, e))
}

// ── Chunked transcription for long files ──

fn transcribe_chunked(
    model_dir: &Path,
    variant_name: &str,
    samples: &[f32],
) -> Result<(String, Vec<Word>), String> {
    let total_duration = samples.len() as f64 / SAMPLE_RATE as f64;

    let tokenizer = MoonshineTokenizer::load(model_dir)?;
    let (mut encoder, mut decoder) = get_or_load_sessions(model_dir)?;

    let result = (|| -> Result<(String, Vec<Word>), String> {
        if total_duration <= 60.0 {
            let tokens = run_moonshine_inference(&mut encoder, &mut decoder, variant_name, samples)?;
            let text = tokenizer.decode(&tokens)?;
            let words = estimate_word_timestamps(&text, 0.0, total_duration);
            return Ok((text, words));
        }

        let chunk_samples = 30 * SAMPLE_RATE as usize;
        let overlap_samples = SAMPLE_RATE as usize;
        let mut all_text = String::new();
        let mut all_words: Vec<Word> = Vec::new();
        let mut offset = 0usize;

        while offset < samples.len() {
            let end = (offset + chunk_samples).min(samples.len());
            let chunk = &samples[offset..end];
            let chunk_duration = chunk.len() as f64 / SAMPLE_RATE as f64;
            let chunk_start_time = offset as f64 / SAMPLE_RATE as f64;

            if chunk_duration < 0.1 {
                break;
            }

            log::info!(
                "Moonshine chunk: {:.1}s - {:.1}s ({:.1}s)",
                chunk_start_time,
                chunk_start_time + chunk_duration,
                chunk_duration
            );

            let tokens = run_moonshine_inference(&mut encoder, &mut decoder, variant_name, chunk)?;
            let chunk_text = tokenizer.decode(&tokens)?;

            if !chunk_text.is_empty() {
                if !all_text.is_empty() {
                    all_text.push(' ');
                }
                all_text.push_str(&chunk_text);

                let chunk_words =
                    estimate_word_timestamps(&chunk_text, chunk_start_time, chunk_duration);
                all_words.extend(chunk_words);
            }

            if end >= samples.len() {
                break;
            }
            offset = end - overlap_samples;
        }

        Ok((all_text, all_words))
    })();

    // Return sessions to cache regardless of success/failure
    return_sessions_to_cache(model_dir, encoder, decoder);

    result
}

/// Estimate word-level timestamps by distributing duration proportionally by character count.
fn estimate_word_timestamps(text: &str, start_time: f64, duration: f64) -> Vec<Word> {
    let text_words: Vec<&str> = text.split_whitespace().collect();
    if text_words.is_empty() {
        return Vec::new();
    }

    let total_chars: usize = text_words.iter().map(|w| w.len()).sum();
    if total_chars == 0 {
        return Vec::new();
    }

    let mut words = Vec::with_capacity(text_words.len());
    let mut cursor = start_time;

    for word_text in &text_words {
        let word_fraction = word_text.len() as f64 / total_chars as f64;
        let word_duration = duration * word_fraction;

        words.push(Word {
            id: uuid::Uuid::new_v4().to_string(),
            text: word_text.to_string(),
            start: cursor,
            end: cursor + word_duration,
            confidence: 0.7, // Lower confidence — timestamps are estimated
        });

        cursor += word_duration;
    }

    words
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn transcribe_moonshine(
    path: String,
    models_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<TranscriptionResult, String> {
    let total_start = Instant::now();
    let audio_path = Path::new(&path);
    let custom_path = models_path.as_deref();
    let resource_dir = app.path().resource_dir().ok();

    log::info!("Moonshine transcribing: {}", path);

    let (variant_name, model_dir) = find_any_moonshine_model(custom_path, resource_dir.as_deref())?;
    log::info!("Using moonshine model: {} at {:?}", variant_name, model_dir);

    let load_start = Instant::now();
    let samples = super::transcribe::load_audio_16khz_pub(audio_path)?;
    let audio_duration_secs = samples.len() as f64 / 16000.0;
    let load_time_ms = load_start.elapsed().as_millis() as u64;
    log::info!("Loaded {} samples at 16kHz ({:.1}s) in {}ms", samples.len(), audio_duration_secs, load_time_ms);

    let inference_start = Instant::now();
    let (text, words) = transcribe_chunked(&model_dir, &variant_name, &samples)?;
    let inference_time_ms = inference_start.elapsed().as_millis() as u64;

    let total_time_ms = total_start.elapsed().as_millis() as u64;
    let word_count = words.len();
    let words_per_second = if audio_duration_secs > 0.0 { word_count as f64 / audio_duration_secs } else { 0.0 };
    let real_time_factor = if audio_duration_secs > 0.0 { (total_time_ms as f64 / 1000.0) / audio_duration_secs } else { 0.0 };

    log::info!(
        "Moonshine transcription complete: {} words, {:.1}s audio | load={}ms inference={}ms total={}ms | RTF={:.2}x",
        word_count, audio_duration_secs, load_time_ms, inference_time_ms, total_time_ms, real_time_factor
    );

    Ok(TranscriptionResult {
        words,
        text,
        language: "en".to_string(),
        metrics: Some(TranscriptionMetrics {
            engine: "moonshine".to_string(),
            model_name: format!("moonshine-{}", variant_name),
            audio_duration_secs,
            load_time_ms,
            inference_time_ms,
            total_time_ms,
            word_count,
            words_per_second,
            real_time_factor,
        }),
    })
}

#[tauri::command]
pub async fn check_moonshine_model(
    custom_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let path_ref = custom_path.as_deref();
    let resource_dir = app.path().resource_dir().ok();
    let (_name, dir) = find_any_moonshine_model(path_ref, resource_dir.as_deref())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_moonshine_models(
    custom_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<MoonshineModelInfo>, String> {
    let path_ref = custom_path.as_deref();
    let resource_dir = app.path().resource_dir().ok();
    let mut models = Vec::new();

    for (name, _subdir, enc_mb, dec_mb) in MOONSHINE_MODELS {
        let found = find_moonshine_model(name, path_ref, resource_dir.as_deref()).ok();
        models.push(MoonshineModelInfo {
            name: name.to_string(),
            available: found.is_some(),
            path: found.map(|p| p.to_string_lossy().to_string()),
            encoder_size_mb: *enc_mb,
            decoder_size_mb: *dec_mb,
        });
    }

    Ok(models)
}
