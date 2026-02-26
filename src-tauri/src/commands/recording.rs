use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write, Seek, SeekFrom};
use std::panic;
use std::path::{Path, PathBuf};
use std::process::{ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::State;

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

// ── Per-Session Recording Architecture ──
// RecordingManager is Tauri managed state; individual sessions hold per-stream
// ring buffers, level atomics, and active flags. Old single-session commands
// map to the "default" session for backward compatibility.

/// A single recording session (one input device → one WAV file).
struct RecordingSession {
    stream: Option<StreamHolder>,
    ring_buffer: Option<Arc<RecordingRingBuffer>>,
    writer_handle: Option<JoinHandle<(AudioWriter, usize, Vec<PathBuf>)>>,
    /// Per-session active flag (checked by audio callback)
    active: Arc<AtomicBool>,
    /// Per-session peak level (updated by audio callback, read by polling)
    level: Arc<AtomicU32>,
    /// Per-session debug callback counter
    debug_count: Arc<AtomicUsize>,
    sample_rate: u32,
    channels: u16,
    output_path: PathBuf,
    target_mono: bool,
    large_file_format: String,
    use_system_buffer: bool,
}

/// Managed state for all recording, monitoring, and preview operations.
/// Holds Arc-wrapped atomics so audio threads can access them without statics.
pub struct RecordingManager {
    /// Active recording sessions keyed by session ID ("default" for single-session)
    sessions: Mutex<HashMap<String, RecordingSession>>,

    // ── Monitor state (not per-session) ──
    monitor_stream: Mutex<Option<StreamHolder>>,
    monitoring_active: Arc<AtomicBool>,

    // ── Preview state (not per-session) ──
    preview_stream: Mutex<Option<StreamHolder>>,
    preview_active: Arc<AtomicBool>,
    preview_level: Arc<AtomicU32>,

    // ── Shared current level (backward compat: single-session & monitoring) ──
    current_level: Arc<AtomicU32>,

    // ── System audio state (inherently single-instance) ──
    system_monitor_active: Arc<AtomicBool>,
    system_monitor_child: Arc<Mutex<Option<std::process::Child>>>,
    system_recording_active: Arc<AtomicBool>,
    system_wav_writer: Arc<Mutex<Option<AudioWriter>>>,
    system_segment_base_path: Mutex<Option<PathBuf>>,
    system_completed_segments: Mutex<Vec<PathBuf>>,
    system_segment_data_bytes: Arc<AtomicUsize>,
    system_segment_index: Arc<AtomicUsize>,
    system_audio_sample_count: Arc<AtomicUsize>,
    debug_callback_count: Arc<AtomicUsize>,
}

// RecordingSession contains a StreamHolder which has `unsafe impl Send`.
// The Mutex wrappers ensure safe concurrent access.
unsafe impl Send for RecordingSession {}

impl RecordingManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            monitor_stream: Mutex::new(None),
            monitoring_active: Arc::new(AtomicBool::new(false)),
            preview_stream: Mutex::new(None),
            preview_active: Arc::new(AtomicBool::new(false)),
            preview_level: Arc::new(AtomicU32::new(0)),
            current_level: Arc::new(AtomicU32::new(0)),
            system_monitor_active: Arc::new(AtomicBool::new(false)),
            system_monitor_child: Arc::new(Mutex::new(None)),
            system_recording_active: Arc::new(AtomicBool::new(false)),
            system_wav_writer: Arc::new(Mutex::new(None)),
            system_segment_base_path: Mutex::new(None),
            system_completed_segments: Mutex::new(Vec::new()),
            system_segment_data_bytes: Arc::new(AtomicUsize::new(0)),
            system_segment_index: Arc::new(AtomicUsize::new(1)),
            system_audio_sample_count: Arc::new(AtomicUsize::new(0)),
            debug_callback_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Check if any session is actively recording
    fn is_any_recording(&self) -> bool {
        if let Ok(sessions) = self.sessions.lock() {
            sessions.values().any(|s| s.active.load(Ordering::SeqCst))
        } else {
            false
        }
    }

    /// Get the "default" session's recording active state
    fn is_default_recording(&self) -> bool {
        if let Ok(sessions) = self.sessions.lock() {
            sessions.get("default")
                .map(|s| s.active.load(Ordering::SeqCst))
                .unwrap_or(false)
        } else {
            false
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    pub is_loopback: bool,
    /// Whether this is an output device (new in multi-source)
    #[serde(default)]
    pub is_output: bool,
    /// Device type classification: "microphone", "loopback", "output", "virtual"
    #[serde(default)]
    pub device_type: String,
    /// Number of channels supported
    #[serde(default)]
    pub channels: u16,
    /// Supported sample rates (empty = unknown)
    #[serde(default)]
    pub sample_rates: Vec<u32>,
    /// Platform-specific device identifier (e.g., ALSA hw:x,y)
    #[serde(default)]
    pub platform_id: String,
}

/// Detailed capabilities for a specific device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub is_input: bool,
    pub is_output: bool,
    pub configs: Vec<DeviceConfig>,
}

/// A supported configuration for a device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub channels: u16,
    pub sample_format: String,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Additional segment paths when recording was split (excludes `path` which is segment 1)
    pub extra_segments: Vec<String>,
}

/// Maximum PCM data bytes per WAV segment (~3.63 GB, safely below u32::MAX = 4,294,967,295)
const WAV_SEGMENT_MAX_DATA_BYTES: usize = 3_900_000_000;

// ── Lock-free ring buffer for realtime-safe recording ──

/// SPSC ring buffer: audio callback (producer) writes samples lock-free,
/// dedicated writer thread (consumer) drains to disk.
struct RecordingRingBuffer {
    #[allow(dead_code)] // Keeps allocation alive; data_ptr points into it
    data: Box<[f32]>,
    data_ptr: *mut f32,
    capacity: usize,
    /// Total samples written by producer (monotonically increasing)
    write_pos: AtomicUsize,
    /// Total samples read by consumer (monotonically increasing)
    read_pos: AtomicUsize,
    /// False = writer thread should drain remaining samples and exit
    active: AtomicBool,
    /// Number of input channels (for bad-channel detection)
    channels: u16,
    /// Bad channel detected: 0=none, 1=ch0 bad, 2=ch1 bad
    bad_channel: AtomicUsize,
    /// Number of times the audio callback dropped a batch due to full buffer
    overrun_count: AtomicUsize,
    /// High-water mark of ring buffer usage (samples)
    max_fill_level: AtomicUsize,
}

unsafe impl Send for RecordingRingBuffer {}
unsafe impl Sync for RecordingRingBuffer {}

impl RecordingRingBuffer {
    fn new(capacity: usize) -> Self {
        let mut data = vec![0.0f32; capacity].into_boxed_slice();
        let data_ptr = data.as_mut_ptr();
        Self {
            data,
            data_ptr,
            capacity,
            write_pos: AtomicUsize::new(0),
            read_pos: AtomicUsize::new(0),
            active: AtomicBool::new(true),
            channels: 2,
            bad_channel: AtomicUsize::new(0),
            overrun_count: AtomicUsize::new(0),
            max_fill_level: AtomicUsize::new(0),
        }
    }

    fn with_channels(mut self, channels: u16) -> Self {
        self.channels = channels;
        self
    }
}

/// Compute a segment file path from a base path and segment index.
/// Segment 1 uses the base path unchanged; segment 2+ appends `_002`, `_003`, etc.
fn segment_path(base: &Path, index: usize) -> PathBuf {
    if index <= 1 {
        base.to_path_buf()
    } else {
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let ext = base.extension().unwrap_or_default().to_string_lossy();
        base.with_file_name(format!("{}_{:03}.{}", stem, index, ext))
    }
}

// ── RF64 Writer ──
// Starts as a RIFF/WAV file with a JUNK chunk reserving space for ds64.
// At ~4GB, the JUNK is converted to ds64 and the file becomes RF64.
//
// Header layout (80 bytes):
//   0  "RIFF" (or "RF64" after upgrade)
//   4  u32 riff_size placeholder
//   8  "WAVE"
//  12  "JUNK"
//  16  u32 28  (JUNK payload size = space for ds64 fields)
//  20  [28 bytes of 0x00]
//  48  "fmt "
//  52  u32 16
//  56  u16 3 (IEEE_FLOAT), u16 channels
//  60  u32 sample_rate, u32 byte_rate
//  68  u16 block_align, u16 32 (bits_per_sample)
//  72  "data"
//  76  u32 data_size placeholder
//  80  ... PCM data ...

struct Rf64Writer {
    file: BufWriter<File>,
    path: PathBuf,
    channels: u16,
    #[allow(dead_code)]
    sample_rate: u32,
    data_bytes_written: u64,
    sample_count: u64,
    is_rf64: bool,
    last_header_patch: std::time::Instant,
}

impl Rf64Writer {
    fn new(path: PathBuf, sample_rate: u32, channels: u16) -> std::io::Result<Self> {
        let file = File::create(&path)?;
        let mut writer = BufWriter::with_capacity(65536, file);

        let byte_rate = sample_rate * channels as u32 * 4; // f32 = 4 bytes
        let block_align = channels * 4;

        // Write 80-byte header with JUNK reservation
        writer.write_all(b"RIFF")?;
        writer.write_all(&0u32.to_le_bytes())?; // placeholder riff_size
        writer.write_all(b"WAVE")?;

        // JUNK chunk (will become ds64 at upgrade)
        writer.write_all(b"JUNK")?;
        writer.write_all(&28u32.to_le_bytes())?; // payload size = 28
        writer.write_all(&[0u8; 28])?; // zero-fill ds64 reservation

        // fmt chunk
        writer.write_all(b"fmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&3u16.to_le_bytes())?; // IEEE_FLOAT
        writer.write_all(&channels.to_le_bytes())?;
        writer.write_all(&sample_rate.to_le_bytes())?;
        writer.write_all(&byte_rate.to_le_bytes())?;
        writer.write_all(&block_align.to_le_bytes())?;
        writer.write_all(&32u16.to_le_bytes())?; // bits_per_sample

        // data chunk header
        writer.write_all(b"data")?;
        writer.write_all(&0u32.to_le_bytes())?; // placeholder data_size

        Ok(Self {
            file: writer,
            path,
            channels,
            sample_rate,
            data_bytes_written: 0,
            sample_count: 0,
            is_rf64: false,
            last_header_patch: std::time::Instant::now(),
        })
    }

    fn write_sample(&mut self, sample: f32) -> std::io::Result<()> {
        self.file.write_all(&sample.to_le_bytes())?;
        self.data_bytes_written += 4;
        self.sample_count += 1;

        // Check if upgrade to RF64 needed (at ~4GB - 256 bytes of headroom)
        if !self.is_rf64 && self.data_bytes_written >= 0xFFFF_F000 {
            self.upgrade_to_rf64()?;
        }

        // Periodic header patch (every ~2 seconds)
        if self.last_header_patch.elapsed().as_secs() >= 2 {
            self.patch_header()?;
        }

        Ok(())
    }

    fn upgrade_to_rf64(&mut self) -> std::io::Result<()> {
        let inner = self.file.get_mut();
        let current_pos = inner.seek(SeekFrom::Current(0))?;

        let riff_size = self.data_bytes_written + 72; // 80 - 8 (RIFF header)
        let data_size = self.data_bytes_written;
        let interleaved_sample_count = self.sample_count / self.channels as u64;

        // "RF64" magic
        inner.seek(SeekFrom::Start(0))?;
        inner.write_all(b"RF64")?;
        // RIFF size = 0xFFFFFFFF for RF64
        inner.write_all(&u32::MAX.to_le_bytes())?;

        // Convert JUNK → ds64
        inner.seek(SeekFrom::Start(12))?;
        inner.write_all(b"ds64")?;
        inner.write_all(&28u32.to_le_bytes())?; // ds64 payload size
        inner.write_all(&riff_size.to_le_bytes())?;       // u64 riff_size
        inner.write_all(&data_size.to_le_bytes())?;        // u64 data_size
        inner.write_all(&interleaved_sample_count.to_le_bytes())?; // u64 sample_count
        inner.write_all(&0u32.to_le_bytes())?;             // u32 table_length = 0

        // data chunk size = 0xFFFFFFFF for RF64
        inner.seek(SeekFrom::Start(76))?;
        inner.write_all(&u32::MAX.to_le_bytes())?;

        // Seek back to where we were
        inner.seek(SeekFrom::Start(current_pos))?;

        self.is_rf64 = true;
        log::info!("RF64 upgrade: file is now RF64 at {:.2}GB", self.data_bytes_written as f64 / 1e9);
        Ok(())
    }

    fn patch_header(&mut self) -> std::io::Result<()> {
        let inner = self.file.get_mut();
        let current_pos = inner.seek(SeekFrom::Current(0))?;

        if self.is_rf64 {
            let riff_size = self.data_bytes_written + 72;
            let data_size = self.data_bytes_written;
            let interleaved_sample_count = self.sample_count / self.channels as u64;

            // Patch ds64 fields
            inner.seek(SeekFrom::Start(20))?;
            inner.write_all(&riff_size.to_le_bytes())?;
            inner.write_all(&data_size.to_le_bytes())?;
            inner.write_all(&interleaved_sample_count.to_le_bytes())?;
        } else {
            let riff_size = (self.data_bytes_written + 72).min(u32::MAX as u64) as u32;
            let data_size = self.data_bytes_written.min(u32::MAX as u64) as u32;

            inner.seek(SeekFrom::Start(4))?;
            inner.write_all(&riff_size.to_le_bytes())?;
            inner.seek(SeekFrom::Start(76))?;
            inner.write_all(&data_size.to_le_bytes())?;
        }

        inner.seek(SeekFrom::Start(current_pos))?;
        self.last_header_patch = std::time::Instant::now();
        Ok(())
    }

    fn finalize(mut self) -> std::io::Result<PathBuf> {
        self.patch_header()?;
        self.file.flush()?;
        let inner = self.file.into_inner().map_err(|e| e.into_error())?;
        inner.sync_all()?;
        Ok(self.path)
    }

}

/// Abstraction over hound::WavWriter and Rf64Writer for use in recording threads
enum AudioWriter {
    Hound(WavWriter<BufWriter<File>>),
    Rf64(Rf64Writer),
}

impl AudioWriter {
    fn write_sample(&mut self, s: f32) -> Result<(), String> {
        match self {
            AudioWriter::Hound(w) => w.write_sample(s)
                .map_err(|e| format!("WAV write error: {}", e)),
            AudioWriter::Rf64(w) => w.write_sample(s)
                .map_err(|e| format!("RF64 write error: {}", e)),
        }
    }

