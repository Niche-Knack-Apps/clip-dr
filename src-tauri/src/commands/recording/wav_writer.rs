use hound::{WavSpec, WavWriter};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::audio_util::{AudioWriter, WAV_SEGMENT_MAX_DATA_BYTES};
use super::ring_buffer::RecordingRingBuffer;

/// Compute a segment file path from a base path and segment index.
/// Segment 1 uses the base path unchanged; segment 2+ appends `_002`, `_003`, etc.
pub fn segment_path(base: &Path, index: usize) -> PathBuf {
    if index <= 1 {
        base.to_path_buf()
    } else {
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let ext = base.extension().unwrap_or_default().to_string_lossy();
        base.with_file_name(format!("{}_{:03}.{}", stem, index, ext))
    }
}

/// Spawn a dedicated writer thread that drains the ring buffer to an AudioWriter.
/// Returns a JoinHandle that yields (AudioWriter, total_sample_count, completed_segments, write_error_count) on join.
/// Supports automatic WAV segment splitting (split-tracks mode) or RF64 single-file mode.
pub fn spawn_wav_writer_thread(
    ring: Arc<RecordingRingBuffer>,
    audio_writer: AudioWriter,
    channels: u16,
    _target_mono: bool,
    base_path: PathBuf,
    wav_spec: WavSpec,
    use_rf64: bool,
) -> Result<JoinHandle<(AudioWriter, usize, Vec<PathBuf>, u32)>, String> {
    std::thread::Builder::new()
        .name("wav-writer".into())
        .spawn(move || {
            let mut writer = audio_writer;
            let mut total_written: usize = 0;
            let mut bad_channel_checked = false;
            let mut segment_data_bytes: usize = 0;
            let mut segment_index: usize = 1;
            let mut completed_segments: Vec<PathBuf> = Vec::new();
            let mut write_error_count: u32 = 0;
            let mut consecutive_errors: u32 = 0;
            const MAX_CONSECUTIVE_ERRORS: u32 = 100;

            'drain: loop {
                let wp = ring.write_pos.load(std::sync::atomic::Ordering::Acquire);
                let rp = ring.read_pos.load(std::sync::atomic::Ordering::Relaxed);
                let available = wp.wrapping_sub(rp);

                if available == 0 {
                    if !ring.active.load(std::sync::atomic::Ordering::Acquire) {
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
                        let idx0 = (rp + i * 2) & ring.mask;
                        let idx1 = (rp + i * 2 + 1) & ring.mask;
                        let s0 = unsafe { *ring.data_ptr.add(idx0) };
                        let s1 = unsafe { *ring.data_ptr.add(idx1) };
                        if s0.abs() >= 0.999 { ch0_clipped += 1; }
                        if s1.abs() >= 0.999 { ch1_clipped += 1; }
                    }
                    if ch0_clipped >= check_pairs * 8 / 10 && ch1_clipped < check_pairs * 3 / 10 {
                        log::info!("Detected bad channel 0, duplicating channel 1");
                        ring.bad_channel.store(1, std::sync::atomic::Ordering::Release);
                    } else if ch1_clipped >= check_pairs * 8 / 10 && ch0_clipped < check_pairs * 3 / 10 {
                        log::info!("Detected bad channel 1, duplicating channel 0");
                        ring.bad_channel.store(2, std::sync::atomic::Ordering::Release);
                    }
                }

                let bad_ch = ring.bad_channel.load(std::sync::atomic::Ordering::Relaxed);

                // Calculate how many samples we'll write and their byte count
                let samples_to_write = if channels == 2 && bad_ch > 0 {
                    (available / 2) * 2
                } else {
                    available
                };
                let write_bytes = samples_to_write * 4;

                // Check if segment split is needed (only in split-tracks mode, not RF64)
                if !use_rf64 && segment_data_bytes + write_bytes > WAV_SEGMENT_MAX_DATA_BYTES {
                    let next_index = segment_index + 1;
                    let new_path = segment_path(&base_path, next_index);
                    // Create the new writer BEFORE finalizing the old one — finalize() takes ownership
                    let new_writer_result = File::create(&new_path)
                        .map_err(|e| format!("create: {}", e))
                        .and_then(|f| WavWriter::new(BufWriter::new(f), wav_spec)
                            .map_err(|e| format!("init: {}", e)));
                    match new_writer_result {
                        Ok(new_w) => {
                            let current_seg = segment_path(&base_path, segment_index);
                            match writer.finalize() {
                                Ok(()) => {
                                    let _ = patch_wav_header_if_needed(&current_seg);
                                    completed_segments.push(current_seg);
                                }
                                Err(e) => log::error!("Failed to finalize segment: {}", e),
                            }
                            segment_index = next_index;
                            segment_data_bytes = 0;
                            writer = AudioWriter::Hound(new_w);
                            log::info!("Mic recording: started new segment {:?}", new_path);
                        }
                        Err(e) => {
                            // Keep writing to current segment — do not finalize/move writer
                            log::error!("[WAVWriter] Segment switch failed: {} — continuing in current segment", e);
                        }
                    }
                }

                // Drain available samples to writer
                let new_rp;
                if channels == 2 && bad_ch > 0 {
                    // Write with bad-channel fixup (replace bad channel with good one)
                    let pairs = available / 2;
                    for i in 0..pairs {
                        let idx0 = (rp + i * 2) & ring.mask;
                        let idx1 = (rp + i * 2 + 1) & ring.mask;
                        let s0 = unsafe { *ring.data_ptr.add(idx0) };
                        let s1 = unsafe { *ring.data_ptr.add(idx1) };
                        if bad_ch == 1 {
                            match writer.write_sample(s1) {
                                Ok(_) => { consecutive_errors = 0; }
                                Err(e) => {
                                    write_error_count += 1; consecutive_errors += 1;
                                    if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                                        log::error!("[WAVWriter] {} consecutive failures — stopping drain.", consecutive_errors);
                                        break 'drain;
                                    }
                                }
                            }
                            match writer.write_sample(s1) {
                                Ok(_) => { consecutive_errors = 0; }
                                Err(e) => {
                                    write_error_count += 1; consecutive_errors += 1;
                                    if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                                        log::error!("[WAVWriter] {} consecutive failures — stopping drain.", consecutive_errors);
                                        break 'drain;
                                    }
                                }
                            }
                        } else {
                            match writer.write_sample(s0) {
                                Ok(_) => { consecutive_errors = 0; }
                                Err(e) => {
                                    write_error_count += 1; consecutive_errors += 1;
                                    if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                                        log::error!("[WAVWriter] {} consecutive failures — stopping drain.", consecutive_errors);
                                        break 'drain;
                                    }
                                }
                            }
                            match writer.write_sample(s0) {
                                Ok(_) => { consecutive_errors = 0; }
                                Err(e) => {
                                    write_error_count += 1; consecutive_errors += 1;
                                    if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                                        log::error!("[WAVWriter] {} consecutive failures — stopping drain.", consecutive_errors);
                                        break 'drain;
                                    }
                                }
                            }
                        }
                    }
                    let consumed = pairs * 2;
                    new_rp = rp + consumed;
                    ring.read_pos.store(new_rp, std::sync::atomic::Ordering::Release);
                    total_written += consumed;
                    segment_data_bytes += consumed * 4;
                } else {
                    // Normal path: write all samples directly
                    for i in 0..available {
                        let idx = (rp + i) & ring.mask;
                        let sample = unsafe { *ring.data_ptr.add(idx) };
                        match writer.write_sample(sample) {
                            Ok(_) => { consecutive_errors = 0; }
                            Err(e) => {
                                write_error_count += 1; consecutive_errors += 1;
                                if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                                    log::error!("[WAVWriter] {} consecutive failures — stopping drain.", consecutive_errors);
                                    break 'drain;
                                }
                            }
                        }
                    }
                    new_rp = rp + available;
                    ring.read_pos.store(new_rp, std::sync::atomic::Ordering::Release);
                    total_written += available;
                    segment_data_bytes += available * 4;
                }

                // Adaptive sleep: if buffer pressure is high, drain again immediately
                let post_drain_fill = ring.write_pos.load(std::sync::atomic::Ordering::Acquire).wrapping_sub(new_rp);
                let low_water = ring.capacity / 4; // 25% = comfortable
                if post_drain_fill > low_water {
                    continue; // Skip sleep, drain more
                }
                std::thread::sleep(Duration::from_millis(5));
            }

            // Final drain after active=false (in case more samples arrived)
            let wp = ring.write_pos.load(std::sync::atomic::Ordering::Acquire);
            let rp = ring.read_pos.load(std::sync::atomic::Ordering::Relaxed);
            let remaining = wp.wrapping_sub(rp);
            for i in 0..remaining {
                let idx = (rp + i) & ring.mask;
                let sample = unsafe { *ring.data_ptr.add(idx) };
                match writer.write_sample(sample) {
                    Ok(_) => { consecutive_errors = 0; }
                    Err(e) => {
                        write_error_count += 1; consecutive_errors += 1;
                        if write_error_count == 1 { log::error!("[WAVWriter] Write error: {}. File may be truncated.", e); }
                        if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                            log::error!("[WAVWriter] {} consecutive failures — stopping final drain.", consecutive_errors);
                            break;
                        }
                    }
                }
            }
            total_written += remaining;

            // Log telemetry
            let overruns = ring.overrun_count.load(std::sync::atomic::Ordering::Relaxed);
            let max_fill = ring.max_fill_level.load(std::sync::atomic::Ordering::Relaxed);
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

            (writer, total_written, completed_segments, write_error_count)
        })
        .map_err(|e| format!("Failed to spawn wav-writer thread: {}", e))
}

