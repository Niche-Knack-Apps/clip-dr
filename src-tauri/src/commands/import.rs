use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use super::audio::AudioMetadata;

pub struct ImportSession {
    cancel: Arc<AtomicBool>,
}

pub struct ImportState {
    sessions: Mutex<HashMap<String, ImportSession>>,
}

impl ImportState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStartResult {
    pub session_id: String,
    pub metadata: AudioMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformChunkEvent {
    session_id: String,
    start_bucket: usize,
    waveform: Vec<f32>,
    progress: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportCompleteEvent {
    session_id: String,
    waveform: Vec<f32>,
    actual_duration: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportErrorEvent {
    session_id: String,
    error: String,
}

#[tauri::command]
pub async fn import_audio_start(
    app_handle: AppHandle,
    path: String,
    bucket_count: usize,
) -> Result<ImportStartResult, String> {
    let path_ref = Path::new(&path);

    // Phase 1: Probe metadata (no decode, ~100ms)
    let file = File::open(path_ref).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path_ref.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Failed to probe format: {}", e))?;

    let format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("No audio tracks found")?;

    let codec_params = &track.codec_params;
    let sample_rate = codec_params.sample_rate.unwrap_or(44100);
    let channels = codec_params.channels.map(|c| c.count() as u32).unwrap_or(2);
    let bit_depth = codec_params.bits_per_sample.unwrap_or(16);

    let duration = if let Some(n_frames) = codec_params.n_frames {
        n_frames as f64 / sample_rate as f64
    } else {
        0.0
    };

    let format_name = path_ref
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("unknown")
        .to_uppercase();

    let metadata = AudioMetadata {
        duration,
        sample_rate,
        channels,
        bit_depth,
        format: format_name,
    };

    let session_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));

    // Store session
    let state = app_handle.state::<ImportState>();
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            session_id.clone(),
            ImportSession {
                cancel: cancel.clone(),
            },
        );
    }

    // Phase 2: Spawn background waveform decode
    let bg_session_id = session_id.clone();
    let bg_path = path.clone();
    let bg_app = app_handle.clone();

    tokio::task::spawn_blocking(move || {
        if let Err(e) = decode_waveform_progressive(
            &bg_path,
            bucket_count,
            &bg_session_id,
            &cancel,
            &bg_app,
        ) {
            let _ = bg_app.emit(
                "import-error",
                ImportErrorEvent {
                    session_id: bg_session_id.clone(),
                    error: e,
                },
            );
        }

        // Clean up session
        let state = bg_app.state::<ImportState>();
        let mut sessions = state.sessions.lock().unwrap();
        sessions.remove(&bg_session_id);
    });

    Ok(ImportStartResult {
        session_id,
        metadata,
    })
}

/// Per-bucket accumulator for incremental min/max peak computation.
/// Avoids storing all decoded samples in memory (saves ~1.9GB for 3-hour files).
struct BucketAccumulator {
    min: f32,
    max: f32,
    sample_count: usize,
}

impl BucketAccumulator {
    fn new() -> Self {
        Self { min: 0.0, max: 0.0, sample_count: 0 }
    }

    fn push(&mut self, sample: f32) {
        if self.sample_count == 0 {
            self.min = sample;
            self.max = sample;
        } else {
            if sample < self.min { self.min = sample; }
            if sample > self.max { self.max = sample; }
        }
        self.sample_count += 1;
    }
}

