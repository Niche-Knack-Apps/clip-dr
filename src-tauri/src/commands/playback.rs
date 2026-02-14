use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::WavReader;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackTrackConfig {
    pub track_id: String,
    pub source_path: String,
    pub track_start: f64,   // timeline offset in seconds
    pub duration: f64,
    pub volume: f32,
    pub muted: bool,
}

/// Per-track audio source — either an mmap'd WAV or decoded PCM in memory
struct TrackSource {
    config: PlaybackTrackConfig,
    /// Interleaved f32 PCM data (mmap'd or decoded)
    pcm: PcmData,
    sample_rate: u32,
    channels: u16,
}

enum PcmData {
    /// Memory-mapped WAV file — zero-copy access to PCM samples
    Mmap {
        _mmap: Mmap,
        /// Pointer to the first f32 sample in the mmap (after WAV header)
        samples_ptr: *const f32,
        sample_count: usize,
    },
    /// Decoded PCM held in a Vec (for compressed formats)
    Vec(Vec<f32>),
}

// Safety: Mmap data is read-only and the pointer is valid for the lifetime of the Mmap
unsafe impl Send for PcmData {}
unsafe impl Sync for PcmData {}

impl PcmData {
    fn samples(&self) -> &[f32] {
        match self {
            PcmData::Mmap { samples_ptr, sample_count, .. } => {
                // Safety: pointer is valid for sample_count f32s, mmap is alive
                unsafe { std::slice::from_raw_parts(*samples_ptr, *sample_count) }
            }
            PcmData::Vec(v) => v.as_slice(),
        }
    }

    fn len(&self) -> usize {
        match self {
            PcmData::Mmap { sample_count, .. } => *sample_count,
            PcmData::Vec(v) => v.len(),
        }
    }
}

// ── PlaybackEngine ──

/// Global stream handle — cpal::Stream is !Send so can't go in managed state.
/// Kept alive here to prevent cpal from stopping audio output.
static PLAYBACK_STREAM: Mutex<Option<StreamHolder>> = Mutex::new(None);

/// Wrapper to make cpal::Stream storable in a Mutex (it's !Send but we only
/// access from the main thread during setup/teardown)
struct StreamHolder(cpal::Stream);
unsafe impl Send for StreamHolder {}

pub struct PlaybackEngine {
    inner: Arc<Mutex<EngineInner>>,
    /// Lock-free position (f64 bits stored as u64)
    position: Arc<AtomicU64>,
    playing: Arc<AtomicBool>,
}

struct EngineInner {
    tracks: Vec<TrackSource>,
    output_sample_rate: u32,
    output_channels: u16,
    speed: f32,
    master_volume: f32,
    track_volumes: HashMap<String, f32>,
    track_muted: HashMap<String, bool>,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
    stream_started: bool,
}

impl PlaybackEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(EngineInner {
                tracks: Vec::new(),
                output_sample_rate: 44100,
                output_channels: 2,
                speed: 1.0,
                master_volume: 1.0,
                track_volumes: HashMap::new(),
                track_muted: HashMap::new(),
                loop_enabled: false,
                loop_start: 0.0,
                loop_end: 0.0,
                stream_started: false,
            })),
            position: Arc::new(AtomicU64::new(0)),
            playing: Arc::new(AtomicBool::new(false)),
        }
    }

    fn get_position(&self) -> f64 {
        f64::from_bits(self.position.load(Ordering::Relaxed))
    }

    fn set_position(&self, pos: f64) {
        self.position.store(pos.to_bits(), Ordering::Relaxed);
    }
}

// ── Audio source loading ──

/// Try to mmap a WAV file for zero-copy PCM access
fn load_wav_mmap(path: &str) -> Result<(PcmData, u32, u16), String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open WAV: {}", e))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| format!("Failed to mmap WAV: {}", e))?;

    // Parse WAV header to find data offset and format
    let reader = WavReader::new(std::io::Cursor::new(&mmap[..]))
        .map_err(|e| format!("Failed to parse WAV header: {}", e))?;

    let spec = reader.spec();

    // Only support 32-bit float WAV for mmap (our recording format)
    if spec.sample_format != hound::SampleFormat::Float || spec.bits_per_sample != 32 {
        return Err("WAV is not 32-bit float, falling back to decode".to_string());
    }

    let sample_rate = spec.sample_rate;
    let channels = spec.channels;

    // Find data chunk offset by searching for 'data' marker
    let data_offset = find_wav_data_offset(&mmap)
        .ok_or_else(|| "Could not find WAV data chunk".to_string())?;

    let data_bytes = mmap.len() - data_offset;
    let sample_count = data_bytes / 4; // f32 = 4 bytes

    let samples_ptr = unsafe { mmap.as_ptr().add(data_offset) as *const f32 };

    Ok((PcmData::Mmap { _mmap: mmap, samples_ptr, sample_count }, sample_rate, channels))
}

