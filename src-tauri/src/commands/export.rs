use std::fs::File;
use std::io::{Write, BufWriter};
use std::path::Path;
use std::num::{NonZeroU32, NonZeroU8};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use hound::{WavSpec, WavWriter};
use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};
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
    export_audio_region_inner(&source_path, &output_path, start_time, end_time)
}

fn export_audio_region_inner(
    source_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
) -> Result<(), String> {
    let source = Path::new(source_path);
    let output = Path::new(output_path);

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
    export_audio_mp3_inner(&source_path, &output_path, start_time, end_time, bitrate)
}

fn export_audio_mp3_inner(
    source_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
    bitrate: u32,
) -> Result<(), String> {
    let source = Path::new(source_path);

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
    let bitrate_enum = map_bitrate(bitrate);
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
    std::fs::write(output_path, &mp3_out)
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
    pub format: String,        // "wav" | "mp3" | "flac" | "ogg"
    pub sample_rate: u32,
    pub channels: u16,
    pub mp3_bitrate: Option<u32>,
    pub ogg_quality: Option<f32>,  // 0.0–1.0 for OGG Vorbis quality
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
        "wav"  => export_edl_wav(edl, &sources, total_frames, app),
        "mp3"  => export_edl_mp3(edl, &sources, total_frames, app),
        "flac" => export_edl_flac(edl, &sources, total_frames, app),
        "ogg"  => export_edl_ogg(edl, &sources, total_frames, app),
        f => Err(format!("Unsupported EDL export format: '{}'", f)),
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

/// Convert a WAV file to FLAC using ffmpeg subprocess.
/// flacenc's output is incompatible with symphonia's FLAC reader, so we use
/// ffmpeg which produces universally compatible FLAC files.
fn wav_to_flac(wav_path: &str, flac_path: &str) -> Result<(), String> {
    let output = std::process::Command::new("ffmpeg")
        .args(["-y", "-i", wav_path, "-c:a", "flac", flac_path])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg (is it installed?): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg FLAC conversion failed: {}", stderr));
    }

    Ok(())
}

fn export_edl_flac(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // Write a temporary WAV, then convert to FLAC via ffmpeg
    let temp_wav = format!("{}.tmp.wav", edl.output_path);
    let temp_edl = ExportEDL {
        output_path: temp_wav.clone(),
        format: "wav".to_string(),
        ..edl.clone()
    };

    export_edl_wav(&temp_edl, sources, total_frames, app)?;

    wav_to_flac(&temp_wav, &edl.output_path)?;

    // Clean up temp WAV
    let _ = std::fs::remove_file(&temp_wav);

    let _ = app.emit("export-progress", serde_json::json!({
        "progress": 1.0,
        "framesWritten": total_frames,
        "totalFrames": total_frames,
    }));

    Ok(edl.output_path.clone())
}

fn export_edl_ogg(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let quality = edl.ogg_quality.unwrap_or(0.4);
    let output_rate = edl.sample_rate;
    let output_channels = edl.channels as usize;

    let output_file = BufWriter::new(
        File::create(&edl.output_path)
            .map_err(|e| format!("Create output: {}", e))?,
    );

    let sample_rate = NonZeroU32::new(output_rate)
        .ok_or("Sample rate must be non-zero")?;
    let channels = NonZeroU8::new(edl.channels as u8)
        .ok_or("Channels must be non-zero")?;

    let mut encoder = VorbisEncoderBuilder::new(sample_rate, channels, output_file)
        .map_err(|e| format!("Vorbis builder error: {}", e))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: quality,
        })
        .build()
        .map_err(|e| format!("Vorbis build error: {}", e))?;

    let output_rate_f64 = output_rate as f64;
    let mut frames_written = 0usize;
    let mut mix_buf: Vec<f32> = Vec::new();

    while frames_written < total_frames {
        let chunk_size = CHUNK_FRAMES.min(total_frames - frames_written);

        mix_chunk(
            sources, frames_written, chunk_size,
            edl.start_time, output_rate_f64, output_channels, &mut mix_buf,
        );

        // Deinterleave to planar f32 for Vorbis
        let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(chunk_size); output_channels];
        for i in 0..chunk_size {
            let base = i * output_channels;
            for ch in 0..output_channels {
                planar[ch].push(mix_buf[base + ch].clamp(-1.0, 1.0));
            }
        }

        encoder.encode_audio_block(&planar)
            .map_err(|e| format!("Vorbis encode error: {}", e))?;

        frames_written += chunk_size;

        let progress = frames_written as f64 / total_frames as f64;
        let _ = app.emit("export-progress", serde_json::json!({
            "progress": progress,
            "framesWritten": frames_written,
            "totalFrames": total_frames,
        }));
    }

    encoder.finish()
        .map_err(|e| format!("Vorbis finish error: {}", e))?;

    Ok(edl.output_path.clone())
}

