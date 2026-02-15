use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::WavReader;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::services::path_service;

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
pub(crate) struct TrackSource {
    config: PlaybackTrackConfig,
    /// Interleaved f32 PCM data (mmap'd or decoded)
    pcm: PcmData,
    sample_rate: u32,
    channels: u16,
}

pub(crate) enum PcmData {
    /// Memory-mapped WAV file — zero-copy access to PCM samples
    Mmap {
        mmap: Mmap,
        /// Byte offset to the first f32 sample (after WAV header)
        data_offset: usize,
        sample_count: usize,
    },
    /// Decoded PCM held in a Vec (for compressed formats)
    Vec(Vec<f32>),
    /// Streaming from a background decode thread
    Stream(Arc<StreamBuffer>),
}

impl PcmData {
    pub(crate) fn samples(&self) -> &[f32] {
        match self {
            PcmData::Mmap { mmap, data_offset, sample_count } => {
                // Safety: data_offset + sample_count*4 <= mmap.len(), alignment checked at load
                let ptr = mmap[*data_offset..].as_ptr() as *const f32;
                unsafe { std::slice::from_raw_parts(ptr, *sample_count) }
            }
            PcmData::Vec(v) => v.as_slice(),
            PcmData::Stream(_) => {
                // Stream variant uses read_sample() — return empty slice
                &[]
            }
        }
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            PcmData::Mmap { sample_count, .. } => *sample_count,
            PcmData::Vec(v) => v.len(),
            PcmData::Stream(buf) => buf.write_head.load(Ordering::Acquire),
        }
    }

    pub(crate) fn is_stream(&self) -> bool {
        matches!(self, PcmData::Stream(_))
    }
}

// ── StreamBuffer — lock-free shared buffer for streaming decode ──

/// Lock-free sliding-window ring buffer shared between decode thread (writer)
/// and cpal callback (reader). The writer appends samples and reclaims space
/// based on the reader's `read_cursor`. The reader uses a seqlock `epoch` to
/// detect concurrent seek resets.
pub(crate) struct StreamBuffer {
    #[allow(dead_code)] // Keeps allocation alive; data_ptr points into it
    data: Box<[f32]>,
    data_ptr: *mut f32,
    capacity: usize,

    /// Absolute interleaved sample index of data[0] — the "window start".
    /// Moves forward when the decode thread reclaims space.
    pub(crate) base_offset: AtomicUsize,

    /// Absolute interleaved sample index one past the last valid sample written.
    /// write_head - base_offset = number of valid samples in the buffer.
    pub(crate) write_head: AtomicUsize,

    /// Highest absolute sample index the callback has read (feedback from reader → writer).
    /// Updated by the callback via compare-and-swap after each frame batch.
    pub(crate) read_cursor: AtomicUsize,

    /// Seek epoch — even = stable, odd = reset in progress.
    /// Double-increment seqlock pattern prevents TOCTOU races on seek.
    pub(crate) epoch: AtomicUsize,

    /// Decode thread checks this to know when to stop
    pub(crate) stop: AtomicBool,
    /// Seek request: f64 seconds stored as u64 bits, u64::MAX = no request
    pub(crate) seek_request: AtomicU64,
    /// Set to true once initial buffer fill (0.5s) is complete
    pub(crate) ready: AtomicBool,
}

// Safety: `data_ptr` points into `data` (Box<[f32]>).
// Only the decode thread writes (single writer), cpal callback reads.
// Synchronization is via write_head (Release/Acquire) and epoch (seqlock).
unsafe impl Send for StreamBuffer {}
unsafe impl Sync for StreamBuffer {}

impl StreamBuffer {
    fn new(capacity: usize) -> Self {
        let mut data = vec![0.0f32; capacity].into_boxed_slice();
        let data_ptr = data.as_mut_ptr();
        Self {
            data,
            data_ptr,
            capacity,
            base_offset: AtomicUsize::new(0),
            write_head: AtomicUsize::new(0),
            read_cursor: AtomicUsize::new(0),
            epoch: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            seek_request: AtomicU64::new(u64::MAX),
            ready: AtomicBool::new(false),
        }
    }

