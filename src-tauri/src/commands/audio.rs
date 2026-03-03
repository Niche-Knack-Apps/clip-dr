use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::playback::{load_wav_mmap, load_compressed};

/// Returns true for formats that require full symphonia decode (no mmap seek).
/// Used by PERF-01 guard to prevent OOM on large compressed extractions.
fn is_compressed_format(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    matches!(ext.as_deref(), Some("mp3") | Some("ogg") | Some("flac") | Some("m4a") | Some("aac"))
}

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

    // Try WAV/RF64 header first — symphonia doesn't support RF64 format
    if let Some(wav_meta) = super::import::try_wav_metadata(path) {
        return Ok(wav_meta);
    }

    // Symphonia probe for compressed formats (MP3, FLAC, OGG, M4A)
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

    // Guard: refuse full-file decode for large files
    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Cannot stat file: {}", e))?.len();
    const LARGE_FILE_BYTE_THRESHOLD: u64 = 200 * 1024 * 1024; // 200MB compressed
    if file_size > LARGE_FILE_BYTE_THRESHOLD {
        return Err(format!(
            "File too large ({:.0}MB) for full decode. Use the streaming pipeline instead.",
            file_size as f64 / 1024.0 / 1024.0
        ));
    }

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

    // Guard: refuse full-file decode for large files
    let file_size = std::fs::metadata(path_ref)
        .map_err(|e| format!("Cannot stat file: {}", e))?.len();
    const LARGE_FILE_BYTE_THRESHOLD: u64 = 200 * 1024 * 1024; // 200MB compressed
    if file_size > LARGE_FILE_BYTE_THRESHOLD {
        return Err(format!(
            "File too large ({:.0}MB) for full decode. Use the streaming pipeline instead.",
            file_size as f64 / 1024.0 / 1024.0
        ));
    }

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

/// Result for region extraction — deinterleaved f32 channel data
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRegionResult {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub channel_count: u16,
}

/// Extract a time region from a WAV/RF64 file and return deinterleaved f32 channel data.
/// Uses load_wav_mmap (fast path for cached decode WAVs) with fallback to symphonia decode.
#[tauri::command]
pub async fn extract_audio_region_samples(
    source_path: String,
    start_time: f64,
    end_time: f64,
) -> Result<AudioRegionResult, String> {
    if end_time <= start_time {
        return Err("end_time must be greater than start_time".to_string());
    }

    // Try WAV mmap first (fast path), fall back to compressed decode
    // PERF-01 mitigation: refuse >5min extraction from compressed formats to prevent OOM
    let (pcm, sample_rate, channels) = match load_wav_mmap(&source_path) {
        Ok(result) => result,
        Err(_) => {
            let duration = end_time - start_time;
            if is_compressed_format(&source_path) && duration > 300.0 {
                return Err(format!(
                    "Extracting {:.0}min from a compressed file is not supported. Re-import as WAV first.",
                    duration / 60.0
                ));
            }
            load_compressed(&source_path)?
        }
    };

    let ch = channels as usize;
    let start_frame = (start_time * sample_rate as f64) as usize;
    let end_frame = (end_time * sample_rate as f64) as usize;

    let samples = pcm.samples();
    let total_frames = samples.len() / ch;
    let start_frame = start_frame.min(total_frames);
    let end_frame = end_frame.min(total_frames);

    if end_frame <= start_frame {
        return Err("Region is empty after clamping to file bounds".to_string());
    }

    let region_frames = end_frame - start_frame;

    // Size guard: reject if region > 512MB of f32 data
    let region_bytes = region_frames * ch * 4;
    if region_bytes > 512 * 1024 * 1024 {
        return Err(format!(
            "Region too large ({:.0}MB). Select a smaller region.",
            region_bytes as f64 / 1024.0 / 1024.0
        ));
    }

    // Deinterleave into separate channel arrays
    let mut channel_data: Vec<Vec<f32>> = (0..ch)
        .map(|_| Vec::with_capacity(region_frames))
        .collect();

    let start_sample = start_frame * ch;
    for frame in 0..region_frames {
        let base = start_sample + frame * ch;
        for c in 0..ch {
            channel_data[c].push(samples[base + c]);
        }
    }

    Ok(AudioRegionResult {
        channels: channel_data,
        sample_rate,
        channel_count: channels,
    })
}

/// Result of a WAV splice (cut region removed, written as new file on disk).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpliceResult {
    /// Path to the new WAV file with the "before" portion
    pub before_path: String,
    pub before_duration: f64,
    /// Path to the new WAV file with the "after" portion
    pub after_path: String,
    pub after_duration: f64,
}