/// Find the byte offset of WAV PCM data (after 'data' chunk header)
fn find_wav_data_offset(data: &[u8]) -> Option<usize> {
    // Search for 'data' marker
    for i in 0..data.len().saturating_sub(8) {
        if &data[i..i + 4] == b"data" {
            // Skip 'data' (4 bytes) + chunk size (4 bytes)
            return Some(i + 8);
        }
    }
    None
}

/// Decode a compressed audio file to PCM via symphonia
fn load_compressed(path: &str) -> Result<(PcmData, u32, u16), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = PathBuf::from(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Failed to probe format: {}", e))?;

    let mut format = probed.format;
    let track = format.default_track()
        .ok_or("No default track")?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                log::warn!("Playback decode error: {}", e);
                break;
            }
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("Playback decode error: {}", e);
                continue;
            }
        };

        let spec = *decoded.spec();
        let num_frames = decoded.frames();
        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        all_samples.extend_from_slice(sample_buf.samples());
    }

    Ok((PcmData::Vec(all_samples), sample_rate, channels))
}

/// Load a track source from a file path
fn load_track_source(config: PlaybackTrackConfig) -> Result<TrackSource, String> {
    let path = &config.source_path;

    // Try WAV mmap first (instant, zero-copy for our recordings)
    let (pcm, sample_rate, channels) = match load_wav_mmap(path) {
        Ok(result) => result,
        Err(_) => {
            // Fall back to symphonia decode for compressed formats
            load_compressed(path)?
        }
    };

    Ok(TrackSource {
        config,
        pcm,
        sample_rate,
        channels,
    })
}

// ── cpal audio callback ──

fn build_output_stream(
    engine: &Arc<Mutex<EngineInner>>,
    position: &Arc<AtomicU64>,
    playing: &Arc<AtomicBool>,
) -> Result<(cpal::Stream, u32, u16), String> {
    let host = cpal::default_host();
    let device = host.default_output_device()
        .ok_or("No output device available")?;

    let supported = device.default_output_config()
        .map_err(|e| format!("Failed to get output config: {}", e))?;

    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let config: cpal::StreamConfig = supported.into();

    let engine_ref = engine.clone();
    let position_ref = position.clone();
    let playing_ref = playing.clone();

    let stream = device.build_output_stream(
        &config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            if !playing_ref.load(Ordering::Relaxed) {
                // Fill with silence
                for s in data.iter_mut() { *s = 0.0; }
                return;
            }

            let Ok(inner) = engine_ref.lock() else {
                for s in data.iter_mut() { *s = 0.0; }
                return;
            };

            let speed = inner.speed;
            let abs_speed = speed.abs().max(0.01);
            let direction = if speed >= 0.0 { 1.0f64 } else { -1.0f64 };
            let master_vol = inner.master_volume;
            let out_rate = sample_rate as f64;
            let out_ch = channels as usize;

            let mut pos = f64::from_bits(position_ref.load(Ordering::Relaxed));

            // Process output frames
            let frame_count = data.len() / out_ch;
            for frame_idx in 0..frame_count {
                // Loop boundary check
                if inner.loop_enabled {
                    if direction > 0.0 && pos >= inner.loop_end {
                        pos = inner.loop_start;
                    } else if direction < 0.0 && pos <= inner.loop_start {
                        pos = inner.loop_end;
                    }
                }

                // Mix all active tracks at this timeline position
                let mut mix = [0.0f32; 2]; // stereo output

                for track_src in &inner.tracks {
                    // Check per-track mute
                    if track_src.config.muted {
                        continue;
                    }
                    if let Some(&muted) = inner.track_muted.get(&track_src.config.track_id) {
                        if muted { continue; }
                    }

                    let track_vol = inner.track_volumes
                        .get(&track_src.config.track_id)
                        .copied()
                        .unwrap_or(track_src.config.volume);

                    // Convert timeline position to position within this track
                    let rel_pos = pos - track_src.config.track_start;
                    if rel_pos < 0.0 || rel_pos >= track_src.config.duration {
                        continue;
                    }

                    // Convert to sample position in the source
                    let src_rate = track_src.sample_rate as f64;
                    let src_ch = track_src.channels as usize;
                    let sample_idx = (rel_pos * src_rate) as usize;
                    let interleaved_idx = sample_idx * src_ch;

                    let samples = track_src.pcm.samples();
                    if interleaved_idx >= samples.len() { continue; }

                    // Read source sample(s)
                    if src_ch == 1 {
                        let s = samples[interleaved_idx] * track_vol;
                        mix[0] += s;
                        mix[1] += s;
                    } else {
                        mix[0] += samples[interleaved_idx] * track_vol;
                        if interleaved_idx + 1 < samples.len() {
                            mix[1] += samples[interleaved_idx + 1] * track_vol;
                        }
                    }
                }

                // Write to output buffer
                let base = frame_idx * out_ch;
                if out_ch >= 2 {
                    data[base] = mix[0] * master_vol;
                    data[base + 1] = mix[1] * master_vol;
                    // Fill extra channels with silence
                    for c in 2..out_ch {
                        data[base + c] = 0.0;
                    }
                } else if out_ch == 1 {
                    data[base] = (mix[0] + mix[1]) * 0.5 * master_vol;
                }

                // Advance position
                pos += direction * abs_speed as f64 / out_rate;
            }

            position_ref.store(pos.to_bits(), Ordering::Relaxed);
        },
        |err| {
            log::error!("Playback output error: {}", err);
        },
        None,
    ).map_err(|e| format!("Failed to build output stream: {}", e))?;

    Ok((stream, sample_rate, channels))
}