    /// Called by cpal callback — lock-free read with epoch guard
    fn read_sample(&self, absolute_idx: usize) -> Option<f32> {
        // Seqlock: if epoch is odd, a reset is in progress — return silence
        let epoch_before = self.epoch.load(Ordering::Acquire);
        if epoch_before & 1 != 0 { return None; }

        let base = self.base_offset.load(Ordering::Acquire);
        let wh = self.write_head.load(Ordering::Acquire);

        // Verify epoch hasn't changed (no concurrent reset between reads)
        let epoch_after = self.epoch.load(Ordering::Acquire);
        if epoch_after != epoch_before { return None; }

        if absolute_idx < base || absolute_idx >= wh {
            return None;
        }

        let local = (absolute_idx - base) % self.capacity;
        // Safety: local < capacity, data_ptr valid for capacity f32s
        Some(unsafe { *self.data_ptr.add(local) })
    }

    /// Called by decode thread — write a sample, reclaiming space from read_cursor if full
    fn write_sample(&self, value: f32) -> bool {
        let wh = self.write_head.load(Ordering::Relaxed);
        let base = self.base_offset.load(Ordering::Relaxed);
        let used = wh - base;

        if used >= self.capacity {
            // Buffer full — try to reclaim space based on read_cursor
            let rc = self.read_cursor.load(Ordering::Acquire);
            if rc > base {
                // Advance base_offset to reclaim space the callback has consumed
                self.base_offset.store(rc, Ordering::Release);
                let new_used = wh - rc;
                if new_used >= self.capacity {
                    return false; // Still full even after reclaim
                }
            } else {
                return false; // Reader hasn't advanced, truly full
            }
        }

        let local = (wh - self.base_offset.load(Ordering::Relaxed)) % self.capacity;
        // Safety: local < capacity, only one writer thread
        unsafe { *self.data_ptr.add(local) = value; }
        self.write_head.store(wh + 1, Ordering::Release);
        true
    }

    /// Reset buffer for a seek operation — uses epoch seqlock to signal readers
    fn reset(&self, new_base_offset: usize) {
        // Odd epoch signals "reset in progress" — callback returns silence
        self.epoch.fetch_add(1, Ordering::Release);     // even → odd

        self.write_head.store(new_base_offset, Ordering::Release);
        self.base_offset.store(new_base_offset, Ordering::Release);
        self.read_cursor.store(new_base_offset, Ordering::Release);
        self.ready.store(false, Ordering::Release);

        self.epoch.fetch_add(1, Ordering::Release);     // odd → even (stable)
    }
}

