use std::fs::File;
use std::io::Write;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use hound::{WavSpec, WavWriter};
use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm};
use serde::Deserialize;
use tauri::Emitter;

use super::playback::{PcmData, AutomationPoint, load_wav_mmap, load_compressed};

#[tauri::command]
pub async fn export_audio_region(
    source_path: String,
    output_path: String,
    start_time: f64,
    end_time: f64,
) -> Result<(), String> {
    let source = Path::new(&source_path);
    let output = Path::new(&output_path);

    // Open and decode source file
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

    // Calculate sample positions
    let start_sample = (start_time * sample_rate as f64) as u64;
    let end_sample = (end_time * sample_rate as f64) as u64;

    // Collect samples in the region
    let mut all_samples: Vec<f32> = Vec::new();
    let mut current_sample: u64 = 0;

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
        let samples_per_frame = channels as u64;
        let frame_count = samples.len() as u64 / samples_per_frame;

        for i in 0..frame_count {
            let frame_pos = current_sample + i;

            if frame_pos >= start_sample && frame_pos < end_sample {
                for ch in 0..channels as usize {
                    let idx = (i as usize * channels as usize) + ch;
                    if idx < samples.len() {
                        all_samples.push(samples[idx]);
                    }
                }
            }
        }

        current_sample += frame_count;

        if current_sample >= end_sample {
            break;
        }
    }

    // Write WAV file
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output, spec)
        .map_err(|e| format!("Failed to create WAV file: {}", e))?;

    for sample in all_samples {
        writer.write_sample(sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    log::info!("Exported {} to {}", source_path, output_path);

    Ok(())
}

#[tauri::command]
pub async fn export_audio_mp3(
    source_path: String,
    output_path: String,
    start_time: f64,
    end_time: f64,
    bitrate: u32,
) -> Result<(), String> {
    let source = Path::new(&source_path);

    // Open and decode source file
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

    // Calculate sample positions
    let start_sample = (start_time * sample_rate as f64) as u64;
    let end_sample = (end_time * sample_rate as f64) as u64;

    // Collect samples in the region (as interleaved i16 for LAME)
    let mut all_samples: Vec<i16> = Vec::new();
    let mut current_sample: u64 = 0;

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
        let samples_per_frame = channels as u64;
        let frame_count = samples.len() as u64 / samples_per_frame;

        for i in 0..frame_count {
            let frame_pos = current_sample + i;

            if frame_pos >= start_sample && frame_pos < end_sample {
                for ch in 0..channels as usize {
                    let idx = (i as usize * channels as usize) + ch;
                    if idx < samples.len() {
                        // Convert f32 to i16
                        let sample_f32 = samples[idx].clamp(-1.0, 1.0);
                        let sample_i16 = (sample_f32 * 32767.0) as i16;
                        all_samples.push(sample_i16);
                    }
                }
            }
        }

        current_sample += frame_count;

        if current_sample >= end_sample {
            break;
        }
    }

    // InterleavedPcm uses lame_encode_buffer_interleaved which always expects
    // stereo interleaved data (divides sample count by 2). For mono audio,
    // we must duplicate samples to stereo to avoid double-speed encoding.
    let (encode_samples, encode_channels) = if channels == 1 {
        log::info!("Converting mono ({} samples) to stereo for LAME encoding", all_samples.len());
        let stereo: Vec<i16> = all_samples.iter().flat_map(|&s| [s, s]).collect();
        (stereo, 2u16)
    } else {
        (all_samples, channels)
    };

    // Set up LAME encoder
    let mut mp3_encoder = Builder::new().ok_or("Failed to create MP3 encoder")?;
    mp3_encoder.set_num_channels(encode_channels as u8).map_err(|e| format!("Failed to set channels: {:?}", e))?;
    mp3_encoder.set_sample_rate(sample_rate).map_err(|e| format!("Failed to set sample rate: {:?}", e))?;

    // Map bitrate to enum variant (LAME supports specific bitrates)
    let bitrate_enum = match bitrate {
        0..=32 => mp3lame_encoder::Bitrate::Kbps32,
        33..=40 => mp3lame_encoder::Bitrate::Kbps40,
        41..=48 => mp3lame_encoder::Bitrate::Kbps48,
        49..=64 => mp3lame_encoder::Bitrate::Kbps64,
        65..=80 => mp3lame_encoder::Bitrate::Kbps80,
        81..=96 => mp3lame_encoder::Bitrate::Kbps96,
        97..=112 => mp3lame_encoder::Bitrate::Kbps112,
        113..=128 => mp3lame_encoder::Bitrate::Kbps128,
        129..=160 => mp3lame_encoder::Bitrate::Kbps160,
        161..=192 => mp3lame_encoder::Bitrate::Kbps192,
        193..=224 => mp3lame_encoder::Bitrate::Kbps224,
        225..=256 => mp3lame_encoder::Bitrate::Kbps256,
        257..=320 => mp3lame_encoder::Bitrate::Kbps320,
        _ => mp3lame_encoder::Bitrate::Kbps192, // Default fallback
    };
    mp3_encoder.set_brate(bitrate_enum).map_err(|e| format!("Failed to set bitrate: {:?}", e))?;
    mp3_encoder.set_quality(mp3lame_encoder::Quality::Best).map_err(|e| format!("Failed to set quality: {:?}", e))?;

    let mut mp3_encoder = mp3_encoder.build().map_err(|e| format!("Failed to build encoder: {:?}", e))?;

    // Encode to MP3
    // Pre-allocate buffer: LAME needs roughly 1.25x input + 7200 bytes for safety
    let input = InterleavedPcm(&encode_samples);
    let estimated_size = (encode_samples.len() * 5 / 4) + 7200;
    let mut mp3_out: Vec<u8> = Vec::with_capacity(estimated_size);

    // Encode - uses spare_capacity_mut which returns MaybeUninit slice
    let encoded_size = mp3_encoder.encode(input, mp3_out.spare_capacity_mut())
        .map_err(|e| format!("Failed to encode MP3: {:?}", e))?;
    unsafe { mp3_out.set_len(encoded_size); }

    // Flush encoder - reserve more capacity first
    mp3_out.reserve(7200);
    let flush_size = mp3_encoder.flush::<FlushNoGap>(mp3_out.spare_capacity_mut())
        .map_err(|e| format!("Failed to flush encoder: {:?}", e))?;
    unsafe { mp3_out.set_len(mp3_out.len() + flush_size); }

    // Write to file
    std::fs::write(&output_path, &mp3_out)
        .map_err(|e| format!("Failed to write MP3 file: {}", e))?;

    log::info!("Exported MP3 {} to {} ({}kbps)", source_path, output_path, bitrate);

    Ok(())
}

