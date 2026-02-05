use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSegment {
    pub start: f64,
    pub end: f64,
    pub is_speech: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadResult {
    pub segments: Vec<SpeechSegment>,
    pub speech_segments: Vec<SpeechSegment>,
    pub silence_segments: Vec<SpeechSegment>,
    pub total_speech_duration: f64,
    pub total_silence_duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadOptions {
    /// Minimum RMS energy threshold (0.0 - 1.0) to consider as speech
    pub energy_threshold: f64,
    /// Minimum duration in seconds for a segment to be considered
    pub min_segment_duration: f64,
    /// Frame size in milliseconds for analysis
    pub frame_size_ms: f64,
    /// Padding to add before/after speech segments in seconds
    pub padding: f64,
}

impl Default for VadOptions {
    fn default() -> Self {
        Self {
            energy_threshold: 0.01,
            min_segment_duration: 0.1,
            frame_size_ms: 30.0,
            padding: 0.15,
        }
    }
}

/// Calculate RMS energy of a frame
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// Calculate zero-crossing rate (helps distinguish speech from noise)
/// Speech typically has ZCR of 0.1-0.3, noise/static is higher (0.4+)
fn calculate_zcr(samples: &[f32]) -> f32 {
    if samples.len() < 2 {
        return 0.0;
    }
    let mut crossings = 0;
    for i in 1..samples.len() {
        if (samples[i] >= 0.0) != (samples[i - 1] >= 0.0) {
            crossings += 1;
        }
    }
    crossings as f32 / (samples.len() - 1) as f32
}

/// Detect speech segments using energy-based VAD
#[tauri::command]
pub async fn detect_speech_segments(
    path: String,
    options: Option<VadOptions>,
) -> Result<VadResult, String> {
    let opts = options.unwrap_or_default();
    let path = Path::new(&path);

    // Load audio
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

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Collect all mono samples
    let mut mono_samples: Vec<f32> = Vec::new();

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

    // Calculate frame size in samples
    let frame_size = ((opts.frame_size_ms / 1000.0) * sample_rate) as usize;
    let hop_size = frame_size / 2; // 50% overlap

    // Analyze frames
    let mut frame_energies: Vec<(f64, f32, bool)> = Vec::new(); // (time, energy, is_speech)

    // First pass: calculate all energies and ZCRs to find adaptive thresholds
    let mut all_energies: Vec<f32> = Vec::new();
    let mut all_zcrs: Vec<f32> = Vec::new();

    let mut pos = 0;
    while pos + frame_size <= mono_samples.len() {
        let frame = &mono_samples[pos..pos + frame_size];
        let rms = calculate_rms(frame);
        let zcr = calculate_zcr(frame);
        all_energies.push(rms);
        all_zcrs.push(zcr);
        pos += hop_size;
    }

    // Calculate adaptive threshold based on energy distribution
    if all_energies.is_empty() {
        return Ok(VadResult {
            segments: vec![],
            speech_segments: vec![],
            silence_segments: vec![],
            total_speech_duration: 0.0,
            total_silence_duration: 0.0,
        });
    }

    let mut sorted_energies = all_energies.clone();
    sorted_energies.sort_by(|a, b| a.partial_cmp(b).unwrap());

    // Use percentile-based threshold (noise floor + margin)
    let noise_floor_idx = (sorted_energies.len() as f64 * 0.1) as usize;
    let noise_floor = sorted_energies.get(noise_floor_idx).copied().unwrap_or(0.0);

    let peak_idx = (sorted_energies.len() as f64 * 0.95) as usize;
    let peak = sorted_energies.get(peak_idx).copied().unwrap_or(1.0);

    // Adaptive threshold: above noise floor but scaled by user preference
    let adaptive_threshold = noise_floor + (peak - noise_floor) * opts.energy_threshold as f32;

    // Calculate ZCR threshold - speech typically has ZCR < 0.4, noise is higher
    // Use median ZCR of high-energy frames as reference
    let high_energy_zcrs: Vec<f32> = all_energies.iter()
        .zip(all_zcrs.iter())
        .filter(|(e, _)| **e > adaptive_threshold)
        .map(|(_, z)| *z)
        .collect();

    let zcr_threshold = if high_energy_zcrs.is_empty() {
        0.4 // Default threshold
    } else {
        let mut sorted_zcrs = high_energy_zcrs.clone();
        sorted_zcrs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median_zcr = sorted_zcrs[sorted_zcrs.len() / 2];
        // Allow ZCR up to 1.5x median, but cap at 0.5
        (median_zcr * 1.5).min(0.5)
    };

    // Second pass: classify frames using both energy and ZCR
    pos = 0;
    let mut frame_idx = 0;
    while pos + frame_size <= mono_samples.len() {
        let time = pos as f64 / sample_rate;
        let energy = all_energies[frame_idx];
        let zcr = all_zcrs[frame_idx];

        // Speech: high energy AND reasonable ZCR (not too "noisy")
        let is_speech = energy > adaptive_threshold && zcr < zcr_threshold;

        frame_energies.push((time, energy, is_speech));
        pos += hop_size;
        frame_idx += 1;
    }

    // Apply smoothing (median filter to remove isolated frames)
    let window_size = 5;
    let mut smoothed: Vec<bool> = frame_energies.iter().map(|(_, _, s)| *s).collect();

    for i in 0..smoothed.len() {
        let start = i.saturating_sub(window_size / 2);
        let end = (i + window_size / 2 + 1).min(smoothed.len());
        let speech_count = frame_energies[start..end].iter().filter(|(_, _, s)| *s).count();
        smoothed[i] = speech_count > (end - start) / 2;
    }

    // Convert to segments
    let mut segments: Vec<SpeechSegment> = Vec::new();
    let mut current_is_speech = smoothed.first().copied().unwrap_or(false);
    let mut segment_start = 0.0;

    for (i, &is_speech) in smoothed.iter().enumerate() {
        let time = frame_energies[i].0;

        if is_speech != current_is_speech {
            // End current segment
            if time - segment_start >= opts.min_segment_duration {
                segments.push(SpeechSegment {
                    start: segment_start,
                    end: time,
                    is_speech: current_is_speech,
                });
            }
            segment_start = time;
            current_is_speech = is_speech;
        }
    }

    // Add final segment
    let total_duration = mono_samples.len() as f64 / sample_rate;
    if total_duration - segment_start >= opts.min_segment_duration {
        segments.push(SpeechSegment {
            start: segment_start,
            end: total_duration,
            is_speech: current_is_speech,
        });
    }

    // Apply padding to speech segments and merge close ones
    let mut speech_segments: Vec<SpeechSegment> = Vec::new();
    let mut silence_segments: Vec<SpeechSegment> = Vec::new();

    for seg in &segments {
        if seg.is_speech {
            let padded_start = (seg.start - opts.padding).max(0.0);
            let padded_end = (seg.end + opts.padding).min(total_duration);

            // Merge with previous if overlapping
            if let Some(last) = speech_segments.last_mut() {
                if padded_start <= last.end {
                    last.end = padded_end;
                    continue;
                }
            }

            speech_segments.push(SpeechSegment {
                start: padded_start,
                end: padded_end,
                is_speech: true,
            });
        }
    }

    // Calculate silence segments (gaps between speech)
    let mut prev_end = 0.0;
    for speech in &speech_segments {
        if speech.start > prev_end {
            silence_segments.push(SpeechSegment {
                start: prev_end,
                end: speech.start,
                is_speech: false,
            });
        }
        prev_end = speech.end;
    }
    if prev_end < total_duration {
        silence_segments.push(SpeechSegment {
            start: prev_end,
            end: total_duration,
            is_speech: false,
        });
    }

    let total_speech: f64 = speech_segments.iter().map(|s| s.end - s.start).sum();
    let total_silence: f64 = silence_segments.iter().map(|s| s.end - s.start).sum();

    Ok(VadResult {
        segments,
        speech_segments,
        silence_segments,
        total_speech_duration: total_speech,
        total_silence_duration: total_silence,
    })
}

/// Export audio with silence removed
#[tauri::command]
pub async fn export_without_silence(
    source_path: String,
    output_path: String,
    speech_segments: Vec<SpeechSegment>,
) -> Result<(), String> {
    use hound::{WavSpec, WavWriter};

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

    // Collect all samples
    let mut all_samples: Vec<f32> = Vec::new();

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
        all_samples.extend_from_slice(sample_buf.samples());
    }

    // Extract only speech segments
    let mut output_samples: Vec<f32> = Vec::new();
    let samples_per_frame = channels as usize;

    for seg in &speech_segments {
        if !seg.is_speech {
            continue;
        }

        let start_sample = (seg.start * sample_rate as f64) as usize * samples_per_frame;
        let end_sample = (seg.end * sample_rate as f64) as usize * samples_per_frame;

        let start = start_sample.min(all_samples.len());
        let end = end_sample.min(all_samples.len());

        if start < end {
            output_samples.extend_from_slice(&all_samples[start..end]);
        }
    }

    // Write output WAV
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output, spec)
        .map_err(|e| format!("Failed to create WAV file: {}", e))?;

    for sample in output_samples {
        writer.write_sample(sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    Ok(())
}