/// Update read_cursor via compare-and-swap loop (monotonically increasing)
fn update_read_cursor(buf: &StreamBuffer, new_val: usize) {
    let mut current = buf.read_cursor.load(Ordering::Relaxed);
    while new_val > current {
        match buf.read_cursor.compare_exchange_weak(
            current, new_val, Ordering::Release, Ordering::Relaxed
        ) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

// ── PlaybackEngine ──

/// Global stream handle — cpal::Stream is !Send so can't go in managed state.
/// Kept alive here to prevent cpal from stopping audio output.
static PLAYBACK_STREAM: Mutex<Option<StreamHolder>> = Mutex::new(None);

/// Wrapper to make cpal::Stream storable in a Mutex (it's !Send but we only
/// access from the main thread during setup/teardown).
/// Includes thread affinity guard: logs a warning if dropped on a different thread.
struct StreamHolder {
    stream: cpal::Stream,
    creator_thread: std::thread::ThreadId,
}
unsafe impl Send for StreamHolder {}

impl StreamHolder {
    fn new(stream: cpal::Stream) -> Self {
        Self { stream, creator_thread: std::thread::current().id() }
    }
}

impl Drop for StreamHolder {
    fn drop(&mut self) {
        if std::thread::current().id() != self.creator_thread {
            log::warn!(
                "StreamHolder dropped on different thread than created \
                 (created: {:?}, dropping: {:?})",
                self.creator_thread, std::thread::current().id()
            );
        }
    }
}

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
pub(crate) fn load_wav_mmap(path: &str) -> Result<(PcmData, u32, u16), String> {
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

    Ok((PcmData::Mmap { mmap, data_offset, sample_count }, sample_rate, channels))
}

/// Find the byte offset of WAV PCM data by walking RIFF chunks structurally
pub(crate) fn find_wav_data_offset(data: &[u8]) -> Option<usize> {
    if data.len() < 12 { return None; }
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" { return None; }

    let mut pos = 12;
    while pos + 8 <= data.len() {
        let chunk_id = &data[pos..pos + 4];
        let chunk_size = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().ok()?) as usize;
        if chunk_id == b"data" {
            return Some(pos + 8);
        }
        pos += 8 + chunk_size;
        if chunk_size % 2 != 0 { pos += 1; } // RIFF word alignment padding
    }
    None
}

/// Compute a cache key for a file based on path, size, and mtime
fn decode_cache_key(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    meta.len().hash(&mut hasher);
    if let Ok(mtime) = meta.modified() {
        mtime.hash(&mut hasher);
    }
    Some(hasher.finish())
}

/// Check if a cached WAV exists for the given source path
fn check_decode_cache(path: &str) -> Result<PathBuf, String> {
    let src_path = Path::new(path);
    let file_hash = decode_cache_key(src_path)
        .ok_or_else(|| format!("Cannot stat source file: {}", path))?;

    let data_dir = path_service::get_user_data_dir()
        .map_err(|e| format!("Path service error: {}", e))?;
    let cache_dir = data_dir.join("decode-cache");
    let cache_path = cache_dir.join(format!("{:016x}.wav", file_hash));

    if cache_path.exists() {
        if let (Ok(src_meta), Ok(cache_meta)) = (fs::metadata(src_path), fs::metadata(&cache_path)) {
            if let (Ok(src_mtime), Ok(cache_mtime)) = (src_meta.modified(), cache_meta.modified()) {
                if cache_mtime >= src_mtime {
                    return Ok(cache_path);
                }
            }
        }
    }

    Err("No cache".to_string())
}

/// Probe audio format to get sample_rate and channels without decoding
fn probe_audio_format(path: &str) -> Result<(u32, u16), String> {
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

    let track = probed.format.default_track()
        .ok_or("No default track")?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);

    Ok((sample_rate, channels))
}