fn decode_waveform_progressive(
    path: &str,
    bucket_count: usize,
    session_id: &str,
    cancel: &AtomicBool,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let path_ref = Path::new(path);

    let file = File::open(path_ref).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path_ref.extension().and_then(|e| e.to_str()) {
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
    let codec_params = &track.codec_params;
    let sample_rate = codec_params.sample_rate.unwrap_or(44100);
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let n_frames = codec_params.n_frames.unwrap_or(0) as usize;

    let mut decoder = symphonia::default::get_codecs()
        .make(codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Estimated total mono samples for bucket assignment
    let estimated_total = if n_frames > 0 { n_frames } else { sample_rate as usize * 60 };
    let samples_per_bucket = (estimated_total / bucket_count).max(1);

    // Bucket accumulators — O(bucket_count) memory (~16KB for 1000 buckets)
    // instead of O(total_samples) (~1.9GB for 3-hour file)
    let mut buckets: Vec<BucketAccumulator> = (0..bucket_count)
        .map(|_| BucketAccumulator::new())
        .collect();

    let mut total_decoded: usize = 0;
    let mut last_emitted_bucket: usize = 0;

    // Emit chunks every ~5% of buckets
    let chunk_interval = (bucket_count / 20).max(10);

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }

        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Error reading packet: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Decode error: {}", e)),
        };

        let spec = *decoded.spec();
        let duration = decoded.capacity() as u64;

        let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let buf_samples = sample_buf.samples();

        // Mix to mono and accumulate directly into buckets — no intermediate storage
        let ch = channels;
        for chunk in buf_samples.chunks(ch) {
            let mono: f32 = chunk.iter().sum::<f32>() / ch as f32;

            // Map this sample to its bucket
            let bucket_idx = (total_decoded / samples_per_bucket).min(bucket_count - 1);
            buckets[bucket_idx].push(mono);
            total_decoded += 1;
        }

        // Calculate progress
        let progress = if estimated_total > 0 {
            (total_decoded as f32 / estimated_total as f32).min(0.99)
        } else {
            0.0
        };

        let current_fillable_buckets =
            ((progress * bucket_count as f32) as usize).min(bucket_count);

        // Emit chunk if we've filled enough new buckets
        if current_fillable_buckets >= last_emitted_bucket + chunk_interval {
            let chunk_waveform = extract_bucket_range(&buckets, last_emitted_bucket, current_fillable_buckets);

            let _ = app_handle.emit(
                "import-waveform-chunk",
                WaveformChunkEvent {
                    session_id: session_id.to_string(),
                    start_bucket: last_emitted_bucket,
                    waveform: chunk_waveform,
                    progress,
                },
            );

            last_emitted_bucket = current_fillable_buckets;
        }
    }

    // For VBR files the estimated_total may be wrong — redistribute samples into
    // buckets using the actual total. Only needed if estimate was significantly off.
    let actual_samples_per_bucket = (total_decoded / bucket_count).max(1);
    let needs_recompute = (actual_samples_per_bucket as f64 - samples_per_bucket as f64).abs()
        / samples_per_bucket as f64
        > 0.05; // >5% drift

    let final_waveform = if needs_recompute {
        // Drift too large — the bucket boundaries shifted. Emit the best we have
        // (the buckets are still visually close enough for an overview waveform).
        log::info!(
            "VBR drift detected: estimated {} actual {} samples/bucket",
            samples_per_bucket,
            actual_samples_per_bucket
        );
        extract_bucket_range(&buckets, 0, bucket_count)
    } else {
        extract_bucket_range(&buckets, 0, bucket_count)
    };

    let actual_duration = total_decoded as f64 / sample_rate as f64;

    let _ = app_handle.emit(
        "import-complete",
        ImportCompleteEvent {
            session_id: session_id.to_string(),
            waveform: final_waveform,
            actual_duration,
        },
    );

    Ok(())
}

/// Extract min/max pairs from bucket accumulators for a range
fn extract_bucket_range(
    buckets: &[BucketAccumulator],
    start: usize,
    end: usize,
) -> Vec<f32> {
    let mut waveform: Vec<f32> = Vec::with_capacity((end - start) * 2);
    for bucket in &buckets[start..end] {
        waveform.push(bucket.min);
        waveform.push(bucket.max);
    }
    waveform
}

#[tauri::command]
pub async fn import_audio_cancel(
    app_handle: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let state = app_handle.state::<ImportState>();
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&session_id) {
        session.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