#[tauri::command]
pub async fn export_audio_flac(
    source_path: String,
    output_path: String,
    start_time: f64,
    end_time: f64,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        export_audio_flac_inner(&source_path, &output_path, start_time, end_time)
    }).await.map_err(|e| format!("FLAC export task failed: {}", e))?
}

fn export_audio_flac_inner(
    source_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
) -> Result<(), String> {
    // Export as temp WAV first, then convert to FLAC via ffmpeg
    let temp_wav = format!("{}.tmp.wav", output_path);

    export_audio_region_inner(source_path, &temp_wav, start_time, end_time)?;
    wav_to_flac(&temp_wav, output_path)?;
    let _ = std::fs::remove_file(&temp_wav);

    log::info!("Exported FLAC {} to {}", source_path, output_path);
    Ok(())
}

#[tauri::command]
pub async fn export_audio_ogg(
    source_path: String,
    output_path: String,
    start_time: f64,
    end_time: f64,
    quality: f32,
) -> Result<(), String> {
    // VorbisEncoder is !Send, so we must run in spawn_blocking
    tokio::task::spawn_blocking(move || {
        export_audio_ogg_inner(&source_path, &output_path, start_time, end_time, quality)
    }).await.map_err(|e| format!("OGG export task failed: {}", e))?
}

fn export_audio_ogg_inner(
    source_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
    quality: f32,
) -> Result<(), String> {
    let source = Path::new(source_path);

    let file = File::open(source).map_err(|e| format!("Failed to open source: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = source.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Failed to probe format: {}", e))?;

    let mut format = probed.format;

    let track = format.tracks().iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("No audio tracks found")?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u16;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let start_sample = (start_time * sample_rate as f64) as u64;
    let end_sample = (end_time * sample_rate as f64) as u64;

    // Set up Vorbis encoder BEFORE decode loop — encode in chunks
    let output_file = BufWriter::new(
        File::create(output_path)
            .map_err(|e| format!("Create output: {}", e))?,
    );

    let sr = NonZeroU32::new(sample_rate)
        .ok_or("Sample rate must be non-zero")?;
    let ch = NonZeroU8::new(channels as u8)
        .ok_or("Channels must be non-zero")?;

    let mut encoder = VorbisEncoderBuilder::new(sr, ch, output_file)
        .map_err(|e| format!("Vorbis builder error: {}", e))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: quality,
        })
        .build()
        .map_err(|e| format!("Vorbis build error: {}", e))?;

    // Decode and encode in chunks — avoids collecting all samples in memory
    let ch_count = channels as usize;
    let mut current_sample: u64 = 0;
    let mut chunk_buf: Vec<f32> = Vec::new(); // interleaved chunk accumulator
    let chunk_frame_limit = CHUNK_FRAMES; // reuse the 64K frame constant

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(_) => break,
        };

        if packet.track_id() != track_id { continue; }

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
                for c in 0..ch_count {
                    let idx = (i as usize * ch_count) + c;
                    if idx < samples.len() {
                        chunk_buf.push(samples[idx]);
                    }
                }
            }
        }

        current_sample += frame_count;

        // Flush chunk to encoder when large enough
        let chunk_frames = chunk_buf.len() / ch_count;
        if chunk_frames >= chunk_frame_limit {
            let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(chunk_frames); ch_count];
            for i in 0..chunk_frames {
                let base = i * ch_count;
                for c in 0..ch_count {
                    planar[c].push(chunk_buf[base + c].clamp(-1.0, 1.0));
                }
            }
            encoder.encode_audio_block(&planar)
                .map_err(|e| format!("Vorbis encode error: {}", e))?;
            chunk_buf.clear();
        }

        if current_sample >= end_sample { break; }
    }

    // Flush remaining samples
    let remaining_frames = chunk_buf.len() / ch_count;
    if remaining_frames > 0 {
        let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(remaining_frames); ch_count];
        for i in 0..remaining_frames {
            let base = i * ch_count;
            for c in 0..ch_count {
                planar[c].push(chunk_buf[base + c].clamp(-1.0, 1.0));
            }
        }
        encoder.encode_audio_block(&planar)
            .map_err(|e| format!("Vorbis encode error: {}", e))?;
    }

    encoder.finish()
        .map_err(|e| format!("Vorbis finish error: {}", e))?;

    log::info!("Exported OGG {} to {} (quality {})", source_path, output_path, quality);
    Ok(())
}