// ── EDL (Edit Decision List) streaming export ──
// Reads source files via mmap/symphonia, mixes in 64K-frame chunks,
// writes directly to output. Memory: O(chunk_size * channels * tracks).

const CHUNK_FRAMES: usize = 65536;

#[derive(Debug, Clone, Deserialize)]
pub struct ExportEDL {
    pub tracks: Vec<ExportEDLTrack>,
    pub output_path: String,
    pub format: String,        // "wav" | "mp3"
    pub sample_rate: u32,
    pub channels: u16,
    pub mp3_bitrate: Option<u32>,
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportEDLTrack {
    pub source_path: String,
    pub track_start: f64,  // timeline offset in seconds
    pub duration: f64,
    pub volume: f32,
    #[serde(default)]
    pub volume_envelope: Option<Vec<AutomationPoint>>,
}

/// Loaded audio source for EDL mixing
struct EdlSource {
    track_start: f64,
    duration: f64,
    volume: f32,
    volume_envelope: Option<Vec<AutomationPoint>>,
    pcm: PcmData,
    sample_rate: u32,
    channels: u16,
}

#[tauri::command]
pub async fn export_edl(edl: ExportEDL, app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        export_edl_inner(&edl, &app)
    }).await.map_err(|e| format!("Export task failed: {}", e))?
}

