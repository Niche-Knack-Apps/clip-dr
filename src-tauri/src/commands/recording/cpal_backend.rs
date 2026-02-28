use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use std::panic;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use super::backend::{
    AudioBackend, AudioSink, BackendKind, DeviceKey, InputHandle, NegotiatedConfig,
    StreamConfigRequest,
};
use super::error::AudioError;
use super::ring_buffer::RecordingRingBuffer;
use super::types::AudioDevice;

// ── StreamHolder ──

/// Wrapper to make cpal::Stream storable in a Mutex (it's !Send but we only
/// access from the main thread during setup/teardown).
/// Includes thread affinity guard: logs a warning if dropped on a different thread.
pub(crate) struct StreamHolder {
    pub stream: cpal::Stream,
    creator_thread: std::thread::ThreadId,
}
unsafe impl Send for StreamHolder {}

impl StreamHolder {
    pub fn new(stream: cpal::Stream) -> Self {
        Self {
            stream,
            creator_thread: std::thread::current().id(),
        }
    }
}

impl Drop for StreamHolder {
    fn drop(&mut self) {
        if std::thread::current().id() != self.creator_thread {
            log::warn!(
                "StreamHolder dropped on different thread than created \
                 (created: {:?}, dropping: {:?})",
                self.creator_thread,
                std::thread::current().id()
            );
        }
    }
}

// ── config_score (ONE copy, deduped from 3) ──

/// Score a cpal supported stream config for how well it matches our preferences.
/// Higher = better.  Prefers stereo, F32, and rates near `target_rate`.
pub fn config_score(cfg: &cpal::SupportedStreamConfigRange, target_rate: u32) -> i32 {
    let mut score = 0;
    if cfg.channels() == 2 {
        score += 100;
    } else if cfg.channels() == 1 {
        score += 50;
    }
    match cfg.sample_format() {
        SampleFormat::F32 => score += 50,
        SampleFormat::I16 => score += 40,
        SampleFormat::I32 => score += 30,
        SampleFormat::F64 => score += 25,
        SampleFormat::U16 => score += 20,
        _ => {}
    }
    let rate_range = cfg.min_sample_rate().0..=cfg.max_sample_rate().0;
    if rate_range.contains(&target_rate) {
        score += 10;
    }
    if rate_range.contains(&44100) {
        score += 5;
    }
    score
}

/// Select the best cpal config from supported configs using `config_score`.
/// Returns the chosen `SupportedStreamConfig` (with concrete sample rate).
pub fn select_best_config(
    supported: &[cpal::SupportedStreamConfigRange],
    default_config: cpal::SupportedStreamConfig,
) -> cpal::SupportedStreamConfig {
    let target_rate = default_config.sample_rate().0;
    let best = supported
        .iter()
        .max_by_key(|cfg| config_score(cfg, target_rate));

    if let Some(best) = best {
        let rate_range = best.min_sample_rate().0..=best.max_sample_rate().0;
        let sample_rate = if rate_range.contains(&target_rate) {
            target_rate
        } else if rate_range.contains(&44100) {
            44100
        } else {
            best.max_sample_rate().0.min(48000)
        };
        let cfg = best
            .clone()
            .with_sample_rate(cpal::SampleRate(sample_rate));
        log::info!(
            "Selected config: {} ch, {:?}, {} Hz (score: {})",
            cfg.channels(),
            cfg.sample_format(),
            sample_rate,
            config_score(best, target_rate)
        );
        cfg
    } else {
        log::info!("Using default config");
        default_config
    }
}

// ── build_input_stream ──