#[tauri::command]
pub fn check_ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── EDL WAV export without AppHandle (for testing) ──

fn export_edl_wav_no_progress(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
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
    }

    writer.finalize().map_err(|e| format!("Failed to finalize WAV: {}", e))?;
    Ok(edl.output_path.clone())
}

// ── EDL MP3 export without AppHandle (for testing) ──

fn export_edl_mp3_no_progress(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
) -> Result<String, String> {
    let bitrate = edl.mp3_bitrate.unwrap_or(192);
    let output_rate = edl.sample_rate;
    let output_channels = edl.channels as usize;
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
    let mp3_buf_capacity = CHUNK_FRAMES * 2 * 5 / 4 + 7200;
    let mut mp3_out: Vec<u8> = Vec::with_capacity(mp3_buf_capacity);

    while frames_written < total_frames {
        let chunk_size = CHUNK_FRAMES.min(total_frames - frames_written);
        mix_chunk(
            sources, frames_written, chunk_size,
            edl.start_time, output_rate_f64, output_channels, &mut mix_buf,
        );

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

        mp3_out.clear();
        mp3_out.reserve(mp3_buf_capacity);
        let input = InterleavedPcm(&chunk_i16);
        let encoded = encoder.encode(input, mp3_out.spare_capacity_mut())
            .map_err(|e| format!("Encode error: {:?}", e))?;
        unsafe { mp3_out.set_len(encoded); }
        output_file.write_all(&mp3_out)
            .map_err(|e| format!("Write error: {}", e))?;

        frames_written += chunk_size;
    }

    mp3_out.clear();
    mp3_out.reserve(7200);
    let flush_size = encoder.flush::<FlushNoGap>(mp3_out.spare_capacity_mut())
        .map_err(|e| format!("Flush error: {:?}", e))?;
    unsafe { mp3_out.set_len(flush_size); }
    output_file.write_all(&mp3_out)
        .map_err(|e| format!("Write error: {}", e))?;

    Ok(edl.output_path.clone())
}

// ── EDL OGG export without AppHandle (for testing) ──

