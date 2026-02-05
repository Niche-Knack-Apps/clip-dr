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
    let n_frames = track.codec_params.n_frames.unwrap_or(0) as usize;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Collect all samples first (mono mix)
    let mut mono_samples: Vec<f32> = Vec::with_capacity(n_frames);

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

    // Create waveform buckets (min/max pairs)
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

    Ok(waveform)
}