/// Build a cpal input stream that writes interleaved f32 into a ring buffer.
/// Handles sample conversion from any supported format.
pub fn build_input_stream<T: Sample + cpal::SizedSample + Send + 'static>(
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
                        unsafe {
                            *ring.data_ptr.add(idx) = f;
                        }
                        let abs = f.abs();
                        if abs > max_level {
                            max_level = abs;
                        }
                    }
                    ring.write_pos
                        .store(wp + data.len(), Ordering::Release);

                    // Update telemetry: high-water mark of ring usage
                    let _ = ring
                        .max_fill_level
                        .fetch_max(used + data.len(), Ordering::Relaxed);

                    // Update level meters (per-session + shared)
                    let level_int = (max_level * 1000.0) as u32;
                    session_level.store(level_int, Ordering::SeqCst);
                    shared_level.store(level_int, Ordering::SeqCst);

                    // Debug logging every ~1 second
                    let count = debug_count.fetch_add(1, Ordering::SeqCst);
                    if count % 43 == 0 {
                        log::info!(
                            "Recording callback #{}: {} samples, max_level={:.4}, ring used={}/{}",
                            count,
                            data.len(),
                            max_level,
                            used + data.len(),
                            cap
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

/// Build a cpal input stream that dispatches based on sample format.
pub fn build_input_stream_dispatch(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    ring: Arc<RecordingRingBuffer>,
    active: Arc<AtomicBool>,
    session_level: Arc<AtomicU32>,
    shared_level: Arc<AtomicU32>,
    debug_count: Arc<AtomicUsize>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => build_input_stream::<f32>(
            device,
            config,
            ring,
            active,
            session_level,
            shared_level,
            debug_count,
        ),
        SampleFormat::I16 => build_input_stream::<i16>(
            device,
            config,
            ring,
            active,
            session_level,
            shared_level,
            debug_count,
        ),
        SampleFormat::U16 => build_input_stream::<u16>(
            device,
            config,
            ring,
            active,
            session_level,
            shared_level,
            debug_count,
        ),
        SampleFormat::I32 => build_input_stream::<i32>(
            device,
            config,
            ring,
            active,
            session_level,
            shared_level,
            debug_count,
        ),
        SampleFormat::U8 => build_input_stream::<u8>(
            device,
            config,
            ring,
            active,
            session_level,
            shared_level,
            debug_count,
        ),
        fmt => Err(format!("Unsupported sample format: {:?}", fmt)),
    }
}

// ── build_preview_stream ──

/// Build a cpal input stream that only computes level (no ring buffer).
pub fn build_preview_stream<T: Sample + cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
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
                    log::warn!("Preview callback panic caught (ALSA timing issue)");
                }
            },
            |err| log::error!("Preview stream error: {}", err),
            None,
        )
        .map_err(|e| format!("Failed to build preview stream: {}", e))
}

/// Build a preview stream that dispatches based on sample format.
pub fn build_preview_stream_dispatch(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => {
            build_preview_stream::<f32>(device, config, active, level)
        }
        SampleFormat::I16 => {
            build_preview_stream::<i16>(device, config, active, level)
        }
        SampleFormat::U16 => {
            build_preview_stream::<u16>(device, config, active, level)
        }
        SampleFormat::I32 => {
            build_preview_stream::<i32>(device, config, active, level)
        }
        SampleFormat::U8 => {
            build_preview_stream::<u8>(device, config, active, level)
        }
        fmt => Err(format!("Unsupported sample format: {:?}", fmt)),
    }
}

// ── CpalBackend ──

/// Cross-platform audio backend using cpal (ALSA on Linux, CoreAudio on macOS,
/// WASAPI on Windows).
pub struct CpalBackend;