fn export_edl_ogg_no_progress(
    edl: &ExportEDL,
    sources: &[EdlSource],
    total_frames: usize,
) -> Result<String, String> {
    let quality = edl.ogg_quality.unwrap_or(0.4);
    let output_rate = edl.sample_rate;
    let output_channels = edl.channels as usize;

    let output_file = BufWriter::new(
        File::create(&edl.output_path)
            .map_err(|e| format!("Create output: {}", e))?,
    );

    let sample_rate = NonZeroU32::new(output_rate)
        .ok_or("Sample rate must be non-zero")?;
    let channels = NonZeroU8::new(edl.channels as u8)
        .ok_or("Channels must be non-zero")?;

    let mut encoder = VorbisEncoderBuilder::new(sample_rate, channels, output_file)
        .map_err(|e| format!("Vorbis builder error: {}", e))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: quality,
        })
        .build()
        .map_err(|e| format!("Vorbis build error: {}", e))?;

    let output_rate_f64 = output_rate as f64;
    let mut frames_written = 0usize;
    let mut mix_buf: Vec<f32> = Vec::new();

    while frames_written < total_frames {
        let chunk_size = CHUNK_FRAMES.min(total_frames - frames_written);
        mix_chunk(
            sources, frames_written, chunk_size,
            edl.start_time, output_rate_f64, output_channels, &mut mix_buf,
        );

        let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(chunk_size); output_channels];
        for i in 0..chunk_size {
            let base = i * output_channels;
            for ch in 0..output_channels {
                planar[ch].push(mix_buf[base + ch].clamp(-1.0, 1.0));
            }
        }

        encoder.encode_audio_block(&planar)
            .map_err(|e| format!("Vorbis encode error: {}", e))?;

        frames_written += chunk_size;
    }

    encoder.finish()
        .map_err(|e| format!("Vorbis finish error: {}", e))?;

    Ok(edl.output_path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::playback::load_wav_mmap;

    const SAMPLE_RATE: u32 = 44100;

    /// Helper: create a stereo WAV file with a 440Hz sine tone of the given duration.
    fn create_test_wav(path: &std::path::Path, duration_secs: f64) {
        let spec = WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        let num_frames = (duration_secs * SAMPLE_RATE as f64) as usize;
        for i in 0..num_frames {
            let t = i as f64 / SAMPLE_RATE as f64;
            let sample = (t * 440.0 * 2.0 * std::f64::consts::PI).sin() as f32 * 0.5;
            writer.write_sample(sample).unwrap(); // L
            writer.write_sample(sample).unwrap(); // R
        }
        writer.finalize().unwrap();
    }

    /// Helper: read a WAV file and return (num_frames, sample_rate, channels).
    fn read_wav_info(path: &std::path::Path) -> (usize, u32, u16) {
        let reader = hound::WavReader::open(path).unwrap();
        let spec = reader.spec();
        let total_samples = reader.len() as usize;
        let num_frames = total_samples / spec.channels as usize;
        (num_frames, spec.sample_rate, spec.channels)
    }

    // ── Non-EDL export tests (direct file → file) ──

    /// Regression: WAV export of edited (shorter) source produces correct duration.
    /// This is the export path used when JS mixing falls back to Rust.
    #[test]
    fn test_wav_export_uses_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_path = dir.path().join("output.wav");

        // Create a 2-second "original" and a 1-second "edited" WAV
        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // Export using the EDITED source (simulating cachedAudioPath)
        let edited_str = edited_path.to_str().unwrap();
        let output_str = output_path.to_str().unwrap();
        export_audio_region_inner(edited_str, output_str, 0.0, 1.0).unwrap();

        // Verify the output matches the edited duration, not the original
        let (frames, sr, ch) = read_wav_info(&output_path);
        assert_eq!(sr, SAMPLE_RATE);
        assert_eq!(ch, 2);
        let output_duration = frames as f64 / sr as f64;
        assert!(
            (output_duration - 1.0).abs() < 0.01,
            "Expected ~1.0s output from edited source, got {:.3}s",
            output_duration
        );

        // Verify it's NOT the original's duration
        let (orig_frames, _, _) = read_wav_info(&original_path);
        assert!(
            frames < orig_frames,
            "Output frames ({}) should be less than original ({})",
            frames,
            orig_frames
        );
    }

    /// Regression: MP3 export of edited source produces shorter file than original.
    #[test]
    fn test_mp3_export_uses_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_from_original = dir.path().join("from_original.mp3");
        let output_from_edited = dir.path().join("from_edited.mp3");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // Export both: original (2s) and edited (1s)
        export_audio_mp3_inner(
            original_path.to_str().unwrap(),
            output_from_original.to_str().unwrap(),
            0.0, 2.0, 192,
        ).unwrap();

        export_audio_mp3_inner(
            edited_path.to_str().unwrap(),
            output_from_edited.to_str().unwrap(),
            0.0, 1.0, 192,
        ).unwrap();

        // The edited export should be significantly smaller than the original
        let original_size = std::fs::metadata(&output_from_original).unwrap().len();
        let edited_size = std::fs::metadata(&output_from_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "Edited MP3 ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
        // Roughly half the size (1s vs 2s) - allow wide tolerance for MP3 framing
        let ratio = edited_size as f64 / original_size as f64;
        assert!(
            ratio < 0.75,
            "Edited/original size ratio {:.2} too high — export may be using original source",
            ratio
        );
    }

    /// Regression: OGG export of edited source produces correct duration.
    #[test]
    fn test_ogg_export_uses_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_from_original = dir.path().join("from_original.ogg");
        let output_from_edited = dir.path().join("from_edited.ogg");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        export_audio_ogg_inner(
            original_path.to_str().unwrap(),
            output_from_original.to_str().unwrap(),
            0.0, 2.0, 0.4,
        ).unwrap();

        export_audio_ogg_inner(
            edited_path.to_str().unwrap(),
            output_from_edited.to_str().unwrap(),
            0.0, 1.0, 0.4,
        ).unwrap();

        let original_size = std::fs::metadata(&output_from_original).unwrap().len();
        let edited_size = std::fs::metadata(&output_from_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "Edited OGG ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
        let ratio = edited_size as f64 / original_size as f64;
        assert!(
            ratio < 0.75,
            "Edited/original size ratio {:.2} too high — export may be using original source",
            ratio
        );
    }

    /// Regression: FLAC export of edited source produces correct duration.
    /// Requires ffmpeg — skips gracefully if unavailable.
    #[test]
    fn test_flac_export_uses_edited_source() {
        if !check_ffmpeg_available() {
            eprintln!("Skipping FLAC test: ffmpeg not available");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_from_original = dir.path().join("from_original.flac");
        let output_from_edited = dir.path().join("from_edited.flac");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        export_audio_flac_inner(
            original_path.to_str().unwrap(),
            output_from_original.to_str().unwrap(),
            0.0, 2.0,
        ).unwrap();

        export_audio_flac_inner(
            edited_path.to_str().unwrap(),
            output_from_edited.to_str().unwrap(),
            0.0, 1.0,
        ).unwrap();

        let original_size = std::fs::metadata(&output_from_original).unwrap().len();
        let edited_size = std::fs::metadata(&output_from_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "Edited FLAC ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
        let ratio = edited_size as f64 / original_size as f64;
        assert!(
            ratio < 0.75,
            "Edited/original size ratio {:.2} too high — export may be using original source",
            ratio
        );
    }

    // ── EDL export tests (streaming chunked pipeline) ──

    /// Helper: build an EdlSource from a WAV file path.
    fn load_edl_source(path: &std::path::Path, track_start: f64, duration: f64) -> EdlSource {
        let path_str = path.to_str().unwrap();
        let (pcm, sample_rate, channels) = load_wav_mmap(path_str).unwrap();
        EdlSource {
            track_start,
            duration,
            volume: 1.0,
            volume_envelope: None,
            pcm,
            sample_rate,
            channels,
        }
    }

    /// Regression: EDL mix_chunk reads correct samples from edited (shorter) source.
    #[test]
    fn test_edl_mix_chunk_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // Load the edited source as an EdlSource
        let source = load_edl_source(&edited_path, 0.0, 1.0);

        // Mix 1 second of frames from the edited source
        let frame_count = SAMPLE_RATE as usize; // 1 second
        let mut mix_buf = Vec::new();
        mix_chunk(
            &[source],
            0, frame_count,
            0.0, SAMPLE_RATE as f64, 2, &mut mix_buf,
        );

        assert_eq!(mix_buf.len(), frame_count * 2, "Expected {} samples, got {}", frame_count * 2, mix_buf.len());

        // Verify the mixed output contains non-zero audio (the 440Hz tone)
        let max_val = mix_buf.iter().copied().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(max_val > 0.1, "Mixed audio should contain audible signal, max={}", max_val);

        // Verify that frames beyond the edited source's duration produce silence
        let extra_frames = SAMPLE_RATE as usize; // another second
        let mut silence_buf = Vec::new();
        mix_chunk(
            &[load_edl_source(&edited_path, 0.0, 1.0)],
            frame_count, extra_frames,
            0.0, SAMPLE_RATE as f64, 2, &mut silence_buf,
        );

        let max_silence = silence_buf.iter().copied().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(
            max_silence < 0.001,
            "Frames beyond edited source duration should be silent, max={}",
            max_silence
        );
    }

    /// Regression: EDL WAV export with edited source produces correct output duration.
    #[test]
    fn test_edl_wav_export_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_path = dir.path().join("edl_output.wav");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        let source = load_edl_source(&edited_path, 0.0, 1.0);
        let total_frames = (1.0 * SAMPLE_RATE as f64) as usize;

        let edl = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: edited_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 1.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: output_path.to_str().unwrap().to_string(),
            format: "wav".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: None,
            ogg_quality: None,
            start_time: 0.0,
            end_time: 1.0,
        };

        export_edl_wav_no_progress(&edl, &[source], total_frames).unwrap();

        let (frames, sr, ch) = read_wav_info(&output_path);
        assert_eq!(sr, SAMPLE_RATE);
        assert_eq!(ch, 2);
        let output_duration = frames as f64 / sr as f64;
        assert!(
            (output_duration - 1.0).abs() < 0.01,
            "EDL WAV export should be ~1.0s, got {:.3}s",
            output_duration
        );

        // Must NOT be the original's duration
        let (orig_frames, _, _) = read_wav_info(&original_path);
        assert!(
            frames < orig_frames,
            "EDL output frames ({}) should be less than original ({})",
            frames,
            orig_frames
        );
    }

    /// Regression: EDL MP3 export with edited source produces smaller file.
    #[test]
    fn test_edl_mp3_export_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_orig = dir.path().join("edl_original.mp3");
        let output_edited = dir.path().join("edl_edited.mp3");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // Export from original (2s)
        let source_orig = load_edl_source(&original_path, 0.0, 2.0);
        let edl_orig = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: original_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 2.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: output_orig.to_str().unwrap().to_string(),
            format: "mp3".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: Some(192),
            ogg_quality: None,
            start_time: 0.0,
            end_time: 2.0,
        };
        let total_orig = (2.0 * SAMPLE_RATE as f64) as usize;
        export_edl_mp3_no_progress(&edl_orig, &[source_orig], total_orig).unwrap();

        // Export from edited (1s)
        let source_edited = load_edl_source(&edited_path, 0.0, 1.0);
        let edl_edited = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: edited_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 1.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: output_edited.to_str().unwrap().to_string(),
            format: "mp3".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: Some(192),
            ogg_quality: None,
            start_time: 0.0,
            end_time: 1.0,
        };
        let total_edited = (1.0 * SAMPLE_RATE as f64) as usize;
        export_edl_mp3_no_progress(&edl_edited, &[source_edited], total_edited).unwrap();

        let original_size = std::fs::metadata(&output_orig).unwrap().len();
        let edited_size = std::fs::metadata(&output_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "EDL edited MP3 ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
        let ratio = edited_size as f64 / original_size as f64;
        assert!(
            ratio < 0.75,
            "EDL MP3 edited/original ratio {:.2} too high",
            ratio
        );
    }

    /// Regression: EDL OGG export with edited source produces smaller file.
    #[test]
    fn test_edl_ogg_export_edited_source() {
        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_orig = dir.path().join("edl_original.ogg");
        let output_edited = dir.path().join("edl_edited.ogg");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // Export from original (2s)
        let source_orig = load_edl_source(&original_path, 0.0, 2.0);
        let edl_orig = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: original_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 2.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: output_orig.to_str().unwrap().to_string(),
            format: "ogg".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: None,
            ogg_quality: Some(0.4),
            start_time: 0.0,
            end_time: 2.0,
        };
        let total_orig = (2.0 * SAMPLE_RATE as f64) as usize;
        export_edl_ogg_no_progress(&edl_orig, &[source_orig], total_orig).unwrap();

        // Export from edited (1s)
        let source_edited = load_edl_source(&edited_path, 0.0, 1.0);
        let edl_edited = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: edited_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 1.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: output_edited.to_str().unwrap().to_string(),
            format: "ogg".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: None,
            ogg_quality: Some(0.4),
            start_time: 0.0,
            end_time: 1.0,
        };
        let total_edited = (1.0 * SAMPLE_RATE as f64) as usize;
        export_edl_ogg_no_progress(&edl_edited, &[source_edited], total_edited).unwrap();

        let original_size = std::fs::metadata(&output_orig).unwrap().len();
        let edited_size = std::fs::metadata(&output_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "EDL edited OGG ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
        let ratio = edited_size as f64 / original_size as f64;
        assert!(
            ratio < 0.75,
            "EDL OGG edited/original ratio {:.2} too high",
            ratio
        );
    }

    /// Regression: EDL FLAC export with edited source produces smaller file.
    /// Requires ffmpeg — skips gracefully if unavailable.
    #[test]
    fn test_edl_flac_export_edited_source() {
        if !check_ffmpeg_available() {
            eprintln!("Skipping EDL FLAC test: ffmpeg not available");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let original_path = dir.path().join("original.wav");
        let edited_path = dir.path().join("edited.wav");
        let output_orig = dir.path().join("edl_original.flac");
        let output_edited = dir.path().join("edl_edited.flac");

        create_test_wav(&original_path, 2.0);
        create_test_wav(&edited_path, 1.0);

        // EDL FLAC goes through WAV → ffmpeg, so test the WAV intermediate + ffmpeg
        // Export original (2s) via WAV → FLAC
        let source_orig = load_edl_source(&original_path, 0.0, 2.0);
        let temp_wav_orig = dir.path().join("temp_orig.wav");
        let edl_orig = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: original_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 2.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: temp_wav_orig.to_str().unwrap().to_string(),
            format: "wav".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: None,
            ogg_quality: None,
            start_time: 0.0,
            end_time: 2.0,
        };
        let total_orig = (2.0 * SAMPLE_RATE as f64) as usize;
        export_edl_wav_no_progress(&edl_orig, &[source_orig], total_orig).unwrap();
        wav_to_flac(temp_wav_orig.to_str().unwrap(), output_orig.to_str().unwrap()).unwrap();

        // Export edited (1s) via WAV → FLAC
        let source_edited = load_edl_source(&edited_path, 0.0, 1.0);
        let temp_wav_edited = dir.path().join("temp_edited.wav");
        let edl_edited = ExportEDL {
            tracks: vec![ExportEDLTrack {
                source_path: edited_path.to_str().unwrap().to_string(),
                track_start: 0.0,
                duration: 1.0,
                volume: 1.0,
                volume_envelope: None,
            }],
            output_path: temp_wav_edited.to_str().unwrap().to_string(),
            format: "wav".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 2,
            mp3_bitrate: None,
            ogg_quality: None,
            start_time: 0.0,
            end_time: 1.0,
        };
        let total_edited = (1.0 * SAMPLE_RATE as f64) as usize;
        export_edl_wav_no_progress(&edl_edited, &[source_edited], total_edited).unwrap();
        wav_to_flac(temp_wav_edited.to_str().unwrap(), output_edited.to_str().unwrap()).unwrap();

        let original_size = std::fs::metadata(&output_orig).unwrap().len();
        let edited_size = std::fs::metadata(&output_edited).unwrap().len();
        assert!(
            edited_size < original_size,
            "EDL edited FLAC ({} bytes) should be smaller than original ({} bytes)",
            edited_size,
            original_size
        );
    }

    /// Verify that export_audio_region_inner correctly truncates when given
    /// start_time/end_time within a longer source — simulating a partial export.
    #[test]
    fn test_wav_export_partial_region() {
        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("source.wav");
        let output_path = dir.path().join("partial.wav");

        create_test_wav(&source_path, 3.0);

        // Export only the middle 1 second (1.0s to 2.0s)
        export_audio_region_inner(
            source_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
            1.0, 2.0,
        ).unwrap();

        let (frames, sr, _) = read_wav_info(&output_path);
        let duration = frames as f64 / sr as f64;
        assert!(
            (duration - 1.0).abs() < 0.01,
            "Partial region export should be ~1.0s, got {:.3}s",
            duration
        );
    }
}