fn export_edl_inner(edl: &ExportEDL, app: &tauri::AppHandle) -> Result<String, String> {
    log::info!(
        "EDL export: {} tracks, format={}, {}Hz {}ch, {:.1}s-{:.1}s",
        edl.tracks.len(), edl.format, edl.sample_rate, edl.channels,
        edl.start_time, edl.end_time,
    );

    // Load all track sources
    let mut sources: Vec<EdlSource> = Vec::new();
    for track in &edl.tracks {
        let (pcm, sample_rate, channels) = match load_wav_mmap(&track.source_path) {
            Ok(result) => result,
            Err(_) => load_compressed(&track.source_path)?,
        };
        log::info!("  Loaded source: {}Hz {}ch {} samples", sample_rate, channels, pcm.len());
        sources.push(EdlSource {
            track_start: track.track_start,
            duration: track.duration,
            volume: track.volume,
            volume_envelope: track.volume_envelope.clone(),
            pcm,
            sample_rate,
            channels,
        });
    }

    let total_frames = ((edl.end_time - edl.start_time) * edl.sample_rate as f64) as usize;

    let result = match edl.format.as_str() {
        "wav" => export_edl_wav(edl, &sources, total_frames, app),
        "mp3" => export_edl_mp3(edl, &sources, total_frames, app),
        f => Err(format!("Unsupported EDL export format: '{}'. Use 'wav' or 'mp3'.", f)),
    };

    if result.is_ok() {
        log::info!("EDL export complete: {}", edl.output_path);
    }

    result
}

/// Mix source tracks into a buffer for a range of output frames.
/// `mix_buf` is filled with interleaved f32 samples (output_channels per frame).
fn mix_chunk(
    sources: &[EdlSource],
    start_frame: usize,
    frame_count: usize,
    timeline_start: f64,
    output_rate: f64,
    output_channels: usize,
    mix_buf: &mut Vec<f32>,
) {
    mix_buf.clear();
    mix_buf.resize(frame_count * output_channels, 0.0);

    for src in sources {
        let src_rate = src.sample_rate as f64;
        let src_ch = src.channels as usize;
        let samples = src.pcm.samples();
        let mut env_idx: usize = 0;

        for i in 0..frame_count {
            let t = timeline_start + (start_frame + i) as f64 / output_rate;
            let rel_t = t - src.track_start;
            if rel_t < 0.0 || rel_t >= src.duration { continue; }

            // Evaluate volume: use envelope if present, otherwise flat volume
            let vol = match &src.volume_envelope {
                Some(env) if !env.is_empty() => {
                    super::playback::eval_envelope(env, rel_t, src.volume, &mut env_idx)
                }
                _ => src.volume,
            };

            let src_frame = (rel_t * src_rate) as usize;
            let interleaved_idx = src_frame * src_ch;
            if interleaved_idx >= samples.len() { continue; }

            let out_base = i * output_channels;

            if src_ch == 1 {
                let s = samples[interleaved_idx] * vol;
                mix_buf[out_base] += s;
                if output_channels >= 2 {
                    mix_buf[out_base + 1] += s;
                }
            } else {
                mix_buf[out_base] += samples[interleaved_idx] * vol;
                if output_channels >= 2 && interleaved_idx + 1 < samples.len() {
                    mix_buf[out_base + 1] += samples[interleaved_idx + 1] * vol;
                }
            }
        }
    }
}