impl AudioBackend for CpalBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Cpal
    }

    fn list_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        let host = cpal::default_host();
        let mut devices = Vec::new();

        let default_input_name = host.default_input_device().and_then(|d| d.name().ok());

        if let Ok(input_devices) = host.input_devices() {
            for device in input_devices {
                if let Ok(name) = device.name() {
                    let name_lower = name.to_lowercase();
                    if name_lower.contains("dmix")
                        || name_lower.contains("surround")
                        || name_lower.contains("iec958")
                        || name_lower.contains("spdif")
                        || name == "null"
                    {
                        continue;
                    }
                    if device.default_input_config().is_err() {
                        continue;
                    }

                    let is_default = default_input_name.as_ref() == Some(&name);
                    let is_loopback = name_lower.contains("monitor")
                        || name_lower.contains("loopback")
                        || name_lower.contains("stereo mix");

                    let (channels, sample_rates) =
                        if let Ok(cfg) = device.default_input_config() {
                            let ch = cfg.channels();
                            let rates = device
                                .supported_input_configs()
                                .map(|cfgs| {
                                    let mut rates: Vec<u32> = cfgs
                                        .flat_map(|c| {
                                            let mut r = vec![c.min_sample_rate().0];
                                            if c.max_sample_rate().0 != c.min_sample_rate().0 {
                                                r.push(c.max_sample_rate().0);
                                            }
                                            r
                                        })
                                        .collect();
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
                        device_source: String::new(),
                        pulse_name: String::new(),
                        pulse_index: 0,
                        hw_bus: String::new(),
                        serial: String::new(),
                    });
                }
            }
        }

        Ok(devices)
    }

    fn open_input(
        &self,
        device_key: &DeviceKey,
        config_req: StreamConfigRequest,
        sink: AudioSink,
    ) -> Result<Box<dyn InputHandle>, AudioError> {
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .map_err(|e| AudioError::BackendUnavailable(format!("Failed to enumerate devices: {}", e)))?
            .find(|d| d.name().ok().as_deref() == Some(&device_key.opaque_id))
            .ok_or_else(|| AudioError::DeviceNotFound(device_key.opaque_id.clone()))?;

        let default_config = device
            .default_input_config()
            .map_err(|e| AudioError::StreamOpenFailed(format!("No input config: {}", e)))?;

        let supported: Vec<_> = device
            .supported_input_configs()
            .map_err(|e| AudioError::StreamOpenFailed(format!("No supported configs: {}", e)))?
            .collect();

        let chosen = select_best_config(&supported, default_config);
        let rate = config_req
            .preferred_rate
            .unwrap_or(chosen.sample_rate().0);
        let channels = config_req
            .preferred_channels
            .unwrap_or(chosen.channels());
        let sample_format = chosen.sample_format();

        // Re-select with preferred rate if possible
        let final_config = if rate != chosen.sample_rate().0 {
            // Try to find a config that supports the preferred rate
            let target = rate;
            if let Some(best) = supported.iter().max_by_key(|c| config_score(c, target)) {
                let rr = best.min_sample_rate().0..=best.max_sample_rate().0;
                if rr.contains(&target) {
                    best.clone().with_sample_rate(cpal::SampleRate(target))
                } else {
                    chosen
                }
            } else {
                chosen
            }
        } else {
            chosen
        };

        let negotiated_rate = final_config.sample_rate().0;
        let negotiated_channels = final_config.channels();
        let stream_config: cpal::StreamConfig = final_config.into();

        let debug_count = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicBool::new(false)); // start() sets to true

        let stream = build_input_stream_dispatch(
            &device,
            &stream_config,
            sample_format,
            sink.ring,
            active.clone(),
            sink.meter,
            sink.shared_meter,
            debug_count,
        )
        .map_err(AudioError::StreamOpenFailed)?;

        Ok(Box::new(CpalInputHandle {
            stream: Some(StreamHolder::new(stream)),
            active,
            config: NegotiatedConfig {
                rate: negotiated_rate,
                channels: negotiated_channels,
            },
        }))
    }

    fn open_preview(
        &self,
        device_key: &DeviceKey,
        level: Arc<AtomicU32>,
    ) -> Result<Box<dyn InputHandle>, AudioError> {
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .map_err(|e| AudioError::BackendUnavailable(format!("Failed to enumerate devices: {}", e)))?
            .find(|d| d.name().ok().as_deref() == Some(&device_key.opaque_id))
            .ok_or_else(|| AudioError::DeviceNotFound(device_key.opaque_id.clone()))?;

        let config = device
            .default_input_config()
            .map_err(|e| AudioError::StreamOpenFailed(format!("No input config: {}", e)))?;

        let sample_format = config.sample_format();
        let rate = config.sample_rate().0;
        let channels = config.channels();
        let stream_config: cpal::StreamConfig = config.into();
        let active = Arc::new(AtomicBool::new(false));

        let stream = build_preview_stream_dispatch(
            &device,
            &stream_config,
            sample_format,
            active.clone(),
            level,
        )
        .map_err(AudioError::StreamOpenFailed)?;

        Ok(Box::new(CpalInputHandle {
            stream: Some(StreamHolder::new(stream)),
            active,
            config: NegotiatedConfig { rate, channels },
        }))
    }
}

// ── CpalInputHandle ──

/// Handle to an active cpal input stream.  Implements InputHandle for
/// lifecycle control and Drop for cleanup.
struct CpalInputHandle {
    stream: Option<StreamHolder>,
    active: Arc<AtomicBool>,
    config: NegotiatedConfig,
}

impl InputHandle for CpalInputHandle {
    fn negotiated_config(&self) -> NegotiatedConfig {
        self.config.clone()
    }

    fn start(&mut self) -> Result<(), AudioError> {
        self.active.store(true, Ordering::SeqCst);
        if let Some(ref holder) = self.stream {
            holder
                .stream
                .play()
                .map_err(|e| AudioError::StreamOpenFailed(format!("Failed to start stream: {}", e)))?;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.active.store(false, Ordering::SeqCst);
        // Give the callback a moment to see the flag
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Drop the stream to release OS audio resources
        self.stream = None;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.active.load(Ordering::SeqCst) && self.stream.is_some()
    }
}

impl Drop for CpalInputHandle {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
    }
}
