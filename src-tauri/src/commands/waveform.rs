use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[tauri::command]
pub async fn extract_waveform(path: String, bucket_count: usize) -> Result<Vec<f32>, String> {
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
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100) as usize;

    // Estimate total frames; fall back to 5 minutes at detected sample rate if unavailable
    let n_frames_estimate = match track.codec_params.n_frames {
        Some(n) if n > 0 => n as usize,
        _ => sample_rate * 300, // 5 minutes fallback
    };

    let bucket_count = bucket_count.max(1);
    let samples_per_bucket = (n_frames_estimate / bucket_count).max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Streaming peak accumulation — no large sample buffer needed
    let mut waveform: Vec<f32> = Vec::with_capacity(bucket_count * 2);
    let mut bucket_min: f32 = 0.0;
    let mut bucket_max: f32 = 0.0;
    let mut bucket_frame_count: usize = 0;
    let mut global_frame_index: usize = 0;

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
        let num_frames = decoded.frames();
        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        // Mix to mono and accumulate into buckets incrementally
        for chunk in samples.chunks(channels) {
            let mono = chunk.iter().sum::<f32>() / channels as f32;

            if bucket_frame_count == 0 {
                bucket_min = mono;
                bucket_max = mono;
            } else {
                if mono < bucket_min {
                    bucket_min = mono;
                }
                if mono > bucket_max {
                    bucket_max = mono;
                }
            }
            bucket_frame_count += 1;
            global_frame_index += 1;

            if bucket_frame_count >= samples_per_bucket {
                waveform.push(bucket_min);
                waveform.push(bucket_max);
                bucket_frame_count = 0;
            }
        }
    }

    // Flush partial bucket at end
    if bucket_frame_count > 0 {
        waveform.push(bucket_min);
        waveform.push(bucket_max);
    }

    // If file was shorter than expected and we got zero buckets, push silence
    if waveform.is_empty() && global_frame_index == 0 {
        waveform.push(0.0);
        waveform.push(0.0);
    }

    Ok(waveform)
}