/// Streaming stereo-to-mono WAV conversion (file-to-file, constant memory)
pub fn stereo_wav_to_mono_streaming(path: &std::path::Path, sample_rate: u32) -> Result<(), String> {
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
pub fn patch_wav_header_if_needed(path: &Path) -> Result<(), String> {
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

    let data_offset = crate::commands::playback::find_wav_data_offset(&header)
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

/// Check if a WAV file's header has a valid data size.
pub fn check_wav_header_valid(path: &Path) -> bool {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    let mut reader = BufReader::new(file);
    let mut header = [0u8; 80];
    if reader.read_exact(&mut header).is_err() {
        return false;
    }

    let magic = &header[0..4];
    if magic != b"RIFF" && magic != b"RF64" {
        return false;
    }

    // For RF64, header is always valid (sizes stored in ds64)
    if magic == b"RF64" {
        return true;
    }

    // For RIFF: check if the data chunk size is 0 (truncated) or plausible
    if header.len() >= 80 && &header[76..80] == &[0, 0, 0, 0] {
        // data_size is 0 — header was never patched
        return false;
    }

    true
}

/// Estimate WAV duration from file header.
pub fn estimate_wav_duration(path: &Path) -> Result<f64, String> {
    let (sample_rate, channels) = read_wav_format(path)?;
    let file_len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let data_bytes = file_len.saturating_sub(80);
    // Assuming f32 format: 4 bytes per sample
    let total_samples = data_bytes / 4;
    let samples_per_channel = total_samples / channels as u64;
    Ok(samples_per_channel as f64 / sample_rate as f64)
}

/// Read sample rate and channels from a WAV file header.
pub fn read_wav_format(path: &Path) -> Result<(u32, u16), String> {
    let file = File::open(path).map_err(|e| format!("Failed to open: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut header = [0u8; 80];
    reader.read_exact(&mut header).map_err(|e| format!("Failed to read header: {}", e))?;

    // Find fmt chunk — for our layout it's at offset 48 (or 12 for standard WAV)
    let fmt_offset = if &header[48..52] == b"fmt " {
        48
    } else if &header[12..16] == b"fmt " {
        12
    } else {
        return Err("fmt chunk not found".to_string());
    };

    let channels = u16::from_le_bytes([header[fmt_offset + 10], header[fmt_offset + 11]]);
    let sample_rate = u32::from_le_bytes([
        header[fmt_offset + 12], header[fmt_offset + 13],
        header[fmt_offset + 14], header[fmt_offset + 15],
    ]);

    Ok((sample_rate, channels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// REC-H3 regression: spawn_wav_writer_thread must return Result, not panic.
    #[test]
    fn spawn_writer_returns_result() {
        let ring = Arc::new(RecordingRingBuffer::new(4096));
        let dir = tempfile::tempdir().unwrap();
        let out_path = dir.path().join("test.wav");

        let spec = WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let file = File::create(&out_path).unwrap();
        let writer = AudioWriter::Hound(
            WavWriter::new(BufWriter::new(file), spec).unwrap()
        );

        // Signal immediate stop so the thread drains and exits
        ring.active.store(false, Ordering::Release);

        let result = spawn_wav_writer_thread(
            ring, writer, 1, false, out_path, spec, false,
        );
        assert!(result.is_ok(), "spawn_wav_writer_thread must return Ok");

        let handle = result.unwrap();
        let (_writer, total, _segs, errors) = handle.join().unwrap();
        assert_eq!(total, 0);
        assert_eq!(errors, 0);
    }

    /// REC-H3 regression: writer thread drains samples written to ring buffer.
    #[test]
    fn writer_drains_ring_buffer_samples() {
        let ring = Arc::new(RecordingRingBuffer::new(8192));
        let dir = tempfile::tempdir().unwrap();
        let out_path = dir.path().join("drain_test.wav");

        let spec = WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let file = File::create(&out_path).unwrap();
        let writer = AudioWriter::Hound(
            WavWriter::new(BufWriter::new(file), spec).unwrap()
        );

        // Write 100 samples into the ring buffer before spawning
        let sample_count = 100usize;
        for i in 0..sample_count {
            unsafe {
                *ring.data_ptr.add(i & ring.mask) = (i as f32) / 1000.0;
            }
        }
        ring.write_pos.store(sample_count, Ordering::Release);

        let handle = spawn_wav_writer_thread(
            ring.clone(), writer, 1, false, out_path.clone(), spec, false,
        ).expect("spawn must succeed");

        // Give the writer time to drain, then signal stop
        std::thread::sleep(Duration::from_millis(100));
        ring.active.store(false, Ordering::Release);

        let (_writer, total, _segs, errors) = handle.join().unwrap();
        assert_eq!(total, sample_count, "all samples must be drained");
        assert_eq!(errors, 0, "no write errors expected");
        assert!(out_path.exists(), "WAV file must exist on disk");
    }

    #[test]
    fn segment_path_first_is_base() {
        let base = PathBuf::from("/tmp/rec.wav");
        assert_eq!(segment_path(&base, 1), base);
    }

    #[test]
    fn segment_path_second_has_suffix() {
        let base = PathBuf::from("/tmp/rec.wav");
        let p2 = segment_path(&base, 2);
        assert_eq!(p2, PathBuf::from("/tmp/rec_002.wav"));
    }

    /// REC-H1 regression: ring buffer capacity is always power-of-two.
    #[test]
    fn ring_buffer_capacity_is_power_of_two() {
        // Non-power-of-two input should be rounded up
        let ring = RecordingRingBuffer::new(5000);
        assert!(ring.capacity.is_power_of_two(), "capacity must be power of two");
        assert!(ring.capacity >= 5000, "capacity must be >= requested");
        assert_eq!(ring.capacity, 8192); // next power of two above 5000
        assert_eq!(ring.mask, 8191);

        // Already power-of-two input should stay the same
        let ring2 = RecordingRingBuffer::new(4096);
        assert_eq!(ring2.capacity, 4096);
        assert_eq!(ring2.mask, 4095);
    }

    /// REC-H1 regression: bitwise mask indexing works correctly for wrap-around.
    #[test]
    fn ring_buffer_mask_wraps_correctly() {
        let ring = Arc::new(RecordingRingBuffer::new(16)); // will stay 16 (already power-of-two)
        assert_eq!(ring.capacity, 16);

        // Write at position 15 (last slot) and 16 (should wrap to 0)
        unsafe {
            *ring.data_ptr.add(15 & ring.mask) = 1.0;
            *ring.data_ptr.add(16 & ring.mask) = 2.0; // wraps to index 0
        }
        unsafe {
            assert_eq!(*ring.data_ptr.add(15), 1.0);
            assert_eq!(*ring.data_ptr.add(0), 2.0);
        }
    }
}
