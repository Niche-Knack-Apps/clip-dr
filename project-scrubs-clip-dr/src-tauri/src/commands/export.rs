use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use hound::{WavSpec, WavWriter};
use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm};

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
