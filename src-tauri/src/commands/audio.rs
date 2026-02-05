use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: u32,
    pub format: String,
}

/// Combined result for single-pass audio loading
/// Returns metadata, waveform, and audio samples in one decode pass
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLoadResult {
    pub metadata: AudioMetadata,
    pub waveform: Vec<f32>,
    /// Audio channels as separate arrays (already deinterleaved for Web Audio API)
    pub channels: Vec<Vec<f32>>,
}

#[tauri::command]
pub async fn get_audio_metadata(path: String) -> Result<AudioMetadata, String> {
    let path = Path::new(&path);

    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
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

    let format_name = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("unknown")
        .to_uppercase();

    Ok(AudioMetadata {
        duration,
        sample_rate,
        channels,
        bit_depth,
        format: format_name,
    })
}

#[tauri::command]
pub async fn load_audio_buffer(path: String) -> Result<Vec<f32>, String> {
    let path = Path::new(&path);

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

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
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

        samples.extend_from_slice(sample_buf.samples());
    }

    Ok(samples)
}

/// Single-pass audio loading: decode once, compute metadata + waveform + samples together
/// This is 3x faster than calling get_audio_metadata, extract_waveform, and load_audio_buffer separately
#[tauri::command]
pub async fn load_audio_complete(path: String, bucket_count: usize) -> Result<AudioLoadResult, String> {
    let path_ref = Path::new(&path);

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

    // Extract metadata from codec params (no decode needed)
    let sample_rate = codec_params.sample_rate.unwrap_or(44100);
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2) as u32;
    let bit_depth = codec_params.bits_per_sample.unwrap_or(16);
    let n_frames = codec_params.n_frames.unwrap_or(0) as usize;

    let format_name = path_ref
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("unknown")
        .to_uppercase();

    let mut decoder = symphonia::default::get_codecs()
        .make(codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Pre-allocate vectors for better performance
    let estimated_samples = n_frames * channels as usize;
    let mut samples: Vec<f32> = Vec::with_capacity(estimated_samples.max(1024 * 1024));
    let mut mono_samples: Vec<f32> = Vec::with_capacity(n_frames.max(512 * 1024));

    // Single decode pass: collect interleaved samples AND mono mix for waveform
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
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

        // Store interleaved samples for playback
        samples.extend_from_slice(buf_samples);

        // Mix to mono for waveform (process in chunks of channel count)
        let ch = channels as usize;
        for chunk in buf_samples.chunks(ch) {
            let mono = chunk.iter().sum::<f32>() / ch as f32;
            mono_samples.push(mono);
        }
    }

    // Compute actual duration from decoded samples
    let actual_frames = mono_samples.len();
    let duration = actual_frames as f64 / sample_rate as f64;

    // Generate waveform buckets (min/max pairs) from mono samples
    let samples_per_bucket = (mono_samples.len() / bucket_count).max(1);
    let mut waveform: Vec<f32> = Vec::with_capacity(bucket_count * 2);

    for i in 0..bucket_count {
        let start = i * samples_per_bucket;
        let end = ((i + 1) * samples_per_bucket).min(mono_samples.len());

        if start >= mono_samples.len() {
            waveform.push(0.0);
            waveform.push(0.0);
            continue;
        }

        let mut min: f32 = 0.0;
        let mut max: f32 = 0.0;

        for j in start..end {
            let sample = mono_samples[j];
            if sample < min {
                min = sample;
            }
            if sample > max {
                max = sample;
            }
        }

        waveform.push(min);
        waveform.push(max);
    }

    // Deinterleave samples into separate channel arrays (much faster in Rust than JS)
    let ch = channels as usize;
    let frames = samples.len() / ch;
    let mut channel_data: Vec<Vec<f32>> = (0..ch)
        .map(|_| Vec::with_capacity(frames))
        .collect();

    for frame in 0..frames {
        for c in 0..ch {
            channel_data[c].push(samples[frame * ch + c]);
        }
    }

    let metadata = AudioMetadata {
        duration,
        sample_rate,
        channels,
        bit_depth,
        format: format_name,
    };

    Ok(AudioLoadResult {
        metadata,
        waveform,
        channels: channel_data,
    })
}