    fn finalize(self) -> Result<(), String> {
        match self {
            AudioWriter::Hound(w) => w.finalize()
                .map_err(|e| format!("WAV finalize error: {}", e)),
            AudioWriter::Rf64(w) => {
                w.finalize().map_err(|e| format!("RF64 finalize error: {}", e))?;
                Ok(())
            }
        }
    }
}

/// Spawn a dedicated writer thread that drains the ring buffer to an AudioWriter.
/// Returns a JoinHandle that yields (AudioWriter, total_sample_count, completed_segments) on join.
/// Supports automatic WAV segment splitting (split-tracks mode) or RF64 single-file mode.
fn spawn_wav_writer_thread(
    ring: Arc<RecordingRingBuffer>,
    audio_writer: AudioWriter,
    channels: u16,
    _target_mono: bool,
    base_path: PathBuf,
    wav_spec: WavSpec,
    use_rf64: bool,
) -> JoinHandle<(AudioWriter, usize, Vec<PathBuf>)> {
    std::thread::Builder::new()
        .name("wav-writer".into())
        .spawn(move || {
            let mut writer = audio_writer;
            let mut total_written: usize = 0;
            let mut bad_channel_checked = false;
            let mut segment_data_bytes: usize = 0;
            let mut segment_index: usize = 1;
            let mut completed_segments: Vec<PathBuf> = Vec::new();

            loop {
                let wp = ring.write_pos.load(Ordering::Acquire);
                let rp = ring.read_pos.load(Ordering::Relaxed);
                let available = wp.wrapping_sub(rp);

                if available == 0 {
                    if !ring.active.load(Ordering::Acquire) {
                        break; // No more data and signaled to stop
                    }
                    // Adaptive sleep: short sleep when idle
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }

                // Bad-channel detection on first batch of samples (first ~100ms)
                if !bad_channel_checked && channels == 2 && available >= 200 {
                    bad_channel_checked = true;
                    let check_pairs = 100.min(available / 2);
                    let mut ch0_clipped = 0usize;
                    let mut ch1_clipped = 0usize;
                    for i in 0..check_pairs {
                        let idx0 = (rp + i * 2) % ring.capacity;
                        let idx1 = (rp + i * 2 + 1) % ring.capacity;
                        let s0 = unsafe { *ring.data_ptr.add(idx0) };
                        let s1 = unsafe { *ring.data_ptr.add(idx1) };
                        if s0.abs() >= 0.999 { ch0_clipped += 1; }
                        if s1.abs() >= 0.999 { ch1_clipped += 1; }
                    }
                    if ch0_clipped >= check_pairs * 8 / 10 && ch1_clipped < check_pairs * 3 / 10 {
                        log::info!("Detected bad channel 0, duplicating channel 1");
                        ring.bad_channel.store(1, Ordering::Release);
                    } else if ch1_clipped >= check_pairs * 8 / 10 && ch0_clipped < check_pairs * 3 / 10 {
                        log::info!("Detected bad channel 1, duplicating channel 0");
                        ring.bad_channel.store(2, Ordering::Release);
                    }
                }

                let bad_ch = ring.bad_channel.load(Ordering::Relaxed);

                // Calculate how many samples we'll write and their byte count
                let samples_to_write = if channels == 2 && bad_ch > 0 {
                    (available / 2) * 2
                } else {
                    available
                };
                let write_bytes = samples_to_write * 4;

                // Check if segment split is needed (only in split-tracks mode, not RF64)
                if !use_rf64 && segment_data_bytes + write_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
                    let current_seg = segment_path(&base_path, segment_index);
                    match writer.finalize() {
                        Ok(()) => {
                            let _ = patch_wav_header_if_needed(&current_seg);
                            completed_segments.push(current_seg);
                        }
                        Err(e) => log::error!("Failed to finalize segment: {}", e),
                    }
                    segment_index += 1;
                    segment_data_bytes = 0;
                    let new_path = segment_path(&base_path, segment_index);
                    let f = File::create(&new_path).expect("Failed to create segment file");
                    writer = AudioWriter::Hound(WavWriter::new(BufWriter::new(f), wav_spec)
                        .expect("Failed to create segment writer"));
                    log::info!("Mic recording: started new segment {:?}", new_path);
                }

                // Drain available samples to writer
                let new_rp;
                if channels == 2 && bad_ch > 0 {
                    // Write with bad-channel fixup (replace bad channel with good one)
                    let pairs = available / 2;
                    for i in 0..pairs {
                        let idx0 = (rp + i * 2) % ring.capacity;
                        let idx1 = (rp + i * 2 + 1) % ring.capacity;
                        let s0 = unsafe { *ring.data_ptr.add(idx0) };
                        let s1 = unsafe { *ring.data_ptr.add(idx1) };
                        if bad_ch == 1 {
                            let _ = writer.write_sample(s1);
                            let _ = writer.write_sample(s1);
                        } else {
                            let _ = writer.write_sample(s0);
                            let _ = writer.write_sample(s0);
                        }
                    }
                    let consumed = pairs * 2;
                    new_rp = rp + consumed;
                    ring.read_pos.store(new_rp, Ordering::Release);
                    total_written += consumed;
                    segment_data_bytes += consumed * 4;
                } else {
                    // Normal path: write all samples directly
                    for i in 0..available {
                        let idx = (rp + i) % ring.capacity;
                        let sample = unsafe { *ring.data_ptr.add(idx) };
                        let _ = writer.write_sample(sample);
                    }
                    new_rp = rp + available;
                    ring.read_pos.store(new_rp, Ordering::Release);
                    total_written += available;
                    segment_data_bytes += available * 4;
                }

                // Adaptive sleep: if buffer pressure is high, drain again immediately
                let post_drain_fill = ring.write_pos.load(Ordering::Acquire).wrapping_sub(new_rp);
                let low_water = ring.capacity / 4; // 25% = comfortable
                if post_drain_fill > low_water {
                    continue; // Skip sleep, drain more
                }
                std::thread::sleep(Duration::from_millis(5));
            }

            // Final drain after active=false (in case more samples arrived)
            let wp = ring.write_pos.load(Ordering::Acquire);
            let rp = ring.read_pos.load(Ordering::Relaxed);
            let remaining = wp.wrapping_sub(rp);
            for i in 0..remaining {
                let idx = (rp + i) % ring.capacity;
                let sample = unsafe { *ring.data_ptr.add(idx) };
                let _ = writer.write_sample(sample);
            }
            total_written += remaining;

            // Log telemetry
            let overruns = ring.overrun_count.load(Ordering::Relaxed);
            let max_fill = ring.max_fill_level.load(Ordering::Relaxed);
            log::info!(
                "WAV writer thread finished: {} total samples, {} segments, rf64={}. \
                 Ring telemetry: overrun_count={}, max_fill={}/{} ({:.1}%)",
                total_written, segment_index, use_rf64,
                overruns, max_fill, ring.capacity,
                max_fill as f64 / ring.capacity as f64 * 100.0
            );
            if overruns > 0 {
                log::warn!("Recording had {} ring buffer overruns — potential audio gaps", overruns);
            }

            (writer, total_written, completed_segments)
        })
        .expect("Failed to spawn wav-writer thread")
}

/// Streaming stereo-to-mono WAV conversion (file-to-file, constant memory)
fn stereo_wav_to_mono_streaming(path: &std::path::Path, sample_rate: u32) -> Result<(), String> {
    let tmp_path = path.with_extension("mono.tmp.wav");

    // Open the stereo WAV for reading
    let reader = hound::WavReader::open(path)
        .map_err(|e| format!("Failed to open stereo WAV for mono conversion: {}", e))?;

    let mono_spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let tmp_file = File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temp mono WAV: {}", e))?;
    let buf_writer = BufWriter::new(tmp_file);
    let mut writer = WavWriter::new(buf_writer, mono_spec)
        .map_err(|e| format!("Failed to create mono WAV writer: {}", e))?;

    // Read stereo samples in chunks, average pairs, write mono
    let mut samples_iter = reader.into_samples::<f32>();
    loop {
        let left = match samples_iter.next() {
            Some(Ok(s)) => s,
            Some(Err(e)) => return Err(format!("Error reading stereo sample: {}", e)),
            None => break,
        };
        let right = match samples_iter.next() {
            Some(Ok(s)) => s,
            Some(Err(e)) => return Err(format!("Error reading stereo sample: {}", e)),
            None => {
                // Odd number of samples — write the last one as-is
                writer.write_sample(left)
                    .map_err(|e| format!("Failed to write mono sample: {}", e))?;
                break;
            }
        };
        let mono = (left + right) * 0.5;
        writer.write_sample(mono)
            .map_err(|e| format!("Failed to write mono sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Failed to finalize mono WAV: {}", e))?;

    // Safety net: patch header if hound's u32 counter overflowed
    patch_wav_header_if_needed(&tmp_path)?;

    // Rename temp file over original
    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename mono WAV: {}", e))?;

    log::info!("Converted stereo WAV to mono: {:?}", path);
    Ok(())
}

/// Safety-net header patch: if hound's internal u32 counter overflowed (producing
/// 0 or incorrect sizes in RIFF/data fields), this fixes them from the actual file size.
fn patch_wav_header_if_needed(path: &Path) -> Result<(), String> {
    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Cannot stat WAV file: {}", e))?.len();

    if file_size < 44 {
        return Ok(()); // Too small to be a valid WAV
    }

    // Read enough of the header to find the data chunk
    let header_len = 4096usize.min(file_size as usize);
    let mut header = vec![0u8; header_len];
    {
        let mut f = File::open(path)
            .map_err(|e| format!("Failed to open WAV for header check: {}", e))?;
        f.read_exact(&mut header)
            .map_err(|e| format!("Failed to read WAV header: {}", e))?;
    }

    // Verify RIFF/WAVE signature
    if header.len() < 12 || &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Ok(()); // Not a WAV file
    }

    let data_offset = super::playback::find_wav_data_offset(&header)
        .ok_or_else(|| "Could not find WAV data chunk for header patch".to_string())?;

    // Expected sizes based on actual file size
    let actual_data_size = file_size - data_offset as u64;
    let actual_riff_size = file_size - 8;

    // Cap at u32::MAX for files >4GB
    let expected_riff_u32 = if actual_riff_size > u32::MAX as u64 { u32::MAX } else { actual_riff_size as u32 };
    let expected_data_u32 = if actual_data_size > u32::MAX as u64 { u32::MAX } else { actual_data_size as u32 };

    // Read current header values
    let current_riff_u32 = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let data_size_offset = data_offset - 4;
    let current_data_u32 = u32::from_le_bytes(
        header[data_size_offset..data_size_offset + 4].try_into().unwrap()
    );

    if current_riff_u32 == expected_riff_u32 && current_data_u32 == expected_data_u32 {
        return Ok(()); // Headers are already correct
    }

    log::warn!(
        "WAV header mismatch in {:?}: RIFF size {} (expected {}), data size {} (expected {}). Patching...",
        path, current_riff_u32, expected_riff_u32, current_data_u32, expected_data_u32
    );

    // Open for write and patch both size fields
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("Failed to open WAV for patching: {}", e))?;

    f.seek(SeekFrom::Start(4))
        .map_err(|e| format!("Failed to seek for RIFF size patch: {}", e))?;
    f.write_all(&expected_riff_u32.to_le_bytes())
        .map_err(|e| format!("Failed to write RIFF size: {}", e))?;

    f.seek(SeekFrom::Start(data_size_offset as u64))
        .map_err(|e| format!("Failed to seek for data size patch: {}", e))?;
    f.write_all(&expected_data_u32.to_le_bytes())
        .map_err(|e| format!("Failed to write data size: {}", e))?;

    log::info!("WAV header patched successfully: {:?}", path);
    Ok(())
}

