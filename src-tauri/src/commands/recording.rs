use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write, Seek, SeekFrom};
use std::panic;
use std::path::{Path, PathBuf};
use std::process::{ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

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

/// Properly hold recording and monitor streams so they can be dropped
static RECORDING_STREAM: Mutex<Option<StreamHolder>> = Mutex::new(None);
static MONITOR_STREAM: Mutex<Option<StreamHolder>> = Mutex::new(None);


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    pub is_loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

// Global recording state
lazy_static::lazy_static! {
    static ref RECORDING_STATE: Arc<Mutex<Option<RecordingState>>> = Arc::new(Mutex::new(None));
    static ref RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref MONITORING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref SYSTEM_MONITOR_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref SYSTEM_MONITOR_CHILD: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
    static ref CURRENT_LEVEL: AtomicU32 = AtomicU32::new(0);
    static ref DEBUG_CALLBACK_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    // For streaming system audio - track sample count (no accumulation)
    static ref SYSTEM_AUDIO_SAMPLE_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static ref SYSTEM_WAV_WRITER: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>> = Arc::new(Mutex::new(None));
    // System audio segment tracking (for WAV auto-split)
    static ref SYSTEM_SEGMENT_BASE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
    static ref SYSTEM_COMPLETED_SEGMENTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
}

/// Maximum PCM data bytes per WAV segment (~3.63 GB, safely below u32::MAX = 4,294,967,295)
const WAV_SEGMENT_MAX_DATA_BYTES: usize = 3_900_000_000;

/// Track bytes written to current system audio WAV segment
static SYSTEM_SEGMENT_DATA_BYTES: AtomicUsize = AtomicUsize::new(0);
/// Current system audio segment index (1-based)
static SYSTEM_SEGMENT_INDEX: AtomicUsize = AtomicUsize::new(1);

struct RecordingState {
    sample_count: usize,
    sample_rate: u32,
    channels: u16,
    output_path: PathBuf,
    use_system_buffer: bool,
    target_mono: bool,
    // Ring buffer + writer thread (mic recording only; system audio uses SYSTEM_WAV_WRITER)
    ring_buffer: Option<Arc<RecordingRingBuffer>>,
    writer_handle: Option<JoinHandle<(WavWriter<BufWriter<File>>, usize, Vec<PathBuf>)>>,
}

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

/// Spawn a dedicated writer thread that drains the ring buffer to a WavWriter.
/// Returns a JoinHandle that yields (WavWriter, total_sample_count, completed_segments) on join.
/// Supports automatic WAV segment splitting when approaching the 4GB limit.
fn spawn_wav_writer_thread(
    ring: Arc<RecordingRingBuffer>,
    wav_writer: WavWriter<BufWriter<File>>,
    channels: u16,
    _target_mono: bool,
    base_path: PathBuf,
    wav_spec: WavSpec,
) -> JoinHandle<(WavWriter<BufWriter<File>>, usize, Vec<PathBuf>)> {
    std::thread::Builder::new()
        .name("wav-writer".into())
        .spawn(move || {
            let mut writer = wav_writer;
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

                // Check if segment split is needed before writing
                if segment_data_bytes + write_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
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
                    writer = WavWriter::new(BufWriter::new(f), wav_spec)
                        .expect("Failed to create segment writer");
                    log::info!("Mic recording: started new segment {:?}", new_path);
                }

                // Drain available samples to WAV
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
                "WAV writer thread finished: {} total samples, {} segments. \
                 Ring telemetry: overrun_count={}, max_fill={}/{} ({:.1}%)",
                total_written, segment_index,
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

/// Concatenate multiple WAV segments into one file.
/// Opens the first segment for append, streams PCM data from subsequent segments
/// (skipping their WAV headers via find_wav_data_offset), deletes extras, patches header.
fn concatenate_wav_segments(segments: &[PathBuf]) -> Result<(), String> {
    if segments.len() <= 1 {
        return Ok(()); // Nothing to concatenate
    }

    log::info!("Concatenating {} WAV segments into {:?}", segments.len(), segments[0]);

    // Open first segment for appending
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .append(true)
        .open(&segments[0])
        .map_err(|e| format!("Failed to open first segment for append: {}", e))?;

    // Stream-copy PCM data from segments 2..N (64KB chunks)
    for seg_path in &segments[1..] {
        // Read header to find data offset
        let mut header_buf = [0u8; 4096];
        let mut seg_file = File::open(seg_path)
            .map_err(|e| format!("Failed to open segment {:?}: {}", seg_path, e))?;
        let header_len = seg_file.read(&mut header_buf)
            .map_err(|e| format!("Failed to read segment header: {}", e))?;

        let data_offset = super::playback::find_wav_data_offset(&header_buf[..header_len])
            .ok_or_else(|| format!("No data chunk found in segment {:?}", seg_path))?;

        // Seek to data start
        seg_file.seek(SeekFrom::Start(data_offset as u64))
            .map_err(|e| format!("Failed to seek in segment: {}", e))?;

        // Stream copy in 64KB chunks
        let mut buf = [0u8; 65536];
        loop {
            let n = seg_file.read(&mut buf)
                .map_err(|e| format!("Failed to read segment data: {}", e))?;
            if n == 0 { break; }
            file.write_all(&buf[..n])
                .map_err(|e| format!("Failed to append segment data: {}", e))?;
        }

        log::info!("Appended segment {:?}, deleting", seg_path);
        let _ = std::fs::remove_file(seg_path);
    }

    drop(file);

    // Patch the combined file's header
    patch_wav_header_if_needed(&segments[0])?;

    log::info!("Segment concatenation complete: {:?}", segments[0]);
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

                devices.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_default,
                    is_input: true,
                    is_loopback,
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
                                    id: monitor_name,
                                    name: display_name,
                                    is_default: false,
                                    is_input: true,
                                    is_loopback: true,
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

#[tauri::command]
pub async fn start_recording(device_id: Option<String>, output_dir: String, channel_mode: Option<String>) -> Result<String, String> {
    // Auto-reset any stuck state from previous failed recordings
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        log::warn!("Recording state was stuck, auto-resetting...");
        reset_recording_state();
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
        // Prefer stereo for higher-quality recording (transcription handles mono downmix separately)
        if cfg.channels() == 2 { score += 100; }
        else if cfg.channels() == 1 { score += 50; }
        // Prefer good sample formats
        match cfg.sample_format() {
            SampleFormat::F32 => score += 50,
            SampleFormat::I16 => score += 40,
            SampleFormat::I32 => score += 30,
            SampleFormat::F64 => score += 25,
            SampleFormat::U16 => score += 20,
            _ => {} // U8 and others get no bonus
        }
        // Prefer configs that support the target sample rate
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
        sample_rate,
        channels,
        sample_format
    );

    // Debug: Log more details about the device config
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

    // Create WAV writer for incremental crash-safe recording
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let file = File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let buf_writer = BufWriter::new(file);
    let wav_writer = WavWriter::new(buf_writer, spec)
        .map_err(|e| format!("Failed to create WAV writer: {}", e))?;

    // Initialize recording state (writer_handle and ring_buffer set after spawn below)
    {
        let mut state = RECORDING_STATE.lock().unwrap();
        *state = Some(RecordingState {
            sample_count: 0,
            sample_rate,
            channels,
            output_path: output_path.clone(),
            use_system_buffer: false,
            target_mono,
            ring_buffer: None,
            writer_handle: None,
        });
    }

    RECORDING_ACTIVE.store(true, Ordering::SeqCst);
    DEBUG_CALLBACK_COUNT.store(0, Ordering::SeqCst);

    // Create ring buffer for lock-free audio callback → writer thread communication
    let ring = Arc::new(RecordingRingBuffer::new(
        sample_rate as usize * channels as usize * 10, // 10 seconds of headroom
    ).with_channels(channels));

    // Spawn the WAV writer thread (drains ring buffer → disk)
    let writer_ring = ring.clone();
    let writer_handle = spawn_wav_writer_thread(
        writer_ring, wav_writer, channels, target_mono,
        output_path.clone(), spec,
    );

    // Store writer handle for stop_recording() to join
    {
        let mut state = RECORDING_STATE.lock().unwrap();
        if let Some(ref mut s) = *state {
            s.writer_handle = Some(writer_handle);
            s.ring_buffer = Some(ring.clone());
        }
    }

    // Build stream based on sample format
    let stream_config: cpal::StreamConfig = config.into();
    let stream = match sample_format {
        SampleFormat::F32 => build_input_stream::<f32>(&device, &stream_config, ring.clone())?,
        SampleFormat::I16 => build_input_stream::<i16>(&device, &stream_config, ring.clone())?,
        SampleFormat::U16 => build_input_stream::<u16>(&device, &stream_config, ring.clone())?,
        SampleFormat::I32 => build_input_stream::<i32>(&device, &stream_config, ring.clone())?,
        SampleFormat::U8 => build_input_stream::<u8>(&device, &stream_config, ring.clone())?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;

    // Store stream properly (dropped on stop/cancel to release OS audio resources)
    if let Ok(mut guard) = RECORDING_STREAM.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn build_input_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    ring: Arc<RecordingRingBuffer>,
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
                if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
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
                        // Buffer full — writer thread can't keep up. Drop this callback batch.
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

                    // Update level meter (atomic, no alloc)
                    CURRENT_LEVEL.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                    // Debug logging every ~1 second
                    let count = DEBUG_CALLBACK_COUNT.fetch_add(1, Ordering::SeqCst);
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
pub async fn stop_recording() -> Result<RecordingResult, String> {
    if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Err("No recording in progress".to_string());
    }

    RECORDING_ACTIVE.store(false, Ordering::SeqCst);

    // Give the stream callback a moment to see the flag
    std::thread::sleep(Duration::from_millis(100));

    // Drop cpal stream to release OS audio resources
    if let Ok(mut guard) = RECORDING_STREAM.lock() {
        *guard = None;
    }

    // Extract recording state
    let state = {
        let mut state_guard = RECORDING_STATE.lock().unwrap();
        state_guard.take()
    };

    let state = state.ok_or("Recording state not found")?;

    // Signal ring buffer to stop and join writer thread to get WAV writer back
    let (writer, sample_count, completed_segments) = if let (Some(ring), Some(handle)) = (state.ring_buffer, state.writer_handle) {
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
    } else {
        // System audio recording path (no ring buffer)
        (None, state.sample_count, Vec::new())
    };

    if sample_count == 0 {
        return Err("No audio recorded".to_string());
    }

    // Calculate duration
    let samples_per_channel = sample_count / state.channels as usize;
    let duration = samples_per_channel as f64 / state.sample_rate as f64;

    log::info!(
        "Recording complete: {} samples, {:.2}s duration",
        sample_count,
        duration
    );

    // Finalize the WAV writer and patch header
    if let Some(w) = writer {
        w.finalize()
            .map_err(|e| format!("Failed to finalize WAV: {}", e))?;
    }

    // Patch the last segment's header (safety net for hound u32 overflow)
    let last_seg_path = segment_path(&state.output_path, completed_segments.len() + 1);
    let _ = patch_wav_header_if_needed(&last_seg_path);

    // Concatenate segments if auto-split occurred
    if !completed_segments.is_empty() {
        let mut all_segments = completed_segments;
        all_segments.push(last_seg_path);
        concatenate_wav_segments(&all_segments)?;
    }

    // Convert to mono if needed
    let final_channels = if state.target_mono && state.channels == 2 {
        stereo_wav_to_mono_streaming(&state.output_path, state.sample_rate)?;
        1u16
    } else {
        state.channels
    };

    log::info!("Saved recording to: {:?}", state.output_path);

    Ok(RecordingResult {
        path: state.output_path.to_string_lossy().to_string(),
        duration,
        sample_rate: state.sample_rate,
        channels: final_channels,
    })
}

#[tauri::command]
pub fn get_recording_level() -> f32 {
    let level_int = CURRENT_LEVEL.load(Ordering::SeqCst);
    level_int as f32 / 1000.0
}

#[tauri::command]
pub fn is_recording() -> bool {
    RECORDING_ACTIVE.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_recording() -> Result<(), String> {
    if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Ok(());
    }

    RECORDING_ACTIVE.store(false, Ordering::SeqCst);

    // Drop cpal stream to release OS audio resources
    if let Ok(mut guard) = RECORDING_STREAM.lock() {
        *guard = None;
    }

    // Clear the recording state and clean up incomplete file(s)
    if let Ok(mut state_guard) = RECORDING_STATE.lock() {
        if let Some(s) = state_guard.take() {
            let output_path = s.output_path.clone();
            // Stop ring buffer and join writer thread before cleaning up
            if let Some(ring) = &s.ring_buffer {
                ring.active.store(false, Ordering::Release);
            }
            if let Some(handle) = s.writer_handle {
                match handle.join() {
                    Ok((_writer, _count, completed)) => {
                        // Delete completed segment files
                        for seg in &completed {
                            let _ = std::fs::remove_file(seg);
                        }
                    }
                    Err(_) => {} // Thread panicked, nothing extra to clean up
                }
            }
            let _ = std::fs::remove_file(&output_path);

            // Clean up system audio segments if any
            if let Ok(mut completed) = SYSTEM_COMPLETED_SEGMENTS.lock() {
                for seg in completed.drain(..) {
                    let _ = std::fs::remove_file(&seg);
                }
            }
        }
    }

    log::info!("Recording cancelled");
    Ok(())
}

/// Start monitoring a device (show levels without recording)
#[tauri::command]
pub async fn start_monitoring(device_id: Option<String>) -> Result<(), String> {
    // Stop any existing monitoring and give the old stream callback time to see the flag
    stop_monitoring_internal();
    // Also reset any stuck recording state that might interfere
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        log::warn!("Recording state was stuck during monitor start, resetting...");
        reset_recording_state();
    }
    std::thread::sleep(std::time::Duration::from_millis(50));

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
    log::info!("Starting monitoring on device: {}", device_name);

    // Get supported config
    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    MONITORING_ACTIVE.store(true, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);

    // Build stream based on sample format
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_monitor_stream::<f32>(&device, &config.into())?,
        SampleFormat::I16 => build_monitor_stream::<i16>(&device, &config.into())?,
        SampleFormat::U16 => build_monitor_stream::<u16>(&device, &config.into())?,
        SampleFormat::I32 => build_monitor_stream::<i32>(&device, &config.into())?,
        SampleFormat::U8 => build_monitor_stream::<u8>(&device, &config.into())?,
        fmt => return Err(format!("Unsupported sample format: {:?}", fmt)),
    };

    stream.play().map_err(|e| format!("Failed to start monitor stream: {}", e))?;

    // Store stream properly (dropped on stop to release OS audio resources)
    if let Ok(mut guard) = MONITOR_STREAM.lock() {
        *guard = Some(StreamHolder::new(stream));
    }

    Ok(())
}

fn build_monitor_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::error!("Monitor error: {}", err);
        // Don't panic on stream errors, just log them
    };

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !MONITORING_ACTIVE.load(Ordering::SeqCst) {
                    return;
                }

                // Wrap in catch_unwind to prevent ALSA timing panics from crashing
                let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    // Calculate level from samples
                    let mut max_level: f32 = 0.0;
                    for s in data.iter() {
                        let f = f32::from_sample(*s);
                        max_level = max_level.max(f.abs());
                    }

                    // Update level (convert to 0-1000 range for AtomicU32)
                    let level_int = (max_level * 1000.0) as u32;
                    CURRENT_LEVEL.store(level_int, Ordering::SeqCst);
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

fn stop_monitoring_internal() {
    MONITORING_ACTIVE.store(false, Ordering::SeqCst);
    // Drop the cpal stream to release OS audio resources
    if let Ok(mut guard) = MONITOR_STREAM.lock() {
        *guard = None;
    }
    CURRENT_LEVEL.store(0, Ordering::SeqCst);
}

/// Stop monitoring a device
#[tauri::command]
pub fn stop_monitoring() {
    log::info!("Stopping monitoring");
    stop_monitoring_internal();
}

/// Check if monitoring is active
#[tauri::command]
pub fn is_monitoring() -> bool {
    MONITORING_ACTIVE.load(Ordering::SeqCst)
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
/// accumulation (when RECORDING_ACTIVE is true), so a single process
/// serves both monitoring and recording.
#[cfg(target_os = "linux")]
fn start_system_audio_monitoring_impl() -> Result<(), String> {
    // Stop any existing monitoring first
    stop_system_audio_monitoring_internal();
    kill_all_stale_processes();

    let monitor_source = get_default_monitor_source()?;
    log::info!("Starting system audio monitoring with monitor source: {}", monitor_source);

    // Append .monitor for PulseAudio API if not already present
    let pa_monitor = if monitor_source.ends_with(".monitor") {
        monitor_source.clone()
    } else {
        format!("{}.monitor", monitor_source)
    };

    // Try parec first (most reliable), fall back to pw-record
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

    // Store the Child properly for cleanup (not mem::forget)
    *SYSTEM_MONITOR_CHILD.lock().unwrap() = Some(child);
    SYSTEM_MONITOR_ACTIVE.store(true, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);

    // Spawn reader thread: updates level meter always, accumulates samples when recording
    std::thread::spawn(move || {
        system_audio_monitor_reader(stdout);
    });

    log::info!("System audio monitoring started");
    Ok(())
}

/// Start system audio monitoring (level meter only, no recording)
/// Uses parec or pw-record to capture system audio and update CURRENT_LEVEL
#[tauri::command]
pub async fn start_system_audio_monitoring() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        stop_monitoring_internal();
        start_system_audio_monitoring_impl()
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("System audio monitoring only supported on Linux".to_string())
    }
}