/// Remove a time region from a WAV/RF64 file by writing the "before" and "after"
/// portions as two separate WAV files. This is used for cut/delete on large files
/// where in-memory AudioBuffer splicing isn't possible.
#[tauri::command]
pub async fn splice_wav_remove_region(
    source_path: String,
    start_time: f64,
    end_time: f64,
) -> Result<SpliceResult, String> {
    use memmap2::Mmap;
    use std::io::Write as IoWrite;

    if end_time <= start_time {
        return Err("end_time must be greater than start_time".to_string());
    }

    let path = Path::new(&source_path);
    let file = File::open(path)
        .map_err(|e| format!("Failed to open source: {}", e))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| format!("Failed to mmap source: {}", e))?;

    let wav = super::import::parse_wav_header(&mmap)
        .ok_or_else(|| "Not a valid WAV/RF64 file".to_string())?;

    let bytes_per_sample = (wav.bits_per_sample / 8) as usize;
    let frame_size = bytes_per_sample * wav.channels as usize;
    if frame_size == 0 {
        return Err("Invalid frame size".to_string());
    }

    let total_frames = wav.data_size / frame_size;
    let cut_start_frame = ((start_time * wav.sample_rate as f64) as usize).min(total_frames);
    let cut_end_frame = ((end_time * wav.sample_rate as f64) as usize).min(total_frames);

    if cut_end_frame <= cut_start_frame {
        return Err("Empty cut region after clamping".to_string());
    }

    let data = &mmap[wav.data_offset..wav.data_offset + wav.data_size.min(mmap.len() - wav.data_offset)];

    let data_dir = crate::services::path_service::get_user_data_dir()
        .map_err(|e| format!("Path service error: {}", e))?;
    let cache_dir = data_dir.join("splice-cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create splice-cache dir: {}", e))?;

    let before_frames = cut_start_frame;
    let after_frames = total_frames - cut_end_frame;

    let before_path = cache_dir.join(format!("before_{}.wav", uuid::Uuid::new_v4()));
    let after_path = cache_dir.join(format!("after_{}.wav", uuid::Uuid::new_v4()));

    // Write "before" WAV (frames 0..cut_start)
    write_wav_segment(
        &before_path, &wav, &data[..before_frames * frame_size],
        before_frames,
    )?;

    // Write "after" WAV (frames cut_end..total)
    let after_start_byte = cut_end_frame * frame_size;
    write_wav_segment(
        &after_path, &wav, &data[after_start_byte..],
        after_frames,
    )?;

    let before_duration = before_frames as f64 / wav.sample_rate as f64;
    let after_duration = after_frames as f64 / wav.sample_rate as f64;

    log::info!(
        "[Audio] Splice complete: before={:.1}s, after={:.1}s, removed={:.1}s",
        before_duration, after_duration, end_time - start_time
    );

    Ok(SpliceResult {
        before_path: before_path.to_string_lossy().to_string(),
        before_duration,
        after_path: after_path.to_string_lossy().to_string(),
        after_duration,
    })
}

/// Write PCM data as a WAV file, preserving the original format (sample rate, channels, bit depth).
fn write_wav_segment(
    path: &std::path::PathBuf,
    wav: &super::import::WavInfo,
    pcm_data: &[u8],
    _frame_count: usize,
) -> Result<(), String> {
    use std::io::Write as IoWrite;

    let data_size = pcm_data.len();
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create WAV: {}", e))?;
    let mut out = std::io::BufWriter::new(file);

    let block_align = (wav.bits_per_sample / 8) as u16 * wav.channels;
    let byte_rate = wav.sample_rate * block_align as u32;

    // Determine RIFF vs RF64
    let total_file_size = 36 + data_size; // 12 (RIFF header) + 24 (fmt chunk) + data header + data
    let use_rf64 = total_file_size > 0xFFFF_FFFE;

    if use_rf64 {
        // RF64 header
        out.write_all(b"RF64").map_err(|e| e.to_string())?;
        out.write_all(&0xFFFF_FFFFu32.to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(b"WAVE").map_err(|e| e.to_string())?;
        // ds64 chunk
        let riff_size_64 = (total_file_size - 8) as u64;
        let data_size_64 = data_size as u64;
        let sample_count_64 = _frame_count as u64;
        out.write_all(b"ds64").map_err(|e| e.to_string())?;
        out.write_all(&28u32.to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(&riff_size_64.to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(&data_size_64.to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(&sample_count_64.to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // table length
    } else {
        out.write_all(b"RIFF").map_err(|e| e.to_string())?;
        out.write_all(&((total_file_size - 8) as u32).to_le_bytes()).map_err(|e| e.to_string())?;
        out.write_all(b"WAVE").map_err(|e| e.to_string())?;
    }

    // fmt chunk
    out.write_all(b"fmt ").map_err(|e| e.to_string())?;
    out.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&wav.audio_format.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&wav.channels.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&wav.sample_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&byte_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&block_align.to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(&wav.bits_per_sample.to_le_bytes()).map_err(|e| e.to_string())?;

    // data chunk
    out.write_all(b"data").map_err(|e| e.to_string())?;
    if use_rf64 {
        out.write_all(&0xFFFF_FFFFu32.to_le_bytes()).map_err(|e| e.to_string())?;
    } else {
        out.write_all(&(data_size as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    }

    // Write PCM data in chunks
    const CHUNK_SIZE: usize = 4 * 1024 * 1024;
    for chunk in pcm_data.chunks(CHUNK_SIZE) {
        out.write_all(chunk).map_err(|e| format!("Write error: {}", e))?;
    }

    out.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}