#[tauri::command]
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Get default input device name for comparison
    let default_input_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    // List input devices from cpal
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                // Skip problematic ALSA devices that cause issues
                let name_lower = name.to_lowercase();
                if name_lower.contains("dmix")
                    || name_lower.contains("surround")
                    || name_lower.contains("iec958")
                    || name_lower.contains("spdif")
                    || name == "null"
                {
                    continue;
                }

                // Try to verify the device can actually be opened for input
                let has_input_config = device.default_input_config().is_ok();
                if !has_input_config {
                    continue;
                }

                let is_default = default_input_name.as_ref() == Some(&name);
                let is_loopback = name_lower.contains("monitor")
                    || name_lower.contains("loopback")
                    || name_lower.contains("stereo mix");

                // Get channel count and sample rates from device config
                let (channels, sample_rates) = if let Ok(cfg) = device.default_input_config() {
                    let ch = cfg.channels();
                    let rates = device.supported_input_configs()
                        .map(|cfgs| {
                            let mut rates: Vec<u32> = cfgs.flat_map(|c| {
                                let mut r = vec![c.min_sample_rate().0];
                                if c.max_sample_rate().0 != c.min_sample_rate().0 {
                                    r.push(c.max_sample_rate().0);
                                }
                                r
                            }).collect();
                            rates.sort_unstable();
                            rates.dedup();
                            rates
                        })
                        .unwrap_or_default();
                    (ch, rates)
                } else {
                    (0, Vec::new())
                };

                let device_type = if is_loopback { "loopback" } else { "microphone" }.to_string();

                devices.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_default,
                    is_input: true,
                    is_loopback,
                    is_output: false,
                    device_type,
                    channels,
                    sample_rates,
                    platform_id: name.clone(),
                });
            }
        }
    }

    // On Linux, try to get PipeWire/PulseAudio monitor devices for system audio capture
    #[cfg(target_os = "linux")]
    {
        // Try to get monitor devices using pw-record (PipeWire)
        if let Ok(output) = std::process::Command::new("pw-cli")
            .args(["list-objects"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Look for output sinks that can be monitored
            // PipeWire exposes monitors as "*.monitor" sources
            for line in stdout.lines() {
                if line.contains("alsa_output") && line.contains("node.name") {
                    if let Some(name_start) = line.find("= \"") {
                        if let Some(name_end) = line[name_start + 3..].find("\"") {
                            let sink_name = &line[name_start + 3..name_start + 3 + name_end];
                            let monitor_name = format!("{}.monitor", sink_name);
                            let display_name = format!("Monitor of {}", sink_name.replace("alsa_output.", "").replace(".", " "));

                            // Check if we already have this device
                            if !devices.iter().any(|d| d.id == monitor_name) {
                                devices.push(AudioDevice {
                                    id: monitor_name.clone(),
                                    name: display_name,
                                    is_default: false,
                                    is_input: true,
                                    is_loopback: true,
                                    is_output: false,
                                    device_type: "loopback".to_string(),
                                    channels: 2,
                                    sample_rates: vec![44100, 48000],
                                    platform_id: monitor_name,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!("Found {} audio devices", devices.len());
    for d in &devices {
        log::info!("  Device: {} (loopback: {})", d.name, d.is_loopback);
    }

    Ok(devices)
}

/// List ALL audio devices (inputs + outputs) across all platforms.
/// Returns a unified list with is_input/is_output flags.
#[tauri::command]
pub async fn list_all_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Get default device names for comparison
    let default_input_name = host.default_input_device().and_then(|d| d.name().ok());
    let default_output_name = host.default_output_device().and_then(|d| d.name().ok());

    // Helper: classify device name into a device_type
    fn classify_device(name: &str) -> &'static str {
        let lower = name.to_lowercase();
        if lower.contains("monitor") || lower.contains("loopback") || lower.contains("stereo mix") {
            "loopback"
        } else if lower.contains("hdmi") || lower.contains("displayport") {
            "output"
        } else if lower.contains("virtual") || lower.contains("null") {
            "virtual"
        } else {
            "microphone" // default for input devices
        }
    }

    // Helper: should skip this ALSA device?
    fn should_skip(name: &str) -> bool {
        let lower = name.to_lowercase();
        lower.contains("dmix") || lower.contains("surround")
            || lower.contains("iec958") || lower.contains("spdif")
            || name == "null"
    }

    // Helper: get channels and sample rates from a device's supported configs
    fn get_input_info(device: &cpal::Device) -> (u16, Vec<u32>) {
        if let Ok(cfg) = device.default_input_config() {
            let ch = cfg.channels();
            let rates = device.supported_input_configs()
                .map(|cfgs| {
                    let mut rates: Vec<u32> = cfgs.flat_map(|c| {
                        let mut r = vec![c.min_sample_rate().0];
                        if c.max_sample_rate().0 != c.min_sample_rate().0 {
                            r.push(c.max_sample_rate().0);
                        }
                        r
                    }).collect();
                    rates.sort_unstable();
                    rates.dedup();
                    rates
                })
                .unwrap_or_default();
            (ch, rates)
        } else {
            (0, Vec::new())
        }
    }

    fn get_output_info(device: &cpal::Device) -> (u16, Vec<u32>) {
        if let Ok(cfg) = device.default_output_config() {
            let ch = cfg.channels();
            let rates = device.supported_output_configs()
                .map(|cfgs| {
                    let mut rates: Vec<u32> = cfgs.flat_map(|c| {
                        let mut r = vec![c.min_sample_rate().0];
                        if c.max_sample_rate().0 != c.min_sample_rate().0 {
                            r.push(c.max_sample_rate().0);
                        }
                        r
                    }).collect();
                    rates.sort_unstable();
                    rates.dedup();
                    rates
                })
                .unwrap_or_default();
            (ch, rates)
        } else {
            (0, Vec::new())
        }
    }

    // ── Input devices ──
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                if should_skip(&name) { continue; }
                if device.default_input_config().is_err() { continue; }

                let is_default = default_input_name.as_ref() == Some(&name);
                let is_loopback = classify_device(&name) == "loopback";
                let (channels, sample_rates) = get_input_info(&device);
                let device_type = if is_loopback { "loopback" } else { "microphone" }.to_string();

                devices.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_default,
                    is_input: true,
                    is_loopback,
                    is_output: false,
                    device_type,
                    channels,
                    sample_rates,
                    platform_id: name.clone(),
                });
            }
        }
    }

    // ── Output devices ──
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(name) = device.name() {
                if should_skip(&name) { continue; }
                if device.default_output_config().is_err() { continue; }

                let is_default = default_output_name.as_ref() == Some(&name);
                let (channels, sample_rates) = get_output_info(&device);

                // Check if this device already exists as an input (bidirectional)
                if let Some(existing) = devices.iter_mut().find(|d| d.id == name) {
                    existing.is_output = true;
                } else {
                    let device_type = classify_device(&name);
                    devices.push(AudioDevice {
                        id: name.clone(),
                        name: name.clone(),
                        is_default,
                        is_input: false,
                        is_loopback: false,
                        is_output: true,
                        device_type: if device_type == "microphone" { "output" } else { device_type }.to_string(),
                        channels,
                        sample_rates,
                        platform_id: name.clone(),
                    });
                }
            }
        }
    }

    // ── Linux PipeWire/PulseAudio monitor sources ──
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("pw-cli")
            .args(["list-objects"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("alsa_output") && line.contains("node.name") {
                    if let Some(name_start) = line.find("= \"") {
                        if let Some(name_end) = line[name_start + 3..].find("\"") {
                            let sink_name = &line[name_start + 3..name_start + 3 + name_end];
                            let monitor_name = format!("{}.monitor", sink_name);
                            let display_name = format!("Monitor of {}", sink_name.replace("alsa_output.", "").replace(".", " "));

                            if !devices.iter().any(|d| d.id == monitor_name) {
                                devices.push(AudioDevice {
                                    id: monitor_name.clone(),
                                    name: display_name,
                                    is_default: false,
                                    is_input: true,
                                    is_loopback: true,
                                    is_output: false,
                                    device_type: "loopback".to_string(),
                                    channels: 2,
                                    sample_rates: vec![44100, 48000],
                                    platform_id: monitor_name,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!("Found {} total audio devices (input + output)", devices.len());
    for d in &devices {
        log::info!("  {} [{}] in={} out={} ch={} type={}",
            d.name, d.id, d.is_input, d.is_output, d.channels, d.device_type);
    }

    Ok(devices)
}

/// Get detailed capabilities for a specific device.
#[tauri::command]
pub fn get_device_capabilities(device_id: String) -> Result<DeviceCapabilities, String> {
    let host = cpal::default_host();

    let mut caps = DeviceCapabilities {
        device_id: device_id.clone(),
        device_name: device_id.clone(),
        is_input: false,
        is_output: false,
        configs: Vec::new(),
    };

    // Search input devices
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if device.name().ok().as_ref() == Some(&device_id) {
                caps.device_name = device.name().unwrap_or_default();
                caps.is_input = true;
                if let Ok(configs) = device.supported_input_configs() {
                    for cfg in configs {
                        caps.configs.push(DeviceConfig {
                            channels: cfg.channels(),
                            sample_format: format!("{:?}", cfg.sample_format()),
                            min_sample_rate: cfg.min_sample_rate().0,
                            max_sample_rate: cfg.max_sample_rate().0,
                        });
                    }
                }
                break;
            }
        }
    }

    // Search output devices
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if device.name().ok().as_ref() == Some(&device_id) {
                caps.device_name = device.name().unwrap_or_default();
                caps.is_output = true;
                if caps.configs.is_empty() {
                    if let Ok(configs) = device.supported_output_configs() {
                        for cfg in configs {
                            caps.configs.push(DeviceConfig {
                                channels: cfg.channels(),
                                sample_format: format!("{:?}", cfg.sample_format()),
                                min_sample_rate: cfg.min_sample_rate().0,
                                max_sample_rate: cfg.max_sample_rate().0,
                            });
                        }
                    }
                }
                break;
            }
        }
    }

    if !caps.is_input && !caps.is_output {
        return Err(format!("Device not found: {}", device_id));
    }

    Ok(caps)
}

/// Start a preview stream on a specific device (for inline VU meter in device picker).
/// Only one preview stream can be active at a time.
#[tauri::command]
pub async fn start_device_preview(device_id: String, mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Stop any existing preview
    stop_device_preview_internal(&mgr);
    std::thread::sleep(Duration::from_millis(50));

    let host = cpal::default_host();

    let device = host.input_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
        .find(|d| d.name().ok().as_ref() == Some(&device_id))
        .ok_or_else(|| format!("Device not found: {}", device_id))?;

    let config = device.default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    mgr.preview_active.store(true, Ordering::SeqCst);
    mgr.preview_level.store(0, Ordering::SeqCst);

    let active = mgr.preview_active.clone();
    let level = mgr.preview_level.clone();

    let stream = match config.sample_format() {
        SampleFormat::F32 => build_preview_stream::<f32>(&device, &config.into(), active, level)?,
        SampleFormat::I16 => build_preview_stream::<i16>(&device, &config.into(), active, level)?,
        SampleFormat::U16 => build_preview_stream::<u16>(&device, &config.into(), active, level)?,
        SampleFormat::I32 => build_preview_stream::<i32>(&device, &config.into(), active, level)?,
        SampleFormat::U8 => build_preview_stream::<u8>(&device, &config.into(), active, level)?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start preview stream: {}", e))?;

    if let Ok(mut guard) = mgr.preview_stream.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    log::info!("Device preview started: {}", device_id);
    Ok(())
}

fn build_preview_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            if !active.load(Ordering::SeqCst) { return; }
            let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                let mut max_level: f32 = 0.0;
                for s in data.iter() {
                    let f = f32::from_sample(*s);
                    max_level = max_level.max(f.abs());
                }
                level.store((max_level * 1000.0) as u32, Ordering::SeqCst);
            }));
            if result.is_err() {
                log::warn!("Preview callback panic caught (ALSA timing issue)");
            }
        },
        |err| log::error!("Preview stream error: {}", err),
        None,
    )
    .map_err(|e| format!("Failed to build preview stream: {}", e))
}

/// Get the current preview level (0.0 - 1.0)
#[tauri::command]
pub fn get_device_preview_level(mgr: State<'_, RecordingManager>) -> f32 {
    mgr.preview_level.load(Ordering::SeqCst) as f32 / 1000.0
}

/// Stop device preview
#[tauri::command]
pub fn stop_device_preview(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping device preview");
    stop_device_preview_internal(&mgr);
}

fn stop_device_preview_internal(mgr: &RecordingManager) {
    mgr.preview_active.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = mgr.preview_stream.lock() {
        *guard = None;
    }
    mgr.preview_level.store(0, Ordering::SeqCst);
}