/// Stop system audio monitoring
#[tauri::command]
pub fn stop_system_audio_monitoring() {
    log::info!("Stopping system audio monitoring");
    stop_system_audio_monitoring_internal();
}

fn stop_system_audio_monitoring_internal() {
    SYSTEM_MONITOR_ACTIVE.store(false, Ordering::SeqCst);

    if let Ok(mut guard) = SYSTEM_MONITOR_CHILD.lock() {
        if let Some(ref mut child) = *guard {
            log::info!("Killing system audio capture process (pid {})", child.id());
            let _ = child.kill();     // Send SIGKILL
            let _ = child.wait();     // Reap zombie
        }
        *guard = None;
    }

    CURRENT_LEVEL.store(0, Ordering::SeqCst);
}

/// Unified stream reader for system audio: handles both monitoring and recording.
/// Always updates the level meter. When RECORDING_ACTIVE is true, also accumulates
/// samples for the WAV file and feeds the transcription buffer.
#[cfg(target_os = "linux")]
fn system_audio_monitor_reader(stdout: ChildStdout) {
    let mut reader = BufReader::with_capacity(8192, stdout);
    let mut buffer = [0u8; 8192];

    while SYSTEM_MONITOR_ACTIVE.load(Ordering::SeqCst) {
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
                CURRENT_LEVEL.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                // When recording is active, write to disk and count samples
                if RECORDING_ACTIVE.load(Ordering::SeqCst) {
                    SYSTEM_AUDIO_SAMPLE_COUNT.fetch_add(samples.len(), Ordering::SeqCst);
                    let sample_bytes = samples.len() * 4;

                    if let Ok(mut writer_guard) = SYSTEM_WAV_WRITER.lock() {
                        // Check if segment split is needed
                        let current_data_bytes = SYSTEM_SEGMENT_DATA_BYTES.load(Ordering::Relaxed);
                        if current_data_bytes + sample_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
                            // Finalize current segment, patch header, create new one
                            if let Some(old_writer) = writer_guard.take() {
                                let _ = old_writer.finalize();
                                let seg_idx = SYSTEM_SEGMENT_INDEX.load(Ordering::Relaxed);
                                if let Ok(base_guard) = SYSTEM_SEGMENT_BASE_PATH.lock() {
                                    if let Some(ref base) = *base_guard {
                                        let current_seg = segment_path(base, seg_idx);
                                        let _ = patch_wav_header_if_needed(&current_seg);
                                        if let Ok(mut completed) = SYSTEM_COMPLETED_SEGMENTS.lock() {
                                            completed.push(current_seg);
                                        }

                                        let new_idx = seg_idx + 1;
                                        SYSTEM_SEGMENT_INDEX.store(new_idx, Ordering::Relaxed);
                                        SYSTEM_SEGMENT_DATA_BYTES.store(0, Ordering::Relaxed);

                                        let new_path = segment_path(base, new_idx);
                                        let sys_spec = WavSpec {
                                            channels: 2,
                                            sample_rate: 44100,
                                            bits_per_sample: 32,
                                            sample_format: hound::SampleFormat::Float,
                                        };
                                        if let Ok(f) = File::create(&new_path) {
                                            if let Ok(new_writer) = WavWriter::new(BufWriter::new(f), sys_spec) {
                                                *writer_guard = Some(new_writer);
                                                log::info!("System audio: started new segment {:?}", new_path);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Write samples to current segment
                        SYSTEM_SEGMENT_DATA_BYTES.fetch_add(sample_bytes, Ordering::Relaxed);
                        if let Some(ref mut writer) = *writer_guard {
                            for &sample in &samples {
                                let _ = writer.write_sample(sample);
                            }
                        }
                    }

                    DEBUG_CALLBACK_COUNT.fetch_add(1, Ordering::SeqCst);
                }
            }
            Err(_) => break,
        }
    }

    // Signal that monitoring has stopped (reader died or EOF)
    SYSTEM_MONITOR_ACTIVE.store(false, Ordering::SeqCst);
    log::info!("System audio monitor reader finished");
}

/// Force reset recording state (for recovery from stuck state)
#[tauri::command]
pub fn reset_recording_state() {
    log::info!("Force resetting recording state");
    RECORDING_ACTIVE.store(false, Ordering::SeqCst);
    MONITORING_ACTIVE.store(false, Ordering::SeqCst);
    CURRENT_LEVEL.store(0, Ordering::SeqCst);
    // Drop any held cpal streams
    if let Ok(mut guard) = RECORDING_STREAM.lock() { *guard = None; }
    if let Ok(mut guard) = MONITOR_STREAM.lock() { *guard = None; }
    if let Ok(mut state) = RECORDING_STATE.lock() {
        if let Some(s) = state.take() {
            // Stop ring buffer and join writer thread
            if let Some(ring) = &s.ring_buffer {
                ring.active.store(false, Ordering::Release);
            }
            if let Some(handle) = s.writer_handle {
                let _ = handle.join();
            }
        }
    }
    // Clean up system audio segment statics
    SYSTEM_SEGMENT_DATA_BYTES.store(0, Ordering::Relaxed);
    SYSTEM_SEGMENT_INDEX.store(1, Ordering::Relaxed);
    if let Ok(mut base) = SYSTEM_SEGMENT_BASE_PATH.lock() { *base = None; }
    if let Ok(mut completed) = SYSTEM_COMPLETED_SEGMENTS.lock() { completed.clear(); }
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
/// The monitor reader thread accumulates samples when RECORDING_ACTIVE is set.
#[tauri::command]
pub async fn start_system_audio_recording(output_dir: String, channel_mode: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        // Auto-reset any stuck state from previous failed recordings
        if RECORDING_ACTIVE.load(Ordering::SeqCst) {
            log::warn!("Recording state was stuck, auto-resetting...");
            reset_recording_state();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Ensure system audio monitoring is running (reuse existing pw-record process).
        // The monitor reader thread handles both level metering and sample accumulation.
        if !SYSTEM_MONITOR_ACTIVE.load(Ordering::SeqCst) {
            log::info!("Starting system audio monitoring for recording...");
            start_system_audio_monitoring_impl()?;
        } else {
            log::info!("System audio monitoring already active, reusing for recording");
        }

        // Ensure output directory exists
        let output_dir_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_dir_path)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", output_dir_path, e))?;

        // Generate output filename
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let filename = format!("recording_{}.wav", timestamp);
        let output_path = output_dir_path.join(&filename);

        log::info!("Starting system audio recording to: {:?}", output_path);

        // Reset sample counter and segment tracking
        SYSTEM_AUDIO_SAMPLE_COUNT.store(0, Ordering::SeqCst);
        SYSTEM_SEGMENT_DATA_BYTES.store(0, Ordering::Relaxed);
        SYSTEM_SEGMENT_INDEX.store(1, Ordering::Relaxed);
        if let Ok(mut base) = SYSTEM_SEGMENT_BASE_PATH.lock() {
            *base = Some(output_path.clone());
        }
        if let Ok(mut completed) = SYSTEM_COMPLETED_SEGMENTS.lock() {
            completed.clear();
        }

        let target_mono = channel_mode.as_deref() == Some("mono");

        // Create WAV writer for incremental crash-safe recording
        let sys_spec = WavSpec {
            channels: 2,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let sys_file = File::create(&output_path)
            .map_err(|e| format!("Failed to create output file: {}", e))?;
        let sys_buf = BufWriter::new(sys_file);
        let sys_wav_writer = WavWriter::new(sys_buf, sys_spec)
            .map_err(|e| format!("Failed to create WAV writer: {}", e))?;

        {
            let mut wg = SYSTEM_WAV_WRITER.lock().unwrap();
            *wg = Some(sys_wav_writer);
        }

        // Store recording state
        {
            let mut state = RECORDING_STATE.lock().unwrap();
            *state = Some(RecordingState {
                sample_count: 0,
                sample_rate: 44100,
                channels: 2,
                output_path: output_path.clone(),
                use_system_buffer: true,
                target_mono,
                ring_buffer: None,
                writer_handle: None,
            });
        }

        // Activate recording — the monitor reader thread will start accumulating samples
        RECORDING_ACTIVE.store(true, Ordering::SeqCst);
        DEBUG_CALLBACK_COUNT.store(0, Ordering::SeqCst);

        log::info!("System audio recording active (reusing monitor process)");
        Ok(output_path.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
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
pub async fn stop_system_audio_recording() -> Result<RecordingResult, String> {
    #[cfg(target_os = "linux")]
    {
        if !RECORDING_ACTIVE.load(Ordering::SeqCst) {
            return Err("No recording in progress".to_string());
        }

        log::info!("Stopping system audio recording...");

        // Signal recording stop — monitor reader stops accumulating but continues level metering
        RECORDING_ACTIVE.store(false, Ordering::SeqCst);

        // Brief pause to let the reader finish any in-flight data
        std::thread::sleep(std::time::Duration::from_millis(100));

        // NOTE: Don't kill the pw-record process — monitoring continues.
        // The process will be killed when the user stops monitoring or leaves the screen.

        // Get recording state
        let state = {
            let mut state_guard = RECORDING_STATE.lock().unwrap();
            state_guard.take()
        };
        let state = state.ok_or("Recording state not found")?;

        // Get sample count
        let sample_count = SYSTEM_AUDIO_SAMPLE_COUNT.load(Ordering::SeqCst);

        log::info!("Recorded {} samples to WAV file: {:?}", sample_count, state.output_path);

        if sample_count == 0 {
            // Clean up the writer even if no samples
            if let Ok(mut wg) = SYSTEM_WAV_WRITER.lock() {
                drop(wg.take());
            }
            return Err("No audio recorded".to_string());
        }

        // Compute duration from sample count
        let duration = sample_count as f64 / state.channels as f64 / state.sample_rate as f64;

        // Finalize the WAV writer
        if let Ok(mut wg) = SYSTEM_WAV_WRITER.lock() {
            if let Some(writer) = wg.take() {
                writer.finalize()
                    .map_err(|e| format!("Failed to finalize WAV: {}", e))?;
            }
        }

        // Patch header of the last segment (safety net for hound u32 overflow)
        let seg_idx = SYSTEM_SEGMENT_INDEX.load(Ordering::Relaxed);
        let last_seg_path = segment_path(&state.output_path, seg_idx);
        let _ = patch_wav_header_if_needed(&last_seg_path);

        // Concatenate segments if auto-split occurred
        let completed = if let Ok(mut guard) = SYSTEM_COMPLETED_SEGMENTS.lock() {
            guard.drain(..).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if !completed.is_empty() {
            let mut all_segments = completed;
            all_segments.push(last_seg_path);
            concatenate_wav_segments(&all_segments)?;
        }

        // Convert to mono if needed
        let final_channels = if state.target_mono && state.channels == 2 {
            stereo_wav_to_mono_streaming(&state.output_path, state.sample_rate)?;
            1u16
        } else {
            state.channels
        };

        log::info!("System audio recording complete: {:?}, {:.2}s, {} callbacks",
            state.output_path, duration, DEBUG_CALLBACK_COUNT.load(Ordering::SeqCst));

        // Don't reset CURRENT_LEVEL — monitoring is still running and will keep updating it

        Ok(RecordingResult {
            path: state.output_path.to_string_lossy().to_string(),
            duration,
            sample_rate: state.sample_rate,
            channels: final_channels,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
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

    std::thread::sleep(Duration::from_millis(100));
    drop(stream);

    got_callback.load(Ordering::SeqCst)
}

#[cfg(target_os = "linux")]
fn test_parec(monitor_source: &str) -> Result<String, String> {
    let output = std::process::Command::new("timeout")
        .args(["0.5", "parec", "-d", monitor_source,
               "--format=float32le", "--rate=44100", "--channels=2"])
        .output()
        .map_err(|e| format!("Failed to run parec: {}", e))?;

    if output.stdout.len() > 1000 {
        Ok(format!("Test captured {} bytes", output.stdout.len()))
    } else {
        Err(format!("Captured too little data: {} bytes (stderr: {})",
            output.stdout.len(), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(target_os = "linux")]
fn test_pw_record(sink_name: &str) -> Result<String, String> {
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test.wav");

    // Record for 0.5 seconds
    let _output = std::process::Command::new("timeout")
        .args(["0.5", "pw-record", "--target", sink_name,
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

        if size > 1000 {  // File has some content
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}

#[cfg(target_os = "linux")]
fn test_parecord(monitor_source: &str) -> Result<String, String> {
    let temp_file = std::env::temp_dir().join("clip_dr_sys_test_pa.wav");

    // Record for 0.5 seconds
    let _output = std::process::Command::new("timeout")
        .args(["0.5", "parecord", "-d", monitor_source,
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

        if size > 1000 {
            return Ok(format!("Test recorded {} bytes", size));
        } else {
            return Err("Test file too small".to_string());
        }
    }

    Err("Test file not created".to_string())
}
