use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// ── Lock-free ring buffer for realtime-safe recording ──

/// SPSC ring buffer: audio callback (producer) writes samples lock-free,
/// dedicated writer thread (consumer) drains to disk.
pub struct RecordingRingBuffer {
    #[allow(dead_code)] // Keeps allocation alive; data_ptr points into it
    data: Box<[f32]>,
    pub data_ptr: *mut f32,
    pub capacity: usize,
    /// Total samples written by producer (monotonically increasing)
    pub write_pos: AtomicUsize,
    /// Total samples read by consumer (monotonically increasing)
    pub read_pos: AtomicUsize,
    /// False = writer thread should drain remaining samples and exit
    pub active: AtomicBool,
    /// Number of input channels (for bad-channel detection)
    pub channels: u16,
    /// Bad channel detected: 0=none, 1=ch0 bad, 2=ch1 bad
    pub bad_channel: AtomicUsize,
    /// Number of times the audio callback dropped a batch due to full buffer
    pub overrun_count: AtomicUsize,
    /// High-water mark of ring buffer usage (samples)
    pub max_fill_level: AtomicUsize,
}

unsafe impl Send for RecordingRingBuffer {}
unsafe impl Sync for RecordingRingBuffer {}

impl RecordingRingBuffer {
    pub fn new(capacity: usize) -> Self {
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

    pub fn with_channels(mut self, channels: u16) -> Self {
        self.channels = channels;
        self
    }
}

// ── Pre-record circular buffer ──
// Lock-free circular buffer filled during monitoring, drained into the WAV
// writer when recording starts. Default capacity: 10 seconds of stereo 48kHz.

/// Pre-record buffer: stores the last N seconds of audio from monitoring.
/// Written to by the monitor callback, read by start_recording to prepend audio.
pub struct PreRecordBuffer {
    data: Box<[f32]>,
    data_ptr: *mut f32,
    capacity: usize,
    /// Total samples written (monotonically increasing, wraps modulo capacity)
    write_pos: AtomicUsize,
    /// Number of valid samples (min(write_pos, capacity))
    valid_samples: AtomicUsize,
    /// Sample rate of the stored audio
    pub sample_rate: u32,
    /// Number of channels
    pub channels: u16,
}

unsafe impl Send for PreRecordBuffer {}
unsafe impl Sync for PreRecordBuffer {}

impl PreRecordBuffer {
    pub fn new(capacity: usize, sample_rate: u32, channels: u16) -> Self {
        let mut data = vec![0.0f32; capacity].into_boxed_slice();
        let data_ptr = data.as_mut_ptr();
        Self {
            data,
            data_ptr,
            capacity,
            write_pos: AtomicUsize::new(0),
            valid_samples: AtomicUsize::new(0),
            sample_rate,
            channels,
        }
    }

    /// Write samples from the audio callback (lock-free, overwrites oldest data).
    pub fn write(&self, samples: &[f32]) {
        let wp = self.write_pos.load(Ordering::Relaxed);
        for (i, &s) in samples.iter().enumerate() {
            let idx = (wp + i) % self.capacity;
            unsafe { *self.data_ptr.add(idx) = s; }
        }
        self.write_pos.store(wp + samples.len(), Ordering::Release);
        let valid = (wp + samples.len()).min(self.capacity);
        let _ = self.valid_samples.fetch_max(valid, Ordering::Relaxed);
    }

    /// Drain all valid samples in chronological order.
    /// Returns (samples, seconds_of_audio).
    pub fn drain(&self) -> (Vec<f32>, f64) {
        let wp = self.write_pos.load(Ordering::Acquire);
        let valid = self.valid_samples.load(Ordering::Relaxed).min(self.capacity);
        if valid == 0 {
            return (Vec::new(), 0.0);
        }

        let mut out = Vec::with_capacity(valid);
        let start = if wp >= valid { wp - valid } else { 0 };
        for i in 0..valid {
            let idx = (start + i) % self.capacity;
            out.push(unsafe { *self.data_ptr.add(idx) });
        }

        let seconds = valid as f64 / (self.sample_rate as f64 * self.channels as f64);
        (out, seconds)
    }

    /// Reset the buffer (call after draining).
    #[allow(dead_code)]
    pub fn reset(&self) {
        self.write_pos.store(0, Ordering::Release);
        self.valid_samples.store(0, Ordering::Release);
    }
}

/// Default pre-record buffer duration in seconds.
pub const PRE_RECORD_SECONDS: usize = 10;