/// Start a background streaming decode thread that fills a StreamBuffer
fn start_streaming_decode(
    path: &str,
    start_seconds: f64,
    sample_rate: u32,
    channels: u16,
) -> Result<Arc<StreamBuffer>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::units::Time;

    let buffer_seconds = 30;
    let capacity = sample_rate as usize * channels as usize * buffer_seconds;
    let stream_buf = Arc::new(StreamBuffer::new(capacity));
    let buf_ref = stream_buf.clone();

    let base_offset = (start_seconds * sample_rate as f64 * channels as f64) as usize;
    stream_buf.base_offset.store(base_offset, Ordering::Release);
    stream_buf.write_head.store(base_offset, Ordering::Release);
    stream_buf.read_cursor.store(base_offset, Ordering::Release);

    let path = path.to_string();
    let initial_fill_samples = (0.5 * sample_rate as f64 * channels as f64) as usize;

    std::thread::Builder::new()
        .name("stream-decode".into())
        .spawn(move || {
            let start_time = std::time::Instant::now();
            log::info!("[Stream] Decode thread started: {} @ {:.1}s", path, start_seconds);

            // Open with symphonia
            let file = match File::open(&path) {
                Ok(f) => f,
                Err(e) => { log::error!("[Stream] Failed to open: {}", e); return; }
            };
            let mss = MediaSourceStream::new(Box::new(file), Default::default());

            let mut hint = Hint::new();
            if let Some(ext) = PathBuf::from(&path).extension().and_then(|e| e.to_str()) {
                hint.with_extension(ext);
            }

            let probed = match symphonia::default::get_probe()
                .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()) {
                Ok(p) => p,
                Err(e) => { log::error!("[Stream] Probe failed: {}", e); return; }
            };

            let mut format = probed.format;
            let track = match format.default_track() {
                Some(t) => t,
                None => { log::error!("[Stream] No default track"); return; }
            };
            let track_id = track.id;

            let mut decoder = match symphonia::default::get_codecs()
                .make(&track.codec_params, &DecoderOptions::default()) {
                Ok(d) => d,
                Err(e) => { log::error!("[Stream] Decoder creation failed: {}", e); return; }
            };

            // Seek to start position if > 0
            if start_seconds > 0.01 {
                let _ = format.seek(
                    SeekMode::Coarse,
                    SeekTo::Time { time: Time::from(start_seconds), track_id: Some(track_id) },
                );
            }

            // Decode loop
            loop {
                // Check stop signal
                if buf_ref.stop.load(Ordering::Acquire) {
                    log::info!("[Stream] Decode thread stopped (stop signal) in {:.0}ms", start_time.elapsed().as_millis());
                    return;
                }

                // Check seek request
                let seek_bits = buf_ref.seek_request.load(Ordering::Acquire);
                if seek_bits != u64::MAX {
                    buf_ref.seek_request.store(u64::MAX, Ordering::Release);
                    let seek_secs = f64::from_bits(seek_bits);
                    let seek_start = std::time::Instant::now();
                    log::info!("[Stream] Seek to {:.1}s", seek_secs);

                    let new_base = (seek_secs * sample_rate as f64 * channels as f64) as usize;
                    buf_ref.reset(new_base);

                    let _ = format.seek(
                        SeekMode::Coarse,
                        SeekTo::Time { time: Time::from(seek_secs), track_id: Some(track_id) },
                    );
                    // Reset decoder state after seek
                    decoder.reset();

                    log::info!("[Stream] Seek buffer refill started in {:.0}ms", seek_start.elapsed().as_millis());
                }

                // Decode next packet
                let packet = match format.next_packet() {
                    Ok(p) => p,
                    Err(symphonia::core::errors::Error::IoError(ref e))
                        if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        log::info!("[Stream] Decode thread stopped (end of file) in {:.0}ms", start_time.elapsed().as_millis());
                        // Mark ready even if we hit EOF before filling 0.5s
                        buf_ref.ready.store(true, Ordering::Release);
                        return;
                    }
                    Err(e) => {
                        log::warn!("[Stream] Decode error: {}", e);
                        buf_ref.ready.store(true, Ordering::Release);
                        return;
                    }
                };
                if packet.track_id() != track_id { continue; }

                let decoded = match decoder.decode(&packet) {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!("[Stream] Packet decode error: {}", e);
                        continue;
                    }
                };

                let spec = *decoded.spec();
                let num_frames = decoded.frames();
                let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);

                let samples = sample_buf.samples();
                let mut i = 0;
                while i < samples.len() {
                    if buf_ref.stop.load(Ordering::Acquire) { return; }
                    let seek_bits = buf_ref.seek_request.load(Ordering::Acquire);
                    if seek_bits != u64::MAX { break; } // Let outer loop handle seek

                    if buf_ref.write_sample(samples[i]) {
                        i += 1;
                    } else {
                        // Buffer full and reader hasn't consumed — brief sleep, retry
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }

                // Check if initial fill is complete
                if !buf_ref.ready.load(Ordering::Relaxed) {
                    let filled = buf_ref.write_head.load(Ordering::Relaxed)
                        - buf_ref.base_offset.load(Ordering::Relaxed);
                    if filled >= initial_fill_samples {
                        let fill_secs = filled as f64 / (sample_rate as f64 * channels as f64);
                        log::info!("[Stream] Initial fill: {:.1}s decoded in {:.0}ms", fill_secs, start_time.elapsed().as_millis());
                        buf_ref.ready.store(true, Ordering::Release);
                    }
                }
            }
        }).map_err(|e| format!("Failed to spawn decode thread: {}", e))?;

    Ok(stream_buf)
}