fn export_edl_wav(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let spec = WavSpec {
        channels: edl.channels,
        sample_rate: edl.sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let mut writer = WavWriter::create(&edl.output_path, spec)
        .map_err(|e| format!("Failed to create WAV: {}", e))?;

    let output_rate = edl.sample_rate as f64;
    let output_channels = edl.channels as usize;
    let mut frames_written = 0usize;
    let mut mix_buf: Vec<f32> = Vec::new();

    while frames_written < total_frames {
        let chunk_size = CHUNK_FRAMES.min(total_frames - frames_written);

        mix_chunk(
            sources, frames_written, chunk_size,
            edl.start_time, output_rate, output_channels, &mut mix_buf,
        );

        for &sample in &mix_buf {
            writer.write_sample(sample)
                .map_err(|e| format!("Write error: {}", e))?;
        }

        frames_written += chunk_size;

        // Emit progress every chunk
        let progress = frames_written as f64 / total_frames as f64;
        let _ = app.emit("export-progress", serde_json::json!({
            "progress": progress,
            "framesWritten": frames_written,
            "totalFrames": total_frames,
        }));
    }

    writer.finalize().map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    Ok(edl.output_path.clone())
}

fn export_edl_mp3(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let bitrate = edl.mp3_bitrate.unwrap_or(192);
    let output_rate = edl.sample_rate;
    let output_channels = edl.channels as usize;

    // LAME always expects stereo interleaved data
    let encode_channels = 2u8;

    let mut builder = Builder::new().ok_or("Failed to create MP3 encoder")?;
    builder.set_num_channels(encode_channels)
        .map_err(|e| format!("Set channels: {:?}", e))?;
    builder.set_sample_rate(output_rate)
        .map_err(|e| format!("Set sample rate: {:?}", e))?;
    builder.set_brate(map_bitrate(bitrate))
        .map_err(|e| format!("Set bitrate: {:?}", e))?;
    builder.set_quality(mp3lame_encoder::Quality::Best)
        .map_err(|e| format!("Set quality: {:?}", e))?;

    let mut encoder = builder.build()
        .map_err(|e| format!("Build encoder: {:?}", e))?;

    let mut output_file = File::create(&edl.output_path)
        .map_err(|e| format!("Create output: {}", e))?;

    let output_rate_f64 = output_rate as f64;
    let mut frames_written = 0usize;
    let mut mix_buf: Vec<f32> = Vec::new();
    let mut chunk_i16: Vec<i16> = Vec::with_capacity(CHUNK_FRAMES * 2);
    // MP3 output buffer: 1.25x input + 7200 safety margin
    let mp3_buf_capacity = CHUNK_FRAMES * 2 * 5 / 4 + 7200;
    let mut mp3_out: Vec<u8> = Vec::with_capacity(mp3_buf_capacity);

    while frames_written < total_frames {
        let chunk_size = CHUNK_FRAMES.min(total_frames - frames_written);

        mix_chunk(
            sources, frames_written, chunk_size,
            edl.start_time, output_rate_f64, output_channels, &mut mix_buf,
        );

        // Convert mix to stereo i16 for LAME
        chunk_i16.clear();
        for i in 0..chunk_size {
            let base = i * output_channels;
            let left = mix_buf[base].clamp(-1.0, 1.0);
            let right = if output_channels >= 2 {
                mix_buf[base + 1].clamp(-1.0, 1.0)
            } else {
                left
            };
            chunk_i16.push((left * 32767.0) as i16);
            chunk_i16.push((right * 32767.0) as i16);
        }

        // Encode chunk to MP3
        mp3_out.clear();
        mp3_out.reserve(mp3_buf_capacity);
        let input = InterleavedPcm(&chunk_i16);
        let encoded = encoder.encode(input, mp3_out.spare_capacity_mut())
            .map_err(|e| format!("Encode error: {:?}", e))?;
        unsafe { mp3_out.set_len(encoded); }
        output_file.write_all(&mp3_out)
            .map_err(|e| format!("Write error: {}", e))?;

        frames_written += chunk_size;

        let progress = frames_written as f64 / total_frames as f64;
        let _ = app.emit("export-progress", serde_json::json!({
            "progress": progress,
            "framesWritten": frames_written,
            "totalFrames": total_frames,
        }));
    }

    // Flush LAME encoder
    mp3_out.clear();
    mp3_out.reserve(7200);
    let flush_size = encoder.flush::<FlushNoGap>(mp3_out.spare_capacity_mut())
        .map_err(|e| format!("Flush error: {:?}", e))?;
    unsafe { mp3_out.set_len(flush_size); }
    output_file.write_all(&mp3_out)
        .map_err(|e| format!("Write error: {}", e))?;

    Ok(edl.output_path.clone())
}

fn map_bitrate(bitrate: u32) -> mp3lame_encoder::Bitrate {
    match bitrate {
        0..=32 => mp3lame_encoder::Bitrate::Kbps32,
        33..=40 => mp3lame_encoder::Bitrate::Kbps40,
        41..=48 => mp3lame_encoder::Bitrate::Kbps48,
        49..=64 => mp3lame_encoder::Bitrate::Kbps64,
        65..=80 => mp3lame_encoder::Bitrate::Kbps80,
        81..=96 => mp3lame_encoder::Bitrate::Kbps96,
        97..=112 => mp3lame_encoder::Bitrate::Kbps112,
        113..=128 => mp3lame_encoder::Bitrate::Kbps128,
        129..=160 => mp3lame_encoder::Bitrate::Kbps160,
        161..=192 => mp3lame_encoder::Bitrate::Kbps192,
        193..=224 => mp3lame_encoder::Bitrate::Kbps224,
        225..=256 => mp3lame_encoder::Bitrate::Kbps256,
        257..=320 => mp3lame_encoder::Bitrate::Kbps320,
        _ => mp3lame_encoder::Bitrate::Kbps192,
    }
}