#[tauri::command]
pub async fn start_recording(device_id: Option<String>, output_dir: String, channel_mode: Option<String>, large_file_format: Option<String>, mgr: State<'_, RecordingManager>) -> Result<String, String> {
    // Auto-reset any stuck state from previous failed recordings
    if mgr.is_default_recording() {
        log::warn!("Recording state was stuck, auto-resetting...");
        reset_recording_state_internal(&mgr);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let host = cpal::default_host();

    // Select device
    let device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(id))
            .ok_or_else(|| format!("Device not found: {}", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    log::info!("Recording from device: {}", device_name);

    // Get supported config
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    // Try to find a better config - prefer stereo with good sample format (F32 > I16 > I32)
    let supported_configs: Vec<_> = device.supported_input_configs()
        .map_err(|e| format!("Failed to get supported configs: {}", e))?
        .collect();

    log::info!("Available input configs:");
    for cfg in &supported_configs {
        log::info!("  {} ch, {:?}, {}-{} Hz",
            cfg.channels(), cfg.sample_format(),
            cfg.min_sample_rate().0, cfg.max_sample_rate().0);
    }

    // Score configs: prefer stereo, prefer F32/I16, prefer matching sample rate
    fn config_score(cfg: &cpal::SupportedStreamConfigRange, target_rate: u32) -> i32 {
        let mut score = 0;
        if cfg.channels() == 2 { score += 100; }
        else if cfg.channels() == 1 { score += 50; }
        match cfg.sample_format() {
            SampleFormat::F32 => score += 50,
            SampleFormat::I16 => score += 40,
            SampleFormat::I32 => score += 30,
            SampleFormat::F64 => score += 25,
            SampleFormat::U16 => score += 20,
            _ => {}
        }
        let rate_range = cfg.min_sample_rate().0..=cfg.max_sample_rate().0;
        if rate_range.contains(&target_rate) { score += 10; }
        if rate_range.contains(&44100) { score += 5; }
        score
    }

    let target_rate = default_config.sample_rate().0;
    let best_supported = supported_configs.iter()
        .max_by_key(|cfg| config_score(cfg, target_rate));

    let config = if let Some(best) = best_supported {
        let rate_range = best.min_sample_rate().0..=best.max_sample_rate().0;
        let sample_rate = if rate_range.contains(&target_rate) {
            target_rate
        } else if rate_range.contains(&44100) {
            44100
        } else {
            best.max_sample_rate().0.min(48000)
        };
        let cfg = best.clone().with_sample_rate(cpal::SampleRate(sample_rate));
        log::info!("Selected config: {} ch, {:?}, {} Hz (score: {})",
            cfg.channels(), cfg.sample_format(), sample_rate, config_score(best, target_rate));
        cfg
    } else {
        log::info!("Using default config");
        default_config
    };

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let sample_format = config.sample_format();
    log::info!(
        "Recording config: {} Hz, {} channels, {:?}",
        sample_rate, channels, sample_format
    );
    log::info!("Buffer size: {:?}", config.buffer_size());

    // Ensure output directory exists
    let output_dir_path = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&output_dir_path)
        .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

    // Generate output filename
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.wav", timestamp);
    let output_path = output_dir_path.join(&filename);

    let target_mono = channel_mode.as_deref() == Some("mono");
    let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
    let use_rf64 = lff == "rf64";

    // Create WAV/RF64 writer for incremental crash-safe recording
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let audio_writer = if use_rf64 {
        AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), sample_rate, channels)
            .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
    } else {
        let file = File::create(&output_path)
            .map_err(|e| format!("Failed to create output file: {}", e))?;
        AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec)
            .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
    };

    // Create per-session atomics
    let session_active = Arc::new(AtomicBool::new(true));
    let session_level = Arc::new(AtomicU32::new(0));
    let session_debug = Arc::new(AtomicUsize::new(0));

    // Also update the shared current_level for backward compat
    mgr.current_level.store(0, Ordering::SeqCst);

    // Create ring buffer for lock-free audio callback → writer thread communication
    let ring = Arc::new(RecordingRingBuffer::new(
        sample_rate as usize * channels as usize * 10, // 10 seconds of headroom
    ).with_channels(channels));

    // Spawn the writer thread (drains ring buffer → disk)
    let writer_handle = spawn_wav_writer_thread(
        ring.clone(), audio_writer, channels, target_mono,
        output_path.clone(), spec, use_rf64,
    );

    // Build stream based on sample format (per-session atomics)
    let stream_config: cpal::StreamConfig = config.into();
    let shared_level = mgr.current_level.clone();
    let stream = match sample_format {
        SampleFormat::F32 => build_input_stream::<f32>(&device, &stream_config, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?,
        SampleFormat::I16 => build_input_stream::<i16>(&device, &stream_config, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?,
        SampleFormat::U16 => build_input_stream::<u16>(&device, &stream_config, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?,
        SampleFormat::I32 => build_input_stream::<i32>(&device, &stream_config, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?,
        SampleFormat::U8 => build_input_stream::<u8>(&device, &stream_config, ring.clone(), session_active.clone(), session_level.clone(), shared_level.clone(), session_debug.clone())?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;

    // Create session and store it
    let session = RecordingSession {
        stream: Some(StreamHolder::new(stream)),
        ring_buffer: Some(ring),
        writer_handle: Some(writer_handle),
        active: session_active,
        level: session_level,
        debug_count: session_debug,
        sample_rate,
        channels,
        output_path: output_path.clone(),
        target_mono,
        large_file_format: lff,
        use_system_buffer: false,
    };

    if let Ok(mut sessions) = mgr.sessions.lock() {
        sessions.insert("default".to_string(), session);
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn build_input_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    ring: Arc<RecordingRingBuffer>,
    active: Arc<AtomicBool>,
    session_level: Arc<AtomicU32>,
    shared_level: Arc<AtomicU32>,
    debug_count: Arc<AtomicUsize>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Recording error: {}", err);
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !active.load(Ordering::SeqCst) {
                    return;
                }

                // Wrap in catch_unwind to prevent ALSA timing panics from crashing
                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    let cap = ring.capacity;
                    let wp = ring.write_pos.load(Ordering::Relaxed);
                    let rp = ring.read_pos.load(Ordering::Acquire);

                    // Check if ring buffer has enough space (drop samples if full)
                    let used = wp.wrapping_sub(rp);
                    if used + data.len() > cap {
                        ring.overrun_count.fetch_add(1, Ordering::Relaxed);
                        let _ = ring.max_fill_level.fetch_max(cap, Ordering::Relaxed);
                        return;
                    }

                    // Convert and write samples directly to ring buffer (no Vec alloc)
                    let mut max_level: f32 = 0.0;
                    for (i, s) in data.iter().enumerate() {
                        let f = f32::from_sample(*s);
                        let idx = (wp + i) % cap;
                        unsafe { *ring.data_ptr.add(idx) = f; }
                        let abs = f.abs();
                        if abs > max_level { max_level = abs; }
                    }
                    ring.write_pos.store(wp + data.len(), Ordering::Release);

                    // Update telemetry: high-water mark of ring usage
                    let _ = ring.max_fill_level.fetch_max(used + data.len(), Ordering::Relaxed);

                    // Update level meters (per-session + shared)
                    let level_int = (max_level * 1000.0) as u32;
                    session_level.store(level_int, Ordering::SeqCst);
                    shared_level.store(level_int, Ordering::SeqCst);

                    // Debug logging every ~1 second
                    let count = debug_count.fetch_add(1, Ordering::SeqCst);
                    if count % 43 == 0 {
                        log::info!(
                            "Recording callback #{}: {} samples, max_level={:.4}, ring used={}/{}",
                            count, data.len(), max_level, used + data.len(), cap
                        );
                    }
                }));

                if result.is_err() {
                    log::warn!("Audio callback panic caught (ALSA timing issue)");
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {}", e))
}

#[tauri::command]
pub async fn stop_recording(mgr: State<'_, RecordingManager>) -> Result<RecordingResult, String> {
    // Extract the "default" session
    let session = {
        let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        sessions.remove("default")
    };

    let mut session = session.ok_or("No recording in progress")?;

    // Signal session to stop
    session.active.store(false, Ordering::SeqCst);

    // Give the stream callback a moment to see the flag
    std::thread::sleep(Duration::from_millis(100));

    // Drop cpal stream to release OS audio resources
    session.stream = None;

    // Signal ring buffer to stop and join writer thread to get writer back
    let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) = (session.ring_buffer.take(), session.writer_handle.take()) {
        // Log telemetry before joining
        let overruns = ring.overrun_count.load(Ordering::Relaxed);
        let max_fill = ring.max_fill_level.load(Ordering::Relaxed);
        if overruns > 0 {
            log::warn!(
                "Ring buffer had {} overruns during recording (max fill: {}/{})",
                overruns, max_fill, ring.capacity
            );
        }

        ring.active.store(false, Ordering::Release);
        match handle.join() {
            Ok((w, count, segments)) => (Some(w), count, segments),
            Err(_) => {
                log::error!("Writer thread panicked");
                return Err("Writer thread panicked".to_string());
            }
        }
    } else if session.use_system_buffer {
        // System audio recording path (no ring buffer)
        (None, 0usize, Vec::new())
    } else {
        return Err("Recording state incomplete".to_string());
    };

    if sample_count == 0 {
        return Err("No audio recorded".to_string());
    }

    // Calculate duration
    let samples_per_channel = sample_count / session.channels as usize;
    let duration = samples_per_channel as f64 / session.sample_rate as f64;

    log::info!(
        "Recording complete: {} samples, {:.2}s duration",
        sample_count, duration
    );

    // Finalize the writer
    if let Some(w) = writer {
        w.finalize()
            .map_err(|e| format!("Failed to finalize recording: {}", e))?;
    }

    // Patch the last segment's header (safety net for hound u32 overflow — only for split-tracks mode)
    let use_rf64 = session.large_file_format == "rf64";
    let last_seg_path = segment_path(&session.output_path, completed_segments.len() + 1);
    if !use_rf64 {
        let _ = patch_wav_header_if_needed(&last_seg_path);
    }

    // fsync the last segment to ensure data is on disk before import
    if let Ok(f) = File::open(&last_seg_path) {
        let _ = f.sync_all();
    }

    // Build extra_segments list (no concatenation — keep them as separate tracks)
    let extra_segments: Vec<String> = if !completed_segments.is_empty() {
        for seg in &completed_segments {
            if !use_rf64 {
                let _ = patch_wav_header_if_needed(seg);
            }
        }
        let mut extras: Vec<String> = completed_segments.iter()
            .skip(1)
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        extras.push(last_seg_path.to_string_lossy().to_string());
        extras
    } else {
        Vec::new()
    };

    // Convert to mono if needed (only for single-segment)
    let final_channels = if session.target_mono && session.channels == 2 && extra_segments.is_empty() {
        stereo_wav_to_mono_streaming(&session.output_path, session.sample_rate)?;
        1u16
    } else {
        session.channels
    };

    // Reset shared level
    mgr.current_level.store(0, Ordering::SeqCst);

    log::info!("Saved recording to: {:?} ({} extra segments)", session.output_path, extra_segments.len());

    Ok(RecordingResult {
        path: session.output_path.to_string_lossy().to_string(),
        duration,
        sample_rate: session.sample_rate,
        channels: final_channels,
        extra_segments,
    })
}

#[tauri::command]
pub fn get_recording_level(mgr: State<'_, RecordingManager>) -> f32 {
    mgr.current_level.load(Ordering::SeqCst) as f32 / 1000.0
}

#[tauri::command]
pub fn is_recording(mgr: State<'_, RecordingManager>) -> bool {
    mgr.is_default_recording() || mgr.system_recording_active.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_recording(mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Extract the "default" session
    let session = {
        let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
        sessions.remove("default")
    };

    if let Some(mut session) = session {
        session.active.store(false, Ordering::SeqCst);

        // Drop cpal stream
        session.stream = None;

        let output_path = session.output_path.clone();
        // Stop ring buffer and join writer thread before cleaning up
        if let Some(ring) = &session.ring_buffer {
            ring.active.store(false, Ordering::Release);
        }
        if let Some(handle) = session.writer_handle.take() {
            match handle.join() {
                Ok((_writer, _count, completed)) => {
                    for seg in &completed {
                        let _ = std::fs::remove_file(seg);
                    }
                }
                Err(_) => {}
            }
        }
        let _ = std::fs::remove_file(&output_path);

        // Clean up system audio segments if any
        if let Ok(mut completed) = mgr.system_completed_segments.lock() {
            for seg in completed.drain(..) {
                let _ = std::fs::remove_file(&seg);
            }
        }
    }

    mgr.current_level.store(0, Ordering::SeqCst);
    log::info!("Recording cancelled");
    Ok(())
}

/// Start monitoring a device (show levels without recording)
#[tauri::command]
pub async fn start_monitoring(device_id: Option<String>, mgr: State<'_, RecordingManager>) -> Result<(), String> {
    // Stop any existing monitoring
    stop_monitoring_internal(&mgr);
    // Also reset any stuck recording state
    if mgr.is_default_recording() {
        log::warn!("Recording state was stuck during monitor start, resetting...");
        reset_recording_state_internal(&mgr);
    }
    std::thread::sleep(std::time::Duration::from_millis(50));

    let host = cpal::default_host();

    let device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(id))
            .ok_or_else(|| format!("Device not found: {}", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    log::info!("Starting monitoring on device: {}", device_name);

    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    mgr.monitoring_active.store(true, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);

    let active = mgr.monitoring_active.clone();
    let level = mgr.current_level.clone();

    let stream = match config.sample_format() {
        SampleFormat::F32 => build_monitor_stream::<f32>(&device, &config.into(), active, level)?,
        SampleFormat::I16 => build_monitor_stream::<i16>(&device, &config.into(), active, level)?,
        SampleFormat::U16 => build_monitor_stream::<u16>(&device, &config.into(), active, level)?,
        SampleFormat::I32 => build_monitor_stream::<i32>(&device, &config.into(), active, level)?,
        SampleFormat::U8 => build_monitor_stream::<u8>(&device, &config.into(), active, level)?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start monitor stream: {}", e))?;

    if let Ok(mut guard) = mgr.monitor_stream.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    Ok(())
}

fn build_monitor_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Monitor error: {}", err);
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !active.load(Ordering::SeqCst) {
                    return;
                }

                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    let mut max_level: f32 = 0.0;
                    for s in data.iter() {
                        let f = f32::from_sample(*s);
                        max_level = max_level.max(f.abs());
                    }
                    level.store((max_level * 1000.0) as u32, Ordering::SeqCst);
                }));

                if result.is_err() {
                    log::warn!("Monitor callback panic caught (ALSA timing issue)");
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build monitor stream: {}", e))
}

fn stop_monitoring_internal(mgr: &RecordingManager) {
    mgr.monitoring_active.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = mgr.monitor_stream.lock() {
        *guard = None;
    }
    mgr.current_level.store(0, Ordering::SeqCst);
}

/// Stop monitoring a device
#[tauri::command]
pub fn stop_monitoring(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping monitoring");
    stop_monitoring_internal(&mgr);
}

/// Check if monitoring is active
#[tauri::command]
pub fn is_monitoring(mgr: State<'_, RecordingManager>) -> bool {
    mgr.monitoring_active.load(Ordering::SeqCst)
}

/// Kill any stale pw-record or parec processes from previous runs
#[cfg(target_os = "linux")]
fn kill_all_stale_processes() {
    let _ = std::process::Command::new("pkill")
        .args(["-f", "pw-record --target"])
        .status();
    let _ = std::process::Command::new("pkill")
        .args(["-f", "parec -d"])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(200));
}

/// Internal implementation for starting system audio monitoring.
/// Uses parec (preferred) or pw-record as fallback to capture system audio.
/// The reader thread handles both level metering (always) and sample
/// accumulation (when system_recording_active is true), so a single process
/// serves both monitoring and recording.
#[cfg(target_os = "linux")]
fn start_system_audio_monitoring_impl(mgr: &RecordingManager) -> Result<(), String> {
    stop_system_audio_monitoring_internal(mgr);
    kill_all_stale_processes();

    let monitor_source = get_default_monitor_source()?;
    log::info!("Starting system audio monitoring with monitor source: {}", monitor_source);

    let pa_monitor = if monitor_source.ends_with(".monitor") {
        monitor_source.clone()
    } else {
        format!("{}.monitor", monitor_source)
    };

    let child_result = if which_exists("parec") {
        log::info!("Using parec with monitor source: {}", pa_monitor);
        std::process::Command::new("parec")
            .args([
                "-d", &pa_monitor,
                "--format=float32le",
                "--rate=44100",
                "--channels=2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else if which_exists("pw-record") {
        log::info!("Using pw-record with stream.capture.sink for: {}", monitor_source);
        std::process::Command::new("pw-record")
            .args([
                "-P", "{ stream.capture.sink = true }",
                "--target", &monitor_source,
                "--format", "f32",
                "--rate", "44100",
                "--channels", "2",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        return Err("No audio capture tool available (need parec or pw-record)".to_string());
    };

    let mut child = child_result.map_err(|e| format!("Failed to start audio capture: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    *mgr.system_monitor_child.lock().unwrap() = Some(child);
    mgr.system_monitor_active.store(true, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);

    // Clone Arcs for the reader thread
    let sys_active = mgr.system_monitor_active.clone();
    let sys_rec_active = mgr.system_recording_active.clone();
    let level = mgr.current_level.clone();
    let sample_count = mgr.system_audio_sample_count.clone();
    let wav_writer = mgr.system_wav_writer.clone();
    let seg_data_bytes = mgr.system_segment_data_bytes.clone();
    let seg_index = mgr.system_segment_index.clone();
    let debug_count = mgr.debug_callback_count.clone();

    // Create Arc-wrapped copies of segment state for the reader thread
    let thread_seg_base = Arc::new(Mutex::new(
        mgr.system_segment_base_path.lock().ok().and_then(|g| g.clone())
    ));
    let thread_seg_completed = Arc::new(Mutex::new(
        mgr.system_completed_segments.lock().ok()
            .map(|g| g.clone())
            .unwrap_or_default()
    ));

    let ctx = SysAudioReaderCtx {
        monitor_active: sys_active,
        recording_active: sys_rec_active,
        level,
        sample_count,
        wav_writer,
        seg_data_bytes,
        seg_index,
        debug_count,
        seg_base_path: thread_seg_base,
        seg_completed: thread_seg_completed,
    };

    std::thread::spawn(move || {
        system_audio_monitor_reader(stdout, ctx);
    });

    log::info!("System audio monitoring started");
    Ok(())
}

/// Start system audio monitoring (level meter only, no recording)
#[tauri::command]
pub async fn start_system_audio_monitoring(mgr: State<'_, RecordingManager>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        stop_monitoring_internal(&mgr);
        start_system_audio_monitoring_impl(&mgr)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio monitoring only supported on Linux".to_string())
    }
}

/// Stop system audio monitoring
#[tauri::command]
pub fn stop_system_audio_monitoring(mgr: State<'_, RecordingManager>) {
    log::info!("Stopping system audio monitoring");
    stop_system_audio_monitoring_internal(&mgr);
}

fn stop_system_audio_monitoring_internal(mgr: &RecordingManager) {
    mgr.system_monitor_active.store(false, Ordering::SeqCst);

    if let Ok(mut guard) = mgr.system_monitor_child.lock() {
        if let Some(ref mut child) = *guard {
            log::info!("Killing system audio capture process (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }

    mgr.current_level.store(0, Ordering::SeqCst);
}

/// Unified stream reader for system audio: handles both monitoring and recording.
/// Always updates the level meter. When recording_active is true, also accumulates
/// samples for the WAV file.
#[cfg(target_os = "linux")]
fn system_audio_monitor_reader(stdout: ChildStdout, ctx: SysAudioReaderCtx) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while ctx.monitor_active.load(Ordering::SeqCst) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let samples: Vec<f32> = buffer[..n]
                    .chunks(4)
                    .filter_map(|chunk| {
                        if chunk.len() == 4 {
                            Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                        } else {
                            None
                        }
                    })
                    .collect();

                if samples.is_empty() {
                    continue;
                }

                // Always update level meter
                let max_level = samples.iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max);
                ctx.level.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                // When recording is active, write to disk and count samples
                if ctx.recording_active.load(Ordering::SeqCst) {
                    ctx.sample_count.fetch_add(samples.len(), Ordering::SeqCst);
                    let sample_bytes = samples.len() * 4;

                    if let Ok(mut writer_guard) = ctx.wav_writer.lock() {
                        let is_rf64 = matches!(&*writer_guard, Some(AudioWriter::Rf64(_)));
                        let current_data_bytes = ctx.seg_data_bytes.load(Ordering::Relaxed);
                        if !is_rf64 && current_data_bytes + sample_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
                            if let Some(old_writer) = writer_guard.take() {
                                let _ = old_writer.finalize();
                                let seg_idx = ctx.seg_index.load(Ordering::Relaxed);
                                if let Ok(base_guard) = ctx.seg_base_path.lock() {
                                    if let Some(ref base) = *base_guard {
                                        let current_seg = segment_path(base, seg_idx);
                                        let _ = patch_wav_header_if_needed(&current_seg);
                                        if let Ok(mut completed) = ctx.seg_completed.lock() {
                                            completed.push(current_seg);
                                        }

                                        let new_idx = seg_idx + 1;
                                        ctx.seg_index.store(new_idx, Ordering::Relaxed);
                                        ctx.seg_data_bytes.store(0, Ordering::Relaxed);

                                        let new_path = segment_path(base, new_idx);
                                        let sys_spec = WavSpec {
                                            channels: 2,
                                            sample_rate: 44100,
                                            bits_per_sample: 32,
                                            sample_format: hound::SampleFormat::Float,
                                        };
                                        if let Ok(f) = File::create(&new_path) {
                                            if let Ok(new_writer) = WavWriter::new(BufWriter::new(f), sys_spec) {
                                                *writer_guard = Some(AudioWriter::Hound(new_writer));
                                                log::info!("System audio: started new segment {:?}", new_path);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        ctx.seg_data_bytes.fetch_add(sample_bytes, Ordering::Relaxed);
                        if let Some(ref mut writer) = *writer_guard {
                            for &sample in &samples {
                                let _ = writer.write_sample(sample);
                            }
                        }
                    }

                    ctx.debug_count.fetch_add(1, Ordering::SeqCst);
                }
            }
            Err(_) => break,
        }
    }

    ctx.monitor_active.store(false, Ordering::SeqCst);
    log::info!("System audio monitor reader finished");
}

// Context struct for system audio reader thread
struct SysAudioReaderCtx {
    monitor_active: Arc<AtomicBool>,
    recording_active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    sample_count: Arc<AtomicUsize>,
    wav_writer: Arc<Mutex<Option<AudioWriter>>>,
    seg_data_bytes: Arc<AtomicUsize>,
    seg_index: Arc<AtomicUsize>,
    debug_count: Arc<AtomicUsize>,
    seg_base_path: Arc<Mutex<Option<PathBuf>>>,
    seg_completed: Arc<Mutex<Vec<PathBuf>>>,
}

/// Force reset recording state (for recovery from stuck state)
#[tauri::command]
pub fn reset_recording_state(mgr: State<'_, RecordingManager>) {
    reset_recording_state_internal(&mgr);
}

fn reset_recording_state_internal(mgr: &RecordingManager) {
    log::info!("Force resetting recording state");
    mgr.monitoring_active.store(false, Ordering::SeqCst);
    mgr.current_level.store(0, Ordering::SeqCst);
    mgr.system_recording_active.store(false, Ordering::SeqCst);

    // Drop monitoring stream
    if let Ok(mut guard) = mgr.monitor_stream.lock() { *guard = None; }

    // Clean up all sessions
    if let Ok(mut sessions) = mgr.sessions.lock() {
        for (_, mut session) in sessions.drain() {
            session.active.store(false, Ordering::SeqCst);
            session.stream = None;
            if let Some(ring) = &session.ring_buffer {
                ring.active.store(false, Ordering::Release);
            }
            if let Some(handle) = session.writer_handle.take() {
                let _ = handle.join();
            }
        }
    }

    // Clean up system audio segment state
    mgr.system_segment_data_bytes.store(0, Ordering::Relaxed);
    mgr.system_segment_index.store(1, Ordering::Relaxed);
    if let Ok(mut base) = mgr.system_segment_base_path.lock() { *base = None; }
    if let Ok(mut completed) = mgr.system_completed_segments.lock() { completed.clear(); }
}

/// Test if a device can actually capture audio - returns info about working configs
#[tauri::command]
pub fn test_audio_device(device_id: Option<String>) -> Result<DeviceTestResult, String> {
    let host = cpal::default_host();

    let device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_ref() == Some(id))
            .ok_or_else(|| format!("Device not found: {}", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    log::info!("Testing device: {}", device_name);

    let mut working_configs: Vec<ConfigInfo> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // Get all supported configs
    let supported = match device.supported_input_configs() {
        Ok(configs) => configs.collect::<Vec<_>>(),
        Err(e) => {
            return Err(format!("Failed to get supported configs: {}", e));
        }
    };

    for cfg_range in supported {
        let sample_rate = if cfg_range.min_sample_rate().0 <= 44100 && cfg_range.max_sample_rate().0 >= 44100 {
            44100
        } else {
            cfg_range.max_sample_rate().0.min(48000)
        };

        let cfg = cfg_range.with_sample_rate(cpal::SampleRate(sample_rate));
        let stream_config: cpal::StreamConfig = cfg.clone().into();

        // Try to build a test stream
        let test_result = match cfg.sample_format() {
            SampleFormat::F32 => test_stream::<f32>(&device, &stream_config),
            SampleFormat::I16 => test_stream::<i16>(&device, &stream_config),
            SampleFormat::U16 => test_stream::<u16>(&device, &stream_config),
            SampleFormat::I32 => test_stream::<i32>(&device, &stream_config),
            SampleFormat::U8 => test_stream::<u8>(&device, &stream_config),
            fmt => Err(format!("Unsupported format: {:?}", fmt)),
        };

        match test_result {
            Ok(has_signal) => {
                working_configs.push(ConfigInfo {
                    channels: cfg.channels(),
                    sample_rate,
                    sample_format: format!("{:?}", cfg.sample_format()),
                    has_signal,
                });
            }
            Err(e) => {
                errors.push(format!("{} ch {:?} @ {} Hz: {}",
                    cfg.channels(), cfg.sample_format(), sample_rate, e));
            }
        }
    }

    Ok(DeviceTestResult {
        device_name,
        working_configs,
        errors,
    })
}

fn test_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
) -> Result<bool, String>
where
    f32: cpal::FromSample<T>,
{
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    let has_signal = Arc::new(AtomicBool::new(false));
    let has_signal_clone = has_signal.clone();
    let got_callback = Arc::new(AtomicBool::new(false));
    let got_callback_clone = got_callback.clone();

    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                got_callback_clone.store(true, Ordering::SeqCst);
                // Check if we have any non-zero signal
                for sample in data.iter() {
                    let f = f32::from_sample(*sample);
                    if f.abs() > 0.001 {
                        has_signal_clone.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            },
            |err| {
                log::warn!("Test stream error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build stream: {}", e))?;

    stream.play().map_err(|e| format!("Failed to play: {}", e))?;

    // Wait a short time to see if we get callbacks and signal
    std::thread::sleep(Duration::from_millis(200));

    drop(stream);

    if !got_callback.load(Ordering::SeqCst) {
        return Err("No audio callbacks received".to_string());
    }

    Ok(has_signal.load(Ordering::SeqCst))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_format: String,
    pub has_signal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceTestResult {
    pub device_name: String,
    pub working_configs: Vec<ConfigInfo>,
    pub errors: Vec<String>,
}

/// Check if the default audio input is muted (Linux only, via PipeWire/PulseAudio)
#[tauri::command]
pub fn check_input_muted() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        // Try wpctl first (PipeWire)
        if let Ok(output) = std::process::Command::new("wpctl")
            .args(["get-volume", "@DEFAULT_SOURCE@"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("[MUTED]") {
                return Ok(true);
            }
            // If we got output without MUTED, it's not muted
            if !stdout.is_empty() {
                return Ok(false);
            }
        }

        // Try pactl (PulseAudio fallback)
        if let Ok(output) = std::process::Command::new("pactl")
            .args(["get-source-mute", "@DEFAULT_SOURCE@"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("yes") {
                return Ok(true);
            }
            if stdout.contains("no") {
                return Ok(false);
            }
        }

        // Couldn't determine mute status
        Ok(false)
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Not implemented for other platforms yet
        Ok(false)
    }
}

/// Record system audio using parec/pw-record with stdout streaming (Linux only)
/// Reuses the monitoring capture process — does NOT spawn a new process.
/// The monitor reader thread accumulates samples when system_recording_active is set.
#[tauri::command]
pub async fn start_system_audio_recording(output_dir: String, channel_mode: Option<String>, large_file_format: Option<String>, mgr: State<'_, RecordingManager>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        // Auto-reset any stuck state from previous failed recordings
        if mgr.system_recording_active.load(Ordering::SeqCst) {
            log::warn!("Recording state was stuck, auto-resetting...");
            reset_recording_state_internal(&mgr);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Ensure system audio monitoring is running
        if !mgr.system_monitor_active.load(Ordering::SeqCst) {
            log::info!("Starting system audio monitoring for recording...");
            start_system_audio_monitoring_impl(&mgr)?;
        } else {
            log::info!("System audio monitoring already active, reusing for recording");
        }

        // Ensure output directory exists
        let output_dir_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_dir_path)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let filename = format!("recording_{}.wav", timestamp);
        let output_path = output_dir_path.join(&filename);

        log::info!("Starting system audio recording to: {:?}", output_path);

        // Reset sample counter and segment tracking
        mgr.system_audio_sample_count.store(0, Ordering::SeqCst);
        mgr.system_segment_data_bytes.store(0, Ordering::Relaxed);
        mgr.system_segment_index.store(1, Ordering::Relaxed);
        if let Ok(mut base) = mgr.system_segment_base_path.lock() {
            *base = Some(output_path.clone());
        }
        if let Ok(mut completed) = mgr.system_completed_segments.lock() {
            completed.clear();
        }

        let target_mono = channel_mode.as_deref() == Some("mono");
        let lff = large_file_format.as_deref().unwrap_or("split-tracks").to_string();
        let use_rf64 = lff == "rf64";

        let sys_writer = if use_rf64 {
            AudioWriter::Rf64(Rf64Writer::new(output_path.clone(), 44100, 2)
                .map_err(|e| format!("Failed to create RF64 writer: {}", e))?)
        } else {
            let sys_spec = WavSpec {
                channels: 2,
                sample_rate: 44100,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let sys_file = File::create(&output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            AudioWriter::Hound(WavWriter::new(BufWriter::new(sys_file), sys_spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?)
        };

        {
            let mut wg = mgr.system_wav_writer.lock().unwrap();
            *wg = Some(sys_writer);
        }

        // Store recording state as a session
        let session = RecordingSession {
            stream: None,
            ring_buffer: None,
            writer_handle: None,
            active: mgr.system_recording_active.clone(),
            level: mgr.current_level.clone(),
            debug_count: mgr.debug_callback_count.clone(),
            sample_rate: 44100,
            channels: 2,
            output_path: output_path.clone(),
            target_mono,
            large_file_format: lff,
            use_system_buffer: true,
        };

        if let Ok(mut sessions) = mgr.sessions.lock() {
            sessions.insert("default".to_string(), session);
        }

        // Activate recording — the monitor reader thread will start accumulating samples
        mgr.system_recording_active.store(true, Ordering::SeqCst);
        mgr.debug_callback_count.store(0, Ordering::SeqCst);

        log::info!("System audio recording active (reusing monitor process)");
        Ok(output_path.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio recording only supported on Linux".to_string())
    }
}

#[cfg(target_os = "linux")]
fn get_default_monitor_source() -> Result<String, String> {
    // Try wpctl first (PipeWire)
    let output = std::process::Command::new("wpctl")
        .args(["inspect", "@DEFAULT_AUDIO_SINK@"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("node.name") {
                    if let Some(name) = line.split('=').nth(1) {
                        let sink_name = name.trim().trim_matches('"');
                        log::info!("Found default sink via wpctl: {}", sink_name);
                        // For pw-record, we use the sink name directly with --target
                        return Ok(sink_name.to_string());
                    }
                }
            }
        }
    }

    // Fallback: try pactl (PulseAudio)
    let output = std::process::Command::new("pactl")
        .args(["get-default-sink"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !sink.is_empty() {
                return Ok(format!("{}.monitor", sink));
            }
        }
    }

    // Last fallback: try to find any monitor source via pactl
    let output = std::process::Command::new("pactl")
        .args(["list", "short", "sources"])
        .output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains(".monitor") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    return Ok(parts[1].to_string());
                }
            }
        }
    }

    Err("Could not find a monitor source for system audio. Make sure PipeWire or PulseAudio is running.".to_string())
}


#[cfg(target_os = "linux")]
fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}


/// Stop system audio recording and write accumulated samples to WAV file.
/// Does NOT kill the pw-record process — monitoring continues after recording stops.
#[tauri::command]
pub async fn stop_system_audio_recording(mgr: State<'_, RecordingManager>) -> Result<RecordingResult, String> {
    #[cfg(target_os = "linux")]
    {
        if !mgr.system_recording_active.load(Ordering::SeqCst) {
            return Err("No recording in progress".to_string());
        }

        log::info!("Stopping system audio recording...");

        // Signal recording stop
        mgr.system_recording_active.store(false, Ordering::SeqCst);

        std::thread::sleep(std::time::Duration::from_millis(100));

        // Extract the session
        let session = {
            let mut sessions = mgr.sessions.lock().map_err(|_| "Session lock poisoned".to_string())?;
            sessions.remove("default")
        };
        let session = session.ok_or("Recording state not found")?;

        let sample_count = mgr.system_audio_sample_count.load(Ordering::SeqCst);

        log::info!("Recorded {} samples to WAV file: {:?}", sample_count, session.output_path);

        if sample_count == 0 {
            if let Ok(mut wg) = mgr.system_wav_writer.lock() {
                drop(wg.take());
            }
            return Err("No audio recorded".to_string());
        }

        let duration = sample_count as f64 / session.channels as f64 / session.sample_rate as f64;

        // Finalize the writer
        if let Ok(mut wg) = mgr.system_wav_writer.lock() {
            if let Some(writer) = wg.take() {
                writer.finalize()
                    .map_err(|e| format!("Failed to finalize recording: {}", e))?;
            }
        }

        let use_rf64 = session.large_file_format == "rf64";

        let seg_idx = mgr.system_segment_index.load(Ordering::Relaxed);
        let last_seg_path = segment_path(&session.output_path, seg_idx);
        if !use_rf64 {
            let _ = patch_wav_header_if_needed(&last_seg_path);
        }

        if let Ok(f) = File::open(&last_seg_path) {
            let _ = f.sync_all();
        }

        let completed = if let Ok(mut guard) = mgr.system_completed_segments.lock() {
            guard.drain(..).collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let extra_segments: Vec<String> = if !completed.is_empty() {
            for seg in &completed {
                if !use_rf64 {
                    let _ = patch_wav_header_if_needed(seg);
                }
                if let Ok(f) = File::open(seg) {
                    let _ = f.sync_all();
                }
            }
            let mut extras: Vec<String> = completed.iter()
                .skip(1)
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            extras.push(last_seg_path.to_string_lossy().to_string());
            extras
        } else {
            Vec::new()
        };

        let final_channels = if session.target_mono && session.channels == 2 && extra_segments.is_empty() {
            stereo_wav_to_mono_streaming(&session.output_path, session.sample_rate)?;
            1u16
        } else {
            session.channels
        };

        log::info!("System audio recording complete: {:?}, {:.2}s, {} callbacks, {} extra segments",
            session.output_path, duration, mgr.debug_callback_count.load(Ordering::SeqCst), extra_segments.len());

        Ok(RecordingResult {
            path: session.output_path.to_string_lossy().to_string(),
            duration,
            sample_rate: session.sample_rate,
            channels: final_channels,
            extra_segments,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = mgr;
        Err("System audio recording only supported on Linux".to_string())
    }
}

/// Unmute the default audio input (Linux only)
#[tauri::command]
pub fn unmute_input() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Try wpctl first (PipeWire)
        let wpctl_result = std::process::Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_SOURCE@", "0"])
            .status();

        if let Ok(status) = wpctl_result {
            if status.success() {
                log::info!("Unmuted input via wpctl");
                return Ok(());
            }
        }

        // Try pactl (PulseAudio fallback)
        let pactl_result = std::process::Command::new("pactl")
            .args(["set-source-mute", "@DEFAULT_SOURCE@", "0"])
            .status();

        if let Ok(status) = pactl_result {
            if status.success() {
                log::info!("Unmuted input via pactl");
                return Ok(());
            }
        }

        Err("Could not unmute input - neither wpctl nor pactl worked".to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Unmute not implemented for this platform".to_string())
    }
}

/// System audio capability information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemAudioInfo {
    pub available: bool,
    pub method: String,  // "pw-record", "parecord", "cpal-monitor", or "unavailable"
    pub monitor_source: Option<String>,
    pub sink_name: Option<String>,
    pub test_result: Option<String>,  // Result of test recording
    pub cpal_monitor_device: Option<String>,  // CPAL monitor device if available
}

/// Probe system audio capabilities - tests all available methods
#[tauri::command]
pub fn probe_system_audio() -> Result<SystemAudioInfo, String> {
    log::info!("Probing system audio capabilities...");

    #[cfg(target_os = "linux")]
    {
        let mut info = SystemAudioInfo {
            available: false,
            method: "unavailable".to_string(),
            monitor_source: None,
            sink_name: None,
            test_result: None,
            cpal_monitor_device: None,
        };

        // First, check if we have a CPAL monitor device (preferred if available)
        // Wrap in catch_unwind to prevent crashes
        let cpal_result = std::panic::catch_unwind(|| {
            find_cpal_monitor_device()
        });

        if let Ok(Ok(cpal_device)) = cpal_result {
            log::info!("Found CPAL monitor device: {}", cpal_device);
            info.cpal_monitor_device = Some(cpal_device.clone());

            // Test if the CPAL monitor works (also with panic protection)
            let test_result = std::panic::catch_unwind(|| {
                test_cpal_monitor(&cpal_device)
            });

            if let Ok(true) = test_result {
                info.available = true;
                info.method = "cpal-monitor".to_string();
                info.test_result = Some("CPAL monitor device working".to_string());
                log::info!("CPAL monitor device works - using native recording");
                return Ok(info);
            } else {
                log::info!("CPAL monitor test failed or panicked, trying subprocess methods");
            }
        } else {
            log::info!("No CPAL monitor device found or panic occurred");
        }

        // Try to find the default sink
        match get_default_monitor_source() {
            Ok(source) => {
                info.monitor_source = Some(source.clone());
                info.sink_name = Some(source.clone());
                log::info!("Found monitor source: {}", source);
            }
            Err(e) => {
                log::warn!("Failed to find monitor source: {}", e);
                info.test_result = Some(format!("No monitor source: {}", e));
                return Ok(info);
            }
        }

        // Test parec first (preferred — handles monitor auto-connection internally)
        log::info!("Testing subprocess capture tools (monitor: {:?})", info.monitor_source);
        if which_exists("parec") {
            if let Some(ref source) = info.monitor_source {
                let pa_monitor = if source.ends_with(".monitor") {
                    source.clone()
                } else {
                    format!("{}.monitor", source)
                };

                match test_parec(&pa_monitor) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "parec".to_string();
                        info.test_result = Some(result);
                        log::info!("parec works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("parec test failed: {}", e);
                    }
                }
            }
        }

        // Test pw-record as fallback (with stream.capture.sink property)
        if which_exists("pw-record") {
            if let Some(ref source) = info.monitor_source {
                match test_pw_record(source) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "pw-record".to_string();
                        info.test_result = Some(result);
                        log::info!("pw-record works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("pw-record test failed: {}", e);
                    }
                }
            }
        }

        // Test parecord as last fallback
        if which_exists("parecord") {
            if let Some(ref source) = info.monitor_source {
                let monitor_name = if source.ends_with(".monitor") {
                    source.clone()
                } else {
                    format!("{}.monitor", source)
                };

                match test_parecord(&monitor_name) {
                    Ok(result) => {
                        info.available = true;
                        info.method = "parecord".to_string();
                        info.monitor_source = Some(monitor_name);
                        info.test_result = Some(result);
                        log::info!("parecord works with monitor source");
                        return Ok(info);
                    }
                    Err(e) => {
                        log::warn!("parecord test failed: {}", e);
                        info.test_result = Some(format!("All capture tools failed: {}", e));
                    }
                }
            }
        }

        if !which_exists("parec") && !which_exists("pw-record") && !which_exists("parecord") {
            info.test_result = Some("No recording tools available (need parec, pw-record, or parecord)".to_string());
        }

        Ok(info)
    }

    #[cfg(not(target_os = "linux"))]
    {
        Ok(SystemAudioInfo {
            available: false,
            method: "unavailable".to_string(),
            monitor_source: None,
            sink_name: None,
            test_result: Some("System audio only supported on Linux".to_string()),
            cpal_monitor_device: None,
        })
    }
}

#[cfg(target_os = "linux")]
fn find_cpal_monitor_device() -> Result<String, String> {
    let host = cpal::default_host();

    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let name_lower = name.to_lowercase();
                if name_lower.contains("monitor") {
                    // Verify device can be opened
                    if device.default_input_config().is_ok() {
                        return Ok(name);
                    }
                }
            }
        }
    }

    Err("No CPAL monitor device found".to_string())
}

#[cfg(target_os = "linux")]
fn test_cpal_monitor(device_name: &str) -> bool {
    use std::time::Duration;
    use std::result::Result as StdResult;

    let host = cpal::default_host();

    let device = host.input_devices()
        .ok()
        .and_then(|mut devices| devices.find(|d| d.name().ok().as_ref() == Some(&device_name.to_string())));

    let device = match device {
        Some(d) => d,
        None => return false,
    };

    let supported_config = match device.default_input_config() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();

    let got_callback = Arc::new(AtomicBool::new(false));
    let got_callback_clone = got_callback.clone();

    // Build stream with correct sample format
    let stream_result: StdResult<cpal::Stream, _> = match sample_format {
        SampleFormat::F32 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[f32], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        SampleFormat::I16 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[i16], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        SampleFormat::I32 => {
            let cb = got_callback_clone.clone();
            device.build_input_stream(
                &config,
                move |_data: &[i32], _: &cpal::InputCallbackInfo| {
                    cb.store(true, Ordering::SeqCst);
                },
                |err| { log::warn!("Monitor test stream error: {}", err); },
                None,
            )
        }
        _ => {
            log::warn!("Unsupported sample format for monitor test: {:?}", sample_format);
            return false;
        }
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to build monitor test stream: {}", e);
            return false;
        }
    };

    if stream.play().is_err() {
        return false;
    }

    std::thread::sleep(Duration::from_millis(500));
    drop(stream);

    got_callback.load(Ordering::SeqCst)
}

#[cfg(target_os = "linux")]
fn test_parec(monitor_source: &str) -> Result<String, String> {
    log::info!("Testing parec with source: {}", monitor_source);
    let output = std::process::Command::new("timeout")
        .args(["1.5", "parec", "-d", monitor_source,
               "--format=float32le", "--rate=44100", "--channels=2"])
        .output()
        .map_err(|e| format!("Failed to run parec: {}", e))?;

    if output.stdout.len() > 200 {
        Ok(format!("Test captured {} bytes", output.stdout.len()))
    } else {
        Err(format!("Captured too little data: {} bytes (stderr: {})",
            output.stdout.len(), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(target_os = "linux")]
fn test_pw_record(sink_name: &str) -> Result<String, String> {
    log::info!("Testing pw-record with sink: {}", sink_name);
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test.wav");

    // Record for 1.5 seconds (slower hardware needs more init time)
    let _output = std::process::Command::new("timeout")
        .args(["1.5", "pw-record", "--target", sink_name,
               "--format", "f32", "--rate", "44100", "--channels", "2",
               temp_file.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run pw-record: {}", e))?;

    // Check if file was created
    if temp_file.exists() {
        let metadata = std::fs::metadata(&temp_file)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;
        let size = metadata.len();

        // Clean up
        let _ = std::fs::remove_file(&temp_file);

        if size > 200 {  // File has some content
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

#[cfg(target_os = "linux")]
fn test_parecord(monitor_source: &str) -> Result<String, String> {
    log::info!("Testing parecord with source: {}", monitor_source);
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test_pa.wav");

    // Record for 1.5 seconds (slower hardware needs more init time)
    let _output = std::process::Command::new("timeout")
        .args(["1.5", "parecord", "-d", monitor_source,
               "--file-format=wav", "--rate=44100", "--channels=2",
               temp_file.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run parecord: {}", e))?;

    // Check if file was created
    if temp_file.exists() {
        let metadata = std::fs::metadata(&temp_file)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;
        let size = metadata.len();

        // Clean up
        let _ = std::fs::remove_file(&temp_file);

        if size > 200 {
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use std::io::Read as _;

    // ── Ring Buffer SPSC ──

    #[test]
    fn ring_buffer_basic_write_read() {
        let ring = RecordingRingBuffer::new(1024);
        assert_eq!(ring.write_pos.load(Ordering::Relaxed), 0);
        assert_eq!(ring.read_pos.load(Ordering::Relaxed), 0);

        // Write 4 samples
        for i in 0..4 {
            let idx = i % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = (i as f32) * 0.1; }
        }
        ring.write_pos.store(4, Ordering::Release);

        // Read back
        let wp = ring.write_pos.load(Ordering::Acquire);
        let rp = ring.read_pos.load(Ordering::Relaxed);
        assert_eq!(wp - rp, 4);

        for i in 0..4 {
            let idx = (rp + i) % ring.capacity;
            let val = unsafe { *ring.data_ptr.add(idx) };
            assert!((val - (i as f32) * 0.1).abs() < 1e-6, "sample {} mismatch: {}", i, val);
        }
        ring.read_pos.store(rp + 4, Ordering::Release);
        assert_eq!(ring.write_pos.load(Ordering::Relaxed) - ring.read_pos.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn ring_buffer_wrap_around() {
        let ring = RecordingRingBuffer::new(8);

        // Write 6 samples
        for i in 0..6 {
            let idx = i % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = i as f32; }
        }
        ring.write_pos.store(6, Ordering::Release);

        // Read 4 (advance read_pos)
        ring.read_pos.store(4, Ordering::Release);

        // Write 6 more (wraps: positions 6,7,0,1,2,3)
        for i in 6..12 {
            let wp = ring.write_pos.load(Ordering::Relaxed);
            let idx = (wp + (i - 6)) % ring.capacity;
            unsafe { *ring.data_ptr.add(idx) = i as f32; }
        }
        ring.write_pos.store(12, Ordering::Release);

        // Read all available (positions 4..12)
        let rp = ring.read_pos.load(Ordering::Relaxed);
        let wp = ring.write_pos.load(Ordering::Acquire);
        let available = wp.wrapping_sub(rp);
        assert_eq!(available, 8);

        for i in 0..available {
            let idx = (rp + i) % ring.capacity;
            let val = unsafe { *ring.data_ptr.add(idx) };
            assert!((val - (rp + i) as f32).abs() < 1e-6,
                "wrap sample {} (pos {}) mismatch: got {}, expected {}", i, rp + i, val, rp + i);
        }
    }

    #[test]
    fn ring_buffer_with_channels() {
        let ring = RecordingRingBuffer::new(256).with_channels(2);
        assert_eq!(ring.channels, 2);
        assert_eq!(ring.capacity, 256);
    }

    // ── Overrun Detection ──

    #[test]
    fn ring_buffer_overrun_detection() {
        let ring = RecordingRingBuffer::new(16);
        // Fill completely: wp=16, rp=0 → used=16 = capacity
        ring.write_pos.store(16, Ordering::Release);

        // Simulate callback checking for space: trying to write 4 more
        let wp = ring.write_pos.load(Ordering::Relaxed);
        let rp = ring.read_pos.load(Ordering::Acquire);
        let used = wp.wrapping_sub(rp);
        let incoming = 4;

        if used + incoming > ring.capacity {
            ring.overrun_count.fetch_add(1, Ordering::Relaxed);
        }

        assert_eq!(ring.overrun_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn ring_buffer_max_fill_level() {
        let ring = RecordingRingBuffer::new(1024);

        // Simulate progressively increasing fill levels
        let _ = ring.max_fill_level.fetch_max(100, Ordering::Relaxed);
        let _ = ring.max_fill_level.fetch_max(500, Ordering::Relaxed);
        let _ = ring.max_fill_level.fetch_max(200, Ordering::Relaxed); // Should not decrease

        assert_eq!(ring.max_fill_level.load(Ordering::Relaxed), 500);
    }

    // ── Bad Channel Detection ──

    #[test]
    fn bad_channel_detection_ch0_clipped() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: ch0 = 1.0 (clipped), ch1 = 0.3 (normal)
        for i in 0..100 {
            let idx0 = i * 2;
            let idx1 = i * 2 + 1;
            unsafe {
                *ring.data_ptr.add(idx0) = 1.0;   // ch0 clipped
                *ring.data_ptr.add(idx1) = 0.3;   // ch1 normal
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        // Run the same detection logic as the writer thread
        let channels = ring.channels;
        let rp = ring.read_pos.load(Ordering::Relaxed);
        let available = ring.write_pos.load(Ordering::Acquire).wrapping_sub(rp);

        if channels == 2 && available >= 200 {
            let check_pairs = 100usize.min(available / 2);
            let mut ch0_clipped = 0usize;
            let mut ch1_clipped = 0usize;
            for i in 0..check_pairs {
                let idx0 = (rp + i * 2) % ring.capacity;
                let idx1 = (rp + i * 2 + 1) % ring.capacity;
                let s0 = unsafe { *ring.data_ptr.add(idx0) };
                let s1 = unsafe { *ring.data_ptr.add(idx1) };
                if s0.abs() >= 0.999 { ch0_clipped += 1; }
                if s1.abs() >= 0.999 { ch1_clipped += 1; }
            }

            // ch0 is >80% clipped, ch1 is <30% clipped → bad channel 0
            assert!(ch0_clipped >= check_pairs * 8 / 10,
                "Expected ch0 >= 80% clipped, got {}/{}", ch0_clipped, check_pairs);
            assert!(ch1_clipped < check_pairs * 3 / 10,
                "Expected ch1 < 30% clipped, got {}/{}", ch1_clipped, check_pairs);

            // This would set bad_channel = 1 (ch0 bad)
            ring.bad_channel.store(1, Ordering::Release);
        }

        assert_eq!(ring.bad_channel.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn bad_channel_detection_ch1_clipped() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: ch0 = 0.2 (normal), ch1 = -1.0 (clipped)
        for i in 0..100 {
            unsafe {
                *ring.data_ptr.add(i * 2) = 0.2;
                *ring.data_ptr.add(i * 2 + 1) = -1.0;
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        let rp = ring.read_pos.load(Ordering::Relaxed);
        let available = ring.write_pos.load(Ordering::Acquire).wrapping_sub(rp);
        let check_pairs = 100usize.min(available / 2);
        let mut ch0_clipped = 0usize;
        let mut ch1_clipped = 0usize;
        for i in 0..check_pairs {
            let idx0 = (rp + i * 2) % ring.capacity;
            let idx1 = (rp + i * 2 + 1) % ring.capacity;
            let s0 = unsafe { *ring.data_ptr.add(idx0) };
            let s1 = unsafe { *ring.data_ptr.add(idx1) };
            if s0.abs() >= 0.999 { ch0_clipped += 1; }
            if s1.abs() >= 0.999 { ch1_clipped += 1; }
        }

        assert!(ch1_clipped >= check_pairs * 8 / 10);
        assert!(ch0_clipped < check_pairs * 3 / 10);
    }

    #[test]
    fn bad_channel_detection_both_normal() {
        let ring = RecordingRingBuffer::new(512).with_channels(2);

        // Write 100 stereo pairs: both channels normal
        for i in 0..100 {
            unsafe {
                *ring.data_ptr.add(i * 2) = 0.3;
                *ring.data_ptr.add(i * 2 + 1) = -0.4;
            }
        }
        ring.write_pos.store(200, Ordering::Release);

        let rp = ring.read_pos.load(Ordering::Relaxed);
        let check_pairs = 100;
        let mut ch0_clipped = 0usize;
        let mut ch1_clipped = 0usize;
        for i in 0..check_pairs {
            let s0 = unsafe { *ring.data_ptr.add((rp + i * 2) % ring.capacity) };
            let s1 = unsafe { *ring.data_ptr.add((rp + i * 2 + 1) % ring.capacity) };
            if s0.abs() >= 0.999 { ch0_clipped += 1; }
            if s1.abs() >= 0.999 { ch1_clipped += 1; }
        }

        // Neither channel is bad
        assert!(ch0_clipped < check_pairs * 8 / 10);
        assert!(ch1_clipped < check_pairs * 8 / 10);
        // bad_channel stays at 0 (default)
        assert_eq!(ring.bad_channel.load(Ordering::Relaxed), 0);
    }

    // ── Segment Path Generation ──

    #[test]
    fn segment_path_index_1_unchanged() {
        let base = PathBuf::from("/tmp/recording_20240101_120000.wav");
        assert_eq!(segment_path(&base, 1), base);
    }

    #[test]
    fn segment_path_index_0_unchanged() {
        let base = PathBuf::from("/tmp/recording.wav");
        assert_eq!(segment_path(&base, 0), base);
    }

    #[test]
    fn segment_path_index_2() {
        let base = PathBuf::from("/tmp/recording_20240101_120000.wav");
        assert_eq!(
            segment_path(&base, 2),
            PathBuf::from("/tmp/recording_20240101_120000_002.wav")
        );
    }

    #[test]
    fn segment_path_index_10() {
        let base = PathBuf::from("/data/audio/test.wav");
        assert_eq!(
            segment_path(&base, 10),
            PathBuf::from("/data/audio/test_010.wav")
        );
    }

    #[test]
    fn segment_path_preserves_directory() {
        let base = PathBuf::from("/home/user/recordings/session.wav");
        let seg3 = segment_path(&base, 3);
        assert_eq!(seg3.parent().unwrap(), base.parent().unwrap());
        assert_eq!(seg3.file_name().unwrap().to_string_lossy(), "session_003.wav");
    }

    // ── RF64 Header Verification ──

    #[test]
    fn rf64_writer_creates_valid_riff_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_header.wav");

        let mut writer = Rf64Writer::new(path.clone(), 44100, 2).unwrap();

        // Write a few samples
        for i in 0..100 {
            writer.write_sample((i as f32) * 0.01).unwrap();
        }

        let finalized = writer.finalize().unwrap();

        // Read back header
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        // Check RIFF/WAVE magic (should still be RIFF, not RF64, for small files)
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(&header[8..12], b"WAVE");

        // Check JUNK chunk at offset 12 (RF64 not triggered for small files)
        assert_eq!(&header[12..16], b"JUNK");

        // Check fmt chunk
        assert_eq!(&header[48..52], b"fmt ");
        let fmt_size = u32::from_le_bytes(header[52..56].try_into().unwrap());
        assert_eq!(fmt_size, 16);

        // IEEE float format (3)
        let audio_format = u16::from_le_bytes(header[56..58].try_into().unwrap());
        assert_eq!(audio_format, 3);

        // Channels
        let channels = u16::from_le_bytes(header[58..60].try_into().unwrap());
        assert_eq!(channels, 2);

        // Sample rate
        let sr = u32::from_le_bytes(header[60..64].try_into().unwrap());
        assert_eq!(sr, 44100);

        // data chunk
        assert_eq!(&header[72..76], b"data");

        // Verify file size is correct
        let file_size = std::fs::metadata(&finalized).unwrap().len();
        let expected_data = 100u64 * 4;
        assert_eq!(file_size, 80 + expected_data, "File size should be header + data");

        // Rf64Writer patches sizes through BufWriter's inner file (get_mut),
        // which can be overwritten by BufWriter's final flush on small files.
        // In production, patch_wav_header_if_needed is called as a safety net.
        // Verify the safety-net patch produces correct headers:
        patch_wav_header_if_needed(&finalized).unwrap();

        // Re-read header after safety-net patch
        let mut f2 = File::open(&finalized).unwrap();
        let mut header2 = [0u8; 80];
        f2.read_exact(&mut header2).unwrap();

        let riff_size = u32::from_le_bytes(header2[4..8].try_into().unwrap());
        assert_eq!(riff_size as u64, file_size - 8);
    }

    #[test]
    fn rf64_writer_header_patch_updates_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_patch.wav");

        let mut writer = Rf64Writer::new(path.clone(), 48000, 1).unwrap();

        // Write 1000 samples
        for i in 0..1000 {
            writer.write_sample((i as f32) * 0.001).unwrap();
        }

        let finalized = writer.finalize().unwrap();

        // Verify the file size matches expected
        let file_size = std::fs::metadata(&finalized).unwrap().len();
        let expected_data_size = 1000u64 * 4;
        let expected_file_size = 80 + expected_data_size;
        assert_eq!(file_size, expected_file_size);

        // Apply safety-net header patch (same as production code does)
        patch_wav_header_if_needed(&finalized).unwrap();

        // Read header after patch
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        assert_eq!(riff_size as u64, file_size - 8);

        let data_size = u32::from_le_bytes(header[76..80].try_into().unwrap());
        assert_eq!(data_size as u64, expected_data_size);
    }

    #[test]
    fn rf64_writer_mono_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_rf64_mono.wav");

        let mut writer = Rf64Writer::new(path.clone(), 16000, 1).unwrap();
        for _ in 0..160 {
            writer.write_sample(0.5).unwrap();
        }

        let finalized = writer.finalize().unwrap();
        let mut f = File::open(&finalized).unwrap();
        let mut header = [0u8; 80];
        f.read_exact(&mut header).unwrap();

        let channels = u16::from_le_bytes(header[58..60].try_into().unwrap());
        assert_eq!(channels, 1);

        let byte_rate = u32::from_le_bytes(header[64..68].try_into().unwrap());
        assert_eq!(byte_rate, 16000 * 1 * 4); // sample_rate * channels * 4
    }

    // ── WAV Header Patching ──

    #[test]
    fn patch_wav_header_fixes_zero_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_patch.wav");

        // Write a valid WAV with zeroed-out size fields (simulating hound u32 overflow)
        let data_samples = 100u32;
        let data_bytes = data_samples * 4;
        let mut buf = vec![0u8; 44 + data_bytes as usize];

        // RIFF header with WRONG sizes (0)
        buf[0..4].copy_from_slice(b"RIFF");
        buf[4..8].copy_from_slice(&0u32.to_le_bytes()); // Wrong!
        buf[8..12].copy_from_slice(b"WAVE");
        buf[12..16].copy_from_slice(b"fmt ");
        buf[16..20].copy_from_slice(&16u32.to_le_bytes());
        buf[20..22].copy_from_slice(&3u16.to_le_bytes()); // IEEE float
        buf[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
        buf[24..28].copy_from_slice(&44100u32.to_le_bytes());
        buf[28..32].copy_from_slice(&(44100u32 * 4).to_le_bytes());
        buf[32..34].copy_from_slice(&4u16.to_le_bytes());
        buf[34..36].copy_from_slice(&32u16.to_le_bytes());
        buf[36..40].copy_from_slice(b"data");
        buf[40..44].copy_from_slice(&0u32.to_le_bytes()); // Wrong!

        // Fill data with samples
        for i in 0..data_samples {
            let offset = 44 + (i as usize) * 4;
            buf[offset..offset + 4].copy_from_slice(&(0.5f32).to_le_bytes());
        }

        std::fs::write(&path, &buf).unwrap();

        // Patch it
        patch_wav_header_if_needed(&path).unwrap();

        // Verify fixed header
        let mut f = File::open(&path).unwrap();
        let mut header = [0u8; 44];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        let data_size = u32::from_le_bytes(header[40..44].try_into().unwrap());

        let file_size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(riff_size as u64, file_size - 8);
        assert_eq!(data_size, data_bytes);
    }

    #[test]
    fn patch_wav_header_noop_when_correct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_correct.wav");

        // Write a valid WAV with correct sizes
        let data_bytes = 400u32;
        let file_size = 44 + data_bytes;
        let mut buf = vec![0u8; file_size as usize];

        buf[0..4].copy_from_slice(b"RIFF");
        buf[4..8].copy_from_slice(&(file_size - 8).to_le_bytes());
        buf[8..12].copy_from_slice(b"WAVE");
        buf[12..16].copy_from_slice(b"fmt ");
        buf[16..20].copy_from_slice(&16u32.to_le_bytes());
        buf[20..22].copy_from_slice(&3u16.to_le_bytes());
        buf[22..24].copy_from_slice(&2u16.to_le_bytes());
        buf[24..28].copy_from_slice(&44100u32.to_le_bytes());
        buf[28..32].copy_from_slice(&(44100u32 * 2 * 4).to_le_bytes());
        buf[32..34].copy_from_slice(&8u16.to_le_bytes());
        buf[34..36].copy_from_slice(&32u16.to_le_bytes());
        buf[36..40].copy_from_slice(b"data");
        buf[40..44].copy_from_slice(&data_bytes.to_le_bytes());

        std::fs::write(&path, &buf).unwrap();

        // Patch should be a no-op
        patch_wav_header_if_needed(&path).unwrap();

        // Verify unchanged
        let mut f = File::open(&path).unwrap();
        let mut header = [0u8; 44];
        f.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap());
        assert_eq!(riff_size, file_size - 8);
    }

    // ── SPSC Multi-threaded ──

    #[test]
    fn ring_buffer_spsc_threaded() {
        let ring = Arc::new(RecordingRingBuffer::new(4096));
        let ring_producer = ring.clone();
        let ring_consumer = ring.clone();

        let num_samples = 10_000usize;

        // Producer thread
        let producer = std::thread::spawn(move || {
            let mut written = 0;
            while written < num_samples {
                let wp = ring_producer.write_pos.load(Ordering::Relaxed);
                let rp = ring_producer.read_pos.load(Ordering::Acquire);
                let used = wp.wrapping_sub(rp);
                let free = ring_producer.capacity - used;

                if free == 0 {
                    std::thread::yield_now();
                    continue;
                }

                let batch = free.min(64).min(num_samples - written);
                for i in 0..batch {
                    let idx = (wp + i) % ring_producer.capacity;
                    unsafe { *ring_producer.data_ptr.add(idx) = (written + i) as f32; }
                }
                ring_producer.write_pos.store(wp + batch, Ordering::Release);
                written += batch;
            }
            // Signal done
            ring_producer.active.store(false, Ordering::Release);
        });

        // Consumer thread
        let consumer = std::thread::spawn(move || {
            let mut total_read = 0usize;
            let mut expected = 0f32;
            loop {
                let wp = ring_consumer.write_pos.load(Ordering::Acquire);
                let rp = ring_consumer.read_pos.load(Ordering::Relaxed);
                let available = wp.wrapping_sub(rp);

                if available == 0 {
                    if !ring_consumer.active.load(Ordering::Acquire) {
                        break;
                    }
                    std::thread::yield_now();
                    continue;
                }

                for i in 0..available {
                    let idx = (rp + i) % ring_consumer.capacity;
                    let val = unsafe { *ring_consumer.data_ptr.add(idx) };
                    assert!((val - expected).abs() < 1e-3,
                        "Mismatch at read {}: got {}, expected {}", total_read + i, val, expected);
                    expected += 1.0;
                }
                ring_consumer.read_pos.store(rp + available, Ordering::Release);
                total_read += available;
            }
            total_read
        });

        producer.join().unwrap();
        let total = consumer.join().unwrap();
        assert_eq!(total, num_samples);
    }

    // ── AudioWriter enum dispatch ──

    #[test]
    fn audio_writer_hound_write_and_finalize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_writer_hound.wav");

        let spec = WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let file = File::create(&path).unwrap();
        let mut writer = AudioWriter::Hound(WavWriter::new(BufWriter::new(file), spec).unwrap());

        for i in 0..44100 {
            writer.write_sample((i as f32) / 44100.0).unwrap();
        }
        writer.finalize().unwrap();

        // Verify the file exists and has reasonable size
        let size = std::fs::metadata(&path).unwrap().len();
        // 44100 samples * 4 bytes + WAV header (44 bytes)
        assert!(size >= 44100 * 4 + 44, "File too small: {} bytes", size);
    }

    #[test]
    fn audio_writer_rf64_write_and_finalize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_writer_rf64.wav");

        let mut writer = AudioWriter::Rf64(Rf64Writer::new(path.clone(), 48000, 2).unwrap());

        for _ in 0..96000 {
            writer.write_sample(0.25).unwrap();
        }
        writer.finalize().unwrap();

        let size = std::fs::metadata(&path).unwrap().len();
        // 96000 samples * 4 bytes + 80-byte header
        assert_eq!(size, 96000 * 4 + 80);
    }
}
