//! Audio cleaning Tauri commands

use std::fs::File;
use std::path::Path;

use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::audio_clean::{self, CleaningOptions, pipeline::SilenceSegment};
use crate::audio_clean::filters::detect_mains_frequency;

/// Result of cleaning operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub output_path: String,
    pub duration: f64,
    pub sample_rate: u32,
}

/// Clean audio with the specified options
#[tauri::command]
pub async fn clean_audio(
    source_path: String,
    output_path: String,
    start_time: Option<f64>,
    end_time: Option<f64>,
    options: CleaningOptions,
    silence_segments: Option<Vec<SilenceSegmentInput>>,
) -> Result<CleanResult, String> {
    let source = Path::new(&source_path);
    let output = Path::new(&output_path);

    // Load source audio
    let file = File::open(source).map_err(|e| format!("Failed to open source: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = source.extension().and_then(|e| e.to_str()) {
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
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u16;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let samples_per_frame = channels as usize;

    // Calculate sample range BEFORE decode loop — only decode the needed region
    let start_sample = start_time
        .map(|t| (t * sample_rate as f64) as usize * samples_per_frame)
        .unwrap_or(0);

    // Pre-decode size guard: estimate region size
    if let (Some(st), Some(et)) = (start_time, end_time) {
        let region_duration = (et - st).max(0.0);
        let estimated_samples = (region_duration * sample_rate as f64) as usize * samples_per_frame;
        let estimated_bytes = estimated_samples * std::mem::size_of::<f32>();
        if estimated_bytes > 2_000_000_000 {
            return Err(format!(
                "Region too large to clean ({:.1}GB estimated). Try a smaller selection.",
                estimated_bytes as f64 / 1_073_741_824.0
            ));
        }
    }

    // Decode only the needed region — skip frames before start, break after end
    let mut region_samples: Vec<f32> = Vec::new();
    let mut decoded_samples: usize = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
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
        let packet_samples = sample_buf.samples();
        let packet_len = packet_samples.len();

        let packet_start = decoded_samples;
        let packet_end = decoded_samples + packet_len;

        // Determine end_sample dynamically (may be unbounded if end_time is None)
        let end_sample = end_time
            .map(|t| (t * sample_rate as f64) as usize * samples_per_frame)
            .unwrap_or(usize::MAX);

        // Skip packets entirely before the region
        if packet_end <= start_sample {
            decoded_samples += packet_len;
            continue;
        }

        // Break if we've passed the region
        if packet_start >= end_sample {
            break;
        }

        // Collect the overlapping portion
        let copy_start = start_sample.saturating_sub(packet_start);
        let copy_end = (end_sample - packet_start).min(packet_len);
        if copy_start < copy_end {
            region_samples.extend_from_slice(&packet_samples[copy_start..copy_end]);
        }

        decoded_samples += packet_len;
    }

    if region_samples.is_empty() {
        return Err("Invalid time range or no audio in selection".to_string());
    }

    // Convert silence segments to sample indices
    let silence_segs: Option<Vec<SilenceSegment>> = silence_segments.map(|segs| {
        segs.iter()
            .map(|seg| {
                let seg_start = ((seg.start - start_time.unwrap_or(0.0)) * sample_rate as f64) as usize * samples_per_frame;
                let seg_end = ((seg.end - start_time.unwrap_or(0.0)) * sample_rate as f64) as usize * samples_per_frame;
                SilenceSegment {
                    start_sample: seg_start.min(region_samples.len()),
                    end_sample: seg_end.min(region_samples.len()),
                }
            })
            .filter(|seg| seg.start_sample < seg.end_sample)
            .collect()
    });

    // Process mono for cleaning (average channels)
    let mono_len = region_samples.len() / samples_per_frame;
    let mut mono_samples: Vec<f32> = Vec::with_capacity(mono_len);

    for chunk in region_samples.chunks(samples_per_frame) {
        let mono = chunk.iter().sum::<f32>() / samples_per_frame as f32;
        mono_samples.push(mono);
    }

    // Run the cleaning pipeline
    audio_clean::process_audio(
        &mut mono_samples,
        sample_rate as f32,
        &options,
        silence_segs.as_deref(),
    )?;

    // Expand mono back to original channel count
    let mut output_samples: Vec<f32> = Vec::with_capacity(region_samples.len());
    for sample in mono_samples {
        for _ in 0..samples_per_frame {
            output_samples.push(sample);
        }
    }

    // Write output WAV
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let mut writer =
        WavWriter::create(output, spec).map_err(|e| format!("Failed to create WAV file: {}", e))?;

    for sample in &output_samples {
        writer
            .write_sample(*sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    let output_duration = output_samples.len() as f64 / (sample_rate as f64 * samples_per_frame as f64);

    Ok(CleanResult {
        output_path: output_path,
        duration: output_duration,
        sample_rate,
    })
}

/// Input format for silence segments from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceSegmentInput {
    pub start: f64,
    pub end: f64,
}

/// Detect the mains frequency (50Hz or 60Hz) in the audio
#[tauri::command]
pub async fn detect_mains_freq(source_path: String) -> Result<f32, String> {
    let source = Path::new(&source_path);

    // Load audio
    let file = File::open(source).map_err(|e| format!("Failed to open source: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = source.extension().and_then(|e| e.to_str()) {
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
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100) as f32;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Collect samples (only need a few seconds for detection)
    let mut mono_samples: Vec<f32> = Vec::new();
    let max_samples = (sample_rate * 5.0) as usize; // 5 seconds max

    loop {
        if mono_samples.len() >= max_samples {
            break;
        }

        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
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

        // Mix to mono
        for chunk in sample_buf.samples().chunks(channels) {
            let mono = chunk.iter().sum::<f32>() / channels as f32;
            mono_samples.push(mono);
        }
    }

    // Detect mains frequency
    let mains = detect_mains_frequency(&mono_samples, sample_rate);

    Ok(mains)
}

/// Get a temporary file path for cleaned audio
#[tauri::command]
pub async fn get_temp_audio_path() -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let uuid = uuid::Uuid::new_v4();
    let filename = format!("cleaned_{}.wav", uuid);
    let path = temp_dir.join(filename);

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_temp_audio_path() {
        let path = get_temp_audio_path().await.unwrap();
        assert!(path.contains("cleaned_"));
        assert!(path.ends_with(".wav"));
    }
}