/// Decode compressed audio to cached WAV with optional progress events
fn decode_to_temp_wav_with_progress(
    path: &str,
    app_handle: Option<&tauri::AppHandle>,
    emit_track_id: Option<&str>,
) -> Result<PathBuf, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let src_path = Path::new(path);
    let file_hash = decode_cache_key(src_path)
        .ok_or_else(|| format!("Cannot stat source file: {}", path))?;

    // Cache path: {app_data_dir}/decode-cache/{hash}.wav
    let data_dir = path_service::get_user_data_dir()
        .map_err(|e| format!("Path service error: {}", e))?;
    let cache_dir = data_dir.join("decode-cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create decode-cache dir: {}", e))?;
    let cache_path = cache_dir.join(format!("{:016x}.wav", file_hash));

    // If cached WAV exists and is newer than source, reuse it
    if cache_path.exists() {
        if let (Ok(src_meta), Ok(cache_meta)) = (fs::metadata(src_path), fs::metadata(&cache_path)) {
            if let (Ok(src_mtime), Ok(cache_mtime)) = (src_meta.modified(), cache_meta.modified()) {
                if cache_mtime >= src_mtime {
                    log::info!("Decode cache hit: {:?}", cache_path);
                    return Ok(cache_path);
                }
            }
        }
    }

    let decode_start = std::time::Instant::now();
    log::info!("[Playback] Background cache decode started for {}", path);

    // Open source with symphonia
    let file = File::open(path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(1) as f64;
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

    // Estimate total samples for progress (if n_frames available)
    let total_frames_est = track.codec_params.n_frames.unwrap_or(0);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Create WAV writer — 32-bit float so load_wav_mmap() can handle it
    let wav_spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&cache_path, wav_spec)
        .map_err(|e| format!("Failed to create cache WAV: {}", e))?;

    let mut last_progress = 0u8;
    let mut decoded_frames: u64 = 0;

    // Decode in chunks, writing each directly to WAV (O(1) memory)
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                log::warn!("Decode error (continuing): {}", e);
                break;
            }
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("Decode packet error: {}", e);
                continue;
            }
        };

        let spec = *decoded.spec();
        let num_frames = decoded.frames();
        decoded_frames += num_frames as u64;
        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        for &s in sample_buf.samples() {
            writer.write_sample(s)
                .map_err(|e| format!("WAV write error: {}", e))?;
        }

        // Emit progress events
        if let (Some(handle), Some(tid)) = (app_handle, emit_track_id) {
            let progress = if total_frames_est > 0 {
                (decoded_frames as f64 / total_frames_est as f64).min(1.0)
            } else {
                // Fallback: estimate from writer position vs expected file size
                let written_bytes = decoded_frames * channels as u64 * 4;
                let est_total = (file_size * sample_rate as f64 * channels as f64 * 4.0 / file_size).max(1.0);
                (written_bytes as f64 / est_total).min(0.99)
            };
            let pct = (progress * 100.0) as u8;
            if pct >= last_progress + 2 {
                last_progress = pct;
                let _ = handle.emit("audio-cache-progress", serde_json::json!({
                    "trackId": tid,
                    "progress": progress,
                }));
            }
        }
    }

    writer.finalize()
        .map_err(|e| format!("Failed to finalize cache WAV: {}", e))?;

    let size_mb = fs::metadata(&cache_path).map(|m| m.len() as f64 / 1024.0 / 1024.0).unwrap_or(0.0);
    log::info!("[Playback] Background cache decode complete: {:.1}MB WAV in {:.1}s", size_mb, decode_start.elapsed().as_secs_f64());
    Ok(cache_path)
}