// ── Tauri commands ──

#[tauri::command]
pub fn playback_set_tracks(
    tracks: Vec<PlaybackTrackConfig>,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    log::info!("Setting {} playback tracks", tracks.len());

    let mut loaded: Vec<TrackSource> = Vec::new();
    for config in tracks {
        match load_track_source(config) {
            Ok(source) => {
                log::info!(
                    "  Loaded track '{}': {}Hz {}ch, {} samples",
                    source.config.track_id,
                    source.sample_rate,
                    source.channels,
                    source.pcm.len(),
                );
                loaded.push(source);
            }
            Err(e) => {
                log::warn!("  Failed to load track: {}", e);
            }
        }
    }

    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.tracks = loaded;

    // Build output stream if not already running
    if !inner.stream_started {
        match build_output_stream(&state.inner, &state.position, &state.playing) {
            Ok((stream, sample_rate, channels)) => {
                stream.play().map_err(|e| format!("Failed to start output: {}", e))?;
                inner.output_sample_rate = sample_rate;
                inner.output_channels = channels;
                inner.stream_started = true;
                // Store in global to keep alive (cpal::Stream is !Send)
                if let Ok(mut guard) = PLAYBACK_STREAM.lock() {
                    *guard = Some(StreamHolder(stream));
                }
                log::info!("Output stream started: {}Hz {}ch", sample_rate, channels);
            }
            Err(e) => {
                log::error!("Failed to build output stream: {}", e);
                return Err(e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn playback_play(state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    state.playing.store(true, Ordering::Relaxed);
    log::info!("Playback started at {:.2}s", state.get_position());
    Ok(())
}

#[tauri::command]
pub fn playback_pause(state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    state.playing.store(false, Ordering::Relaxed);
    log::info!("Playback paused at {:.2}s", state.get_position());
    Ok(())
}

#[tauri::command]
pub fn playback_stop(state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    state.playing.store(false, Ordering::Relaxed);
    state.set_position(0.0);
    log::info!("Playback stopped");
    Ok(())
}

#[tauri::command]
pub fn playback_seek(position: f64, state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    state.set_position(position);
    Ok(())
}

#[tauri::command]
pub fn playback_set_speed(speed: f32, state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.speed = speed;
    Ok(())
}

#[tauri::command]
pub fn playback_set_volume(volume: f32, state: tauri::State<'_, PlaybackEngine>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.master_volume = volume;
    Ok(())
}

#[tauri::command]
pub fn playback_set_track_volume(
    track_id: String,
    volume: f32,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.track_volumes.insert(track_id, volume);
    Ok(())
}

#[tauri::command]
pub fn playback_set_track_muted(
    track_id: String,
    muted: bool,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.track_muted.insert(track_id, muted);
    Ok(())
}

#[tauri::command]
pub fn playback_set_loop(
    enabled: bool,
    start: f64,
    end: f64,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.loop_enabled = enabled;
    inner.loop_start = start;
    inner.loop_end = end;
    Ok(())
}

#[tauri::command]
pub fn playback_get_position(state: tauri::State<'_, PlaybackEngine>) -> Result<f64, String> {
    Ok(state.get_position())
}