/// Decode a compressed audio file to PCM via cached temp WAV + mmap.
/// If cache exists, returns mmap instantly. Otherwise, starts streaming decode.
pub(crate) fn load_compressed(path: &str) -> Result<(PcmData, u32, u16), String> {
    let load_start = std::time::Instant::now();
    log::info!("[Playback] load_compressed({}) — checking cache...", path);

    // Try cached WAV first (instant if cache exists)
    if let Ok(wav_path) = check_decode_cache(path) {
        let wav_str = wav_path.to_string_lossy();
        match load_wav_mmap(&wav_str) {
            Ok(result) => {
                let size_mb = fs::metadata(&wav_path).map(|m| m.len() as f64 / 1024.0 / 1024.0).unwrap_or(0.0);
                log::info!("[Playback] Cache HIT: mmap'd {:.1}MB WAV in {:.1}ms", size_mb, load_start.elapsed().as_secs_f64() * 1000.0);
                return Ok(result);
            }
            Err(mmap_err) => {
                log::warn!("Mmap of cached WAV failed ({}), falling back to hound read", mmap_err);
                let mut reader = WavReader::open(&wav_path)
                    .map_err(|e| format!("Failed to open decoded WAV: {}", e))?;
                let spec = reader.spec();
                let samples: Vec<f32> = reader.samples::<f32>()
                    .map(|s| s.unwrap_or(0.0))
                    .collect();
                return Ok((PcmData::Vec(samples), spec.sample_rate, spec.channels));
            }
        }
    }

    // No cache: probe format to get sample_rate/channels
    log::info!("[Playback] Cache MISS: starting stream decode");
    let (sample_rate, channels) = probe_audio_format(path)?;

    // Start streaming decode for immediate playback
    let stream_buf = start_streaming_decode(path, 0.0, sample_rate, channels)?;

    // Wait for initial buffer fill (~0.5s)
    let wait_start = std::time::Instant::now();
    while !stream_buf.ready.load(Ordering::Acquire) {
        if wait_start.elapsed().as_secs() > 10 {
            log::warn!("[Playback] Stream buffer fill timeout after 10s");
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let filled = stream_buf.write_head.load(Ordering::Acquire)
        - stream_buf.base_offset.load(Ordering::Acquire);
    let buf_secs = filled as f64 / (sample_rate as f64 * channels as f64);
    log::info!("[Playback] Stream buffer ready ({:.1}s audio) in {:.0}ms", buf_secs, load_start.elapsed().as_secs_f64() * 1000.0);

    Ok((PcmData::Stream(stream_buf), sample_rate, channels))
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

                    // Read source sample(s) — lock-free for Stream, slice for Mmap/Vec
                    match &track_src.pcm {
                        PcmData::Stream(buf) => {
                            if let Some(s) = buf.read_sample(interleaved_idx) {
                                if src_ch == 1 {
                                    mix[0] += s * track_vol;
                                    mix[1] += s * track_vol;
                                } else {
                                    mix[0] += s * track_vol;
                                    if let Some(s2) = buf.read_sample(interleaved_idx + 1) {
                                        mix[1] += s2 * track_vol;
                                    }
                                }
                            }
                            // else: silence (not yet decoded or buffer underrun)
                        }
                        _ => {
                            let samples = track_src.pcm.samples();
                            if interleaved_idx >= samples.len() { continue; }

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

            // Update read cursors for stream tracks so decode threads can reclaim space
            for track_src in &inner.tracks {
                if let PcmData::Stream(buf) = &track_src.pcm {
                    let rel_pos = pos - track_src.config.track_start;
                    if rel_pos > 0.0 {
                        let src_rate = track_src.sample_rate as f64;
                        let src_ch = track_src.channels as usize;
                        let sample_idx = (rel_pos * src_rate) as usize;
                        let idx = sample_idx * src_ch;
                        update_read_cursor(buf, idx);
                    }
                }
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
pub async fn playback_set_tracks(
    tracks: Vec<PlaybackTrackConfig>,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    let inner_arc = state.inner.clone();
    let position_arc = state.position.clone();
    let playing_arc = state.playing.clone();

    let set_start = std::time::Instant::now();

    // Load tracks on a blocking thread so streaming buffer fill doesn't block IPC
    let loaded = tokio::task::spawn_blocking(move || {
        log::info!("Setting {} playback tracks", tracks.len());
        let mut loaded: Vec<TrackSource> = Vec::new();
        for config in tracks {
            match load_track_source(config) {
                Ok(source) => {
                    log::info!(
                        "  Loaded track '{}': {}Hz {}ch, {} samples{}",
                        source.config.track_id,
                        source.sample_rate,
                        source.channels,
                        source.pcm.len(),
                        if source.pcm.is_stream() { " (STREAMING)" } else { "" },
                    );
                    loaded.push(source);
                }
                Err(e) => {
                    log::warn!("  Failed to load track: {}", e);
                }
            }
        }
        loaded
    }).await.map_err(|e| e.to_string())?;

    let count = loaded.len();
    let mut inner = inner_arc.lock().map_err(|e| e.to_string())?;
    inner.tracks = loaded;

    // Build output stream if not already running
    if !inner.stream_started {
        match build_output_stream(&inner_arc, &position_arc, &playing_arc) {
            Ok((stream, sample_rate, channels)) => {
                stream.play().map_err(|e| format!("Failed to start output: {}", e))?;
                inner.output_sample_rate = sample_rate;
                inner.output_channels = channels;
                inner.stream_started = true;
                if let Ok(mut guard) = PLAYBACK_STREAM.lock() {
                    *guard = Some(StreamHolder::new(stream));
                }
                log::info!("Output stream started: {}Hz {}ch", sample_rate, channels);
            }
            Err(e) => {
                log::error!("Failed to build output stream: {}", e);
                return Err(e);
            }
        }
    }

    log::info!("[Playback] playback_set_tracks: {} tracks loaded in {:.0}ms", count, set_start.elapsed().as_secs_f64() * 1000.0);
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

    // If any track is streaming, signal seek to decode thread
    if let Ok(inner) = state.inner.lock() {
        for track in &inner.tracks {
            if let PcmData::Stream(buf) = &track.pcm {
                buf.seek_request.store(position.to_bits(), Ordering::Release);
            }
        }
    }

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

/// Start background decode-to-cache for a compressed audio file.
/// Emits `audio-cache-progress` events during decode and `audio-cache-ready` when done.
#[tauri::command]
pub async fn prepare_audio_cache(
    app_handle: tauri::AppHandle,
    path: String,
    track_id: String,
) -> Result<(), String> {
    let handle = app_handle.clone();
    let tid = track_id.clone();
    tokio::task::spawn_blocking(move || {
        match decode_to_temp_wav_with_progress(&path, Some(&handle), Some(&tid)) {
            Ok(wav_path) => {
                let cached = wav_path.to_string_lossy().to_string();
                log::info!("[Playback] Audio cache ready for track {}", tid);
                let _ = handle.emit("audio-cache-ready", serde_json::json!({
                    "trackId": tid,
                    "cachedPath": cached,
                }));
            }
            Err(e) => log::error!("[Playback] Audio cache failed for track {}: {}", tid, e),
        }
    });
    Ok(())
}

/// Hot-swap a streaming track to mmap'd cached WAV.
/// Called by frontend when `audio-cache-ready` event fires.
#[tauri::command]
pub fn playback_swap_to_cache(
    track_id: String,
    cached_path: String,
    state: tauri::State<'_, PlaybackEngine>,
) -> Result<(), String> {
    let swap_start = std::time::Instant::now();
    let (pcm, sr, ch) = load_wav_mmap(&cached_path)?;
    let size_mb = fs::metadata(&cached_path).map(|m| m.len() as f64 / 1024.0 / 1024.0).unwrap_or(0.0);

    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(track) = inner.tracks.iter_mut().find(|t| t.config.track_id == track_id) {
        // Stop streaming decode thread if active
        if let PcmData::Stream(buf) = &track.pcm {
            buf.stop.store(true, Ordering::Release);
        }
        track.pcm = pcm;
        track.sample_rate = sr;
        track.channels = ch;
        log::info!("[Playback] Hot-swap stream→mmap for track {} ({:.1}MB, {:.0}ms)", track_id, size_mb, swap_start.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(())
}
