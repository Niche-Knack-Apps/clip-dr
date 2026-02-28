//! PulseAudio device enumeration and capture for Linux.
//!
//! Replaces cpal's ALSA backend on PipeWire-managed systems where cpal only sees
//! generic PCM hints. Uses libpulse-binding for enumeration and libpulse-simple
//! for blocking capture. Falls back to cpal if PulseAudio is not available.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use libpulse_binding as pulse;
use libpulse_binding::context::{Context, State as CtxState};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::proplist::Proplist;
use libpulse_simple_binding::Simple;
use pulse::sample::{Format, Spec};
use pulse::stream::Direction;

use super::recording::{AudioDevice, RecordingRingBuffer};

// ── Enumeration ──

/// Enumerate PulseAudio sources (input devices + monitors).
pub fn enumerate_pulse_sources() -> Result<Vec<AudioDevice>, String> {
    log::debug!("[PulseEnum] enumerate_pulse_sources() starting");

    let mut mainloop = match Mainloop::new() {
        Some(ml) => {
            log::debug!("[PulseEnum] Mainloop created successfully");
            ml
        }
        None => {
            log::error!("[PulseEnum] Failed to create PulseAudio mainloop — is libpulse.so loaded?");
            return Err("Failed to create PulseAudio mainloop".to_string());
        }
    };

    let mut proplist = match Proplist::new() {
        Some(pl) => pl,
        None => {
            log::error!("[PulseEnum] Failed to create PulseAudio proplist");
            return Err("Failed to create proplist".to_string());
        }
    };
    let _ = proplist.set_str(pulse::proplist::properties::APPLICATION_NAME, "Clip Dr.");

    let mut context = match Context::new_with_proplist(&mainloop, "Clip Dr.", &proplist) {
        Some(ctx) => {
            log::debug!("[PulseEnum] Context created successfully");
            ctx
        }
        None => {
            log::error!("[PulseEnum] Failed to create PulseAudio context — possible server incompatibility");
            return Err("Failed to create PulseAudio context".to_string());
        }
    };

    log::debug!("[PulseEnum] Connecting to PulseAudio server...");
    context.connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .map_err(|e| {
            log::error!("[PulseEnum] connect() failed: {} — is PulseAudio/PipeWire running?", e);
            format!("Failed to connect to PulseAudio: {}", e)
        })?;

    // Wait for context Ready
    let mut connect_iterations = 0u32;
    loop {
        match mainloop.iterate(true) {
            IterateResult::Success(_) => {}
            IterateResult::Err(e) => {
                log::error!("[PulseEnum] Mainloop iterate error during connect: {}", e);
                return Err(format!("Mainloop iterate error: {}", e));
            }
            IterateResult::Quit(_) => {
                log::error!("[PulseEnum] Mainloop quit unexpectedly during connect");
                return Err("Mainloop quit unexpectedly".to_string());
            }
        }
        connect_iterations += 1;
        let state = context.get_state();
        match state {
            CtxState::Ready => {
                log::debug!("[PulseEnum] Context ready after {} iterations", connect_iterations);
                break;
            }
            CtxState::Failed | CtxState::Terminated => {
                log::error!("[PulseEnum] Context state={:?} after {} iterations — server rejected connection", state, connect_iterations);
                return Err("PulseAudio context failed to connect".to_string());
            }
            _ => {
                if connect_iterations % 50 == 0 {
                    log::debug!("[PulseEnum] Still connecting... state={:?} iteration={}", state, connect_iterations);
                }
            }
        }
    }

    // Get default source name
    log::debug!("[PulseEnum] Querying server info for default source...");
    let default_source: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let server_done = Arc::new(AtomicBool::new(false));
    {
        let ds = default_source.clone();
        let done = server_done.clone();
        let _op = context.introspect().get_server_info(move |info| {
            log::debug!("[PulseEnum] Server info callback: default_source={:?}, default_sink={:?}, server_name={:?}",
                info.default_source_name, info.default_sink_name, info.server_name);
            if let Some(ref name) = info.default_source_name {
                if let Ok(mut guard) = ds.lock() {
                    *guard = Some(name.to_string());
                }
            }
            done.store(true, Ordering::SeqCst);
        });
        while !server_done.load(Ordering::SeqCst) {
            match mainloop.iterate(true) {
                IterateResult::Success(_) => {}
                IterateResult::Err(e) => return Err(format!("Mainloop iterate error: {}", e)),
                IterateResult::Quit(_) => break,
            }
        }
    }
    let default_source_name = default_source.lock().ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    log::debug!("[PulseEnum] Default source name: '{}'", default_source_name);

    // Collect sources
    log::debug!("[PulseEnum] Requesting source info list...");
    let sources: Arc<Mutex<Vec<AudioDevice>>> = Arc::new(Mutex::new(Vec::new()));
    let list_done = Arc::new(AtomicBool::new(false));
    {
        let devs = sources.clone();
        let done = list_done.clone();
        let ds_name = default_source_name.clone();
        let _op = context.introspect().get_source_info_list(move |result| {
            match result {
                pulse::callbacks::ListResult::Item(info) => {
                    let name = info.name.as_ref().map(|n| n.to_string()).unwrap_or_default();
                    let description = info.description.as_ref()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| name.clone());
                    let rate = info.sample_spec.rate;
                    let channels = info.sample_spec.channels as u16;
                    let index = info.index;
                    let is_monitor = info.monitor_of_sink.is_some();

                    // Extract proplist properties
                    let hw_bus = info.proplist.get_str("device.bus").unwrap_or_default();
                    let serial = info.proplist.get_str("device.serial").unwrap_or_default();
                    let device_class = info.proplist.get_str("device.class").unwrap_or_default();
                    let form_factor = info.proplist.get_str("device.form_factor").unwrap_or_default();

                    log::debug!("[PulseEnum] Source #{}: name='{}', desc='{}', rate={}, ch={}, state={:?}, monitor_of={:?}, bus='{}', serial='{}', class='{}', form_factor='{}'",
                        index, name, description, rate, channels, info.state, info.monitor_of_sink,
                        hw_bus, serial, device_class, form_factor);

                    // Classification
                    let device_source = if is_monitor {
                        "monitor"
                    } else if matches!(hw_bus.as_str(), "usb" | "pci" | "bluetooth") {
                        "hardware"
                    } else {
                        "virtual"
                    };

                    let device_type = if is_monitor {
                        "loopback"
                    } else if device_source == "hardware" {
                        "microphone"
                    } else {
                        "virtual"
                    };

                    let is_default = name == ds_name;

                    let device = AudioDevice {
                        id: name.clone(),
                        name: description,
                        is_default,
                        is_input: true,
                        is_loopback: is_monitor,
                        is_output: false,
                        device_type: device_type.to_string(),
                        channels,
                        sample_rates: vec![rate],
                        platform_id: name.clone(),
                        device_source: device_source.to_string(),
                        pulse_name: name,
                        pulse_index: index,
                        hw_bus,
                        serial,
                    };

                    log::debug!("[PulseEnum] Source #{} classified: device_source='{}', device_type='{}', is_default={}, is_loopback={}",
                        index, device_source, device_type, is_default, is_monitor);

                    if let Ok(mut guard) = devs.lock() {
                        guard.push(device);
                    }
                }
                pulse::callbacks::ListResult::End => {
                    log::debug!("[PulseEnum] Source list enumeration complete (End)");
                    done.store(true, Ordering::SeqCst);
                }
                pulse::callbacks::ListResult::Error => {
                    log::error!("[PulseEnum] Source list enumeration returned Error");
                    done.store(true, Ordering::SeqCst);
                }
            }
        });
        while !list_done.load(Ordering::SeqCst) {
            match mainloop.iterate(true) {
                IterateResult::Success(_) => {}
                IterateResult::Err(e) => return Err(format!("Mainloop iterate error: {}", e)),
                IterateResult::Quit(_) => break,
            }
        }
    }

    // Disconnect
    log::debug!("[PulseEnum] Disconnecting from PulseAudio server");
    context.disconnect();
    mainloop.quit(pulse::def::Retval(0));

    let mut devices = sources.lock().map_err(|_| "Lock poisoned".to_string())?.clone();

    // Sort: hardware first, then virtual, then monitors
    devices.sort_by(|a, b| {
        let order = |d: &AudioDevice| -> u8 {
            match d.device_source.as_str() {
                "hardware" => 0,
                "virtual" => 1,
                "monitor" => 2,
                _ => 3,
            }
        };
        order(a).cmp(&order(b))
            .then(b.is_default.cmp(&a.is_default))
            .then(a.name.cmp(&b.name))
    });

    log::info!("Pulse enumerated {} sources (default: '{}')", devices.len(), default_source_name);
    for d in &devices {
        log::info!("  [{}] {} ({}ch {}Hz) source={} bus={}",
            d.pulse_index, d.name, d.channels,
            d.sample_rates.first().unwrap_or(&0),
            d.device_source, d.hw_bus);
    }

    Ok(devices)
}

/// Enumerate PulseAudio sinks (output devices). Used by list_all_audio_devices.
pub fn enumerate_pulse_sinks() -> Result<Vec<AudioDevice>, String> {
    log::debug!("[PulseEnum] enumerate_pulse_sinks() starting");

    let mut mainloop = match Mainloop::new() {
        Some(ml) => ml,
        None => {
            log::error!("[PulseEnum] Sinks: Failed to create mainloop");
            return Err("Failed to create PulseAudio mainloop".to_string());
        }
    };

    let mut proplist = Proplist::new().ok_or("Failed to create proplist")?;
    let _ = proplist.set_str(pulse::proplist::properties::APPLICATION_NAME, "Clip Dr.");

    let mut context = match Context::new_with_proplist(&mainloop, "Clip Dr.", &proplist) {
        Some(ctx) => ctx,
        None => {
            log::error!("[PulseEnum] Sinks: Failed to create context");
            return Err("Failed to create PulseAudio context".to_string());
        }
    };

    log::debug!("[PulseEnum] Sinks: Connecting to PulseAudio server...");
    context.connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .map_err(|e| {
            log::error!("[PulseEnum] Sinks: connect() failed: {}", e);
            format!("Failed to connect to PulseAudio: {}", e)
        })?;

    // Wait for context Ready
    loop {
        match mainloop.iterate(true) {
            IterateResult::Success(_) => {}
            IterateResult::Err(e) => return Err(format!("Mainloop iterate error: {}", e)),
            IterateResult::Quit(_) => return Err("Mainloop quit unexpectedly".to_string()),
        }
        match context.get_state() {
            CtxState::Ready => {
                log::debug!("[PulseEnum] Sinks: Context ready");
                break;
            }
            CtxState::Failed | CtxState::Terminated => {
                log::error!("[PulseEnum] Sinks: Context failed to connect");
                return Err("PulseAudio context failed to connect".to_string());
            }
            _ => {}
        }
    }

    // Get default sink name
    log::debug!("[PulseEnum] Sinks: Querying server info for default sink...");
    let default_sink: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let server_done = Arc::new(AtomicBool::new(false));
    {
        let ds = default_sink.clone();
        let done = server_done.clone();
        let _op = context.introspect().get_server_info(move |info| {
            log::debug!("[PulseEnum] Sinks: default_sink_name={:?}", info.default_sink_name);
            if let Some(ref name) = info.default_sink_name {
                if let Ok(mut guard) = ds.lock() {
                    *guard = Some(name.to_string());
                }
            }
            done.store(true, Ordering::SeqCst);
        });
        while !server_done.load(Ordering::SeqCst) {
            match mainloop.iterate(true) {
                IterateResult::Success(_) => {}
                IterateResult::Err(e) => return Err(format!("Mainloop iterate error: {}", e)),
                IterateResult::Quit(_) => break,
            }
        }
    }
    let default_sink_name = default_sink.lock().ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    log::debug!("[PulseEnum] Sinks: default_sink_name='{}'", default_sink_name);

    // Collect sinks
    log::debug!("[PulseEnum] Sinks: Requesting sink info list...");
    let sinks: Arc<Mutex<Vec<AudioDevice>>> = Arc::new(Mutex::new(Vec::new()));
    let list_done = Arc::new(AtomicBool::new(false));
    {
        let devs = sinks.clone();
        let done = list_done.clone();
        let ds_name = default_sink_name.clone();
        let _op = context.introspect().get_sink_info_list(move |result| {
            match result {
                pulse::callbacks::ListResult::Item(info) => {
                    let name = info.name.as_ref().map(|n| n.to_string()).unwrap_or_default();
                    let description = info.description.as_ref()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| name.clone());
                    let rate = info.sample_spec.rate;
                    let channels = info.sample_spec.channels as u16;
                    let index = info.index;

                    let hw_bus = info.proplist.get_str("device.bus").unwrap_or_default();
                    let serial = info.proplist.get_str("device.serial").unwrap_or_default();

                    log::debug!("[PulseEnum] Sink #{}: name='{}', desc='{}', rate={}, ch={}, state={:?}, bus='{}'",
                        index, name, description, rate, channels, info.state, hw_bus);

                    let device_source = if matches!(hw_bus.as_str(), "usb" | "pci" | "bluetooth") {
                        "hardware"
                    } else {
                        "virtual"
                    };

                    let is_default = name == ds_name;

                    let device = AudioDevice {
                        id: name.clone(),
                        name: description,
                        is_default,
                        is_input: false,
                        is_loopback: false,
                        is_output: true,
                        device_type: "output".to_string(),
                        channels,
                        sample_rates: vec![rate],
                        platform_id: name.clone(),
                        device_source: device_source.to_string(),
                        pulse_name: name,
                        pulse_index: index,
                        hw_bus,
                        serial,
                    };

                    if let Ok(mut guard) = devs.lock() {
                        guard.push(device);
                    }
                }
                pulse::callbacks::ListResult::End => {
                    log::debug!("[PulseEnum] Sink list enumeration complete (End)");
                    done.store(true, Ordering::SeqCst);
                }
                pulse::callbacks::ListResult::Error => {
                    log::error!("[PulseEnum] Sink list enumeration returned Error");
                    done.store(true, Ordering::SeqCst);
                }
            }
        });
        while !list_done.load(Ordering::SeqCst) {
            match mainloop.iterate(true) {
                IterateResult::Success(_) => {}
                IterateResult::Err(e) => return Err(format!("Mainloop iterate error: {}", e)),
                IterateResult::Quit(_) => break,
            }
        }
    }

    log::debug!("[PulseEnum] Sinks: Disconnecting");
    context.disconnect();
    mainloop.quit(pulse::def::Retval(0));

    let devices = sinks.lock().map_err(|_| "Lock poisoned".to_string())?.clone();

    log::info!("[PulseEnum] Enumerated {} sinks", devices.len());
    for d in &devices {
        log::debug!("[PulseEnum]   Sink [{}] {} ({}ch {}Hz) source={} default={}",
            d.pulse_index, d.name, d.channels,
            d.sample_rates.first().unwrap_or(&0),
            d.device_source, d.is_default);
    }
    Ok(devices)
}

/// Returns true if the device ID looks like a PulseAudio source name.
pub fn is_pulse_source(device_id: &str) -> bool {
    let result = device_id.starts_with("alsa_input.")
        || device_id.starts_with("alsa_output.")
        || device_id.starts_with("bluez_source.")
        || device_id.starts_with("bluez_sink.")
        || device_id.contains(".monitor");
    log::debug!("[PulseRoute] is_pulse_source('{}') = {}", device_id, result);
    result
}

// ── Capture ──

/// Open a PulseAudio Simple capture connection to the given source.
/// Negotiates format: prefers F32le, falls back to S16le and common rates.
/// Returns the Simple handle and the negotiated Spec.
pub fn open_pulse_capture(source_name: &str, source_rate: u32, source_channels: u16) -> Result<(Simple, Spec), String> {
    log::debug!("[PulseCapture] open_pulse_capture('{}', rate={}, ch={})", source_name, source_rate, source_channels);

    let attempts = [
        (Format::F32le, source_rate, source_channels),
        (Format::S16le, source_rate, source_channels),
        (Format::F32le, 48000, 2),
        (Format::S16le, 48000, 2),
    ];

    for (i, &(format, rate, channels)) in attempts.iter().enumerate() {
        let spec = Spec {
            format,
            rate,
            channels: channels as u8,
        };
        if !spec.is_valid() {
            continue;
        }

        match Simple::new(
            None,                       // default server
            "Clip Dr.",                 // app name
            Direction::Record,          // capture direction
            Some(source_name),          // specific source
            "recording",                // stream description
            &spec,
            None,                       // default channel map
            None,                       // default buffer attributes
        ) {
            Ok(simple) => {
                log::info!("Pulse capture opened (attempt {}): {} @ {}Hz {}ch {:?}",
                    i + 1, source_name, rate, channels, format);
                return Ok((simple, spec));
            }
            Err(e) => {
                log::warn!("Pulse capture attempt {} failed ({:?} {}Hz {}ch): {}",
                    i + 1, format, rate, channels, e);
            }
        }
    }

    log::error!("[PulseCapture] All {} format attempts failed for source '{}'", attempts.len(), source_name);
    Err(format!("Failed to open Pulse capture for '{}' after all format attempts", source_name))
}

/// Blocking capture thread: reads from Pulse Simple, converts to f32, pushes into ring buffer.
/// Used for actual recording (with WAV writer downstream).
pub fn pulse_capture_thread(
    simple: Simple,
    spec: Spec,
    ring: Arc<RecordingRingBuffer>,
    active: Arc<AtomicBool>,
    session_level: Arc<AtomicU32>,
    shared_level: Arc<AtomicU32>,
) {
    // Buffer size: ~20ms of audio
    let frame_bytes = spec.frame_size();
    let buf_frames = (spec.rate as usize) / 50; // 20ms
    let buf_bytes = buf_frames * frame_bytes;
    let mut buffer = vec![0u8; buf_bytes];
    let mut read_count: u64 = 0;
    let mut total_samples: u64 = 0;

    log::info!("[PulseCapture] Capture thread started: format={:?} rate={}Hz channels={} frame_bytes={} buf_frames={} buf_bytes={}",
        spec.format, spec.rate, spec.channels, frame_bytes, buf_frames, buf_bytes);
    log::debug!("[PulseCapture] Ring buffer capacity={} channels={}", ring.capacity, ring.channels);

    while active.load(Ordering::SeqCst) {
        match simple.read(&mut buffer) {
            Ok(()) => {
                // Convert to f32 samples
                let samples: Vec<f32> = match spec.format {
                    Format::F32le => {
                        buffer.chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                            .collect()
                    }
                    Format::S16le => {
                        buffer.chunks_exact(2)
                            .map(|c| {
                                let s = i16::from_le_bytes([c[0], c[1]]);
                                (s as f32) / 32768.0
                            })
                            .collect()
                    }
                    _ => continue,
                };

                // Update level meter
                let max_level = samples.iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max);
                let level_val = (max_level * 1000.0) as u32;
                session_level.store(level_val, Ordering::SeqCst);
                shared_level.store(level_val, Ordering::SeqCst);

                read_count += 1;
                total_samples += samples.len() as u64;

                // Log first read and then every ~5 seconds (250 reads at 20ms each)
                if read_count == 1 {
                    log::debug!("[PulseCapture] First read OK: {} samples, peak={:.4}", samples.len(), max_level);
                } else if read_count % 250 == 0 {
                    let elapsed_s = (read_count * 20) / 1000;
                    let overruns = ring.overrun_count.load(Ordering::Relaxed);
                    log::debug!("[PulseCapture] Status: {}s elapsed, {} reads, {} total samples, peak={:.4}, overruns={}",
                        elapsed_s, read_count, total_samples, max_level, overruns);
                }

                // Push into ring buffer
                let wp = ring.write_pos.load(Ordering::Relaxed);
                let rp = ring.read_pos.load(Ordering::Relaxed);
                let used = wp.wrapping_sub(rp);
                if used + samples.len() <= ring.capacity {
                    for (i, &s) in samples.iter().enumerate() {
                        let idx = (wp + i) % ring.capacity;
                        unsafe { *ring.data_ptr.add(idx) = s; }
                    }
                    ring.write_pos.store(wp + samples.len(), Ordering::Release);
                } else {
                    let overruns = ring.overrun_count.fetch_add(1, Ordering::Relaxed);
                    if overruns < 5 || overruns % 100 == 0 {
                        log::warn!("[PulseCapture] Ring buffer overrun #{}: used={}, need={}, capacity={}",
                            overruns + 1, used, samples.len(), ring.capacity);
                    }
                }
            }
            Err(e) => {
                if active.load(Ordering::SeqCst) {
                    log::error!("[PulseCapture] Read error (active=true, reads={}): {}", read_count, e);
                } else {
                    log::debug!("[PulseCapture] Read error after deactivation (expected): {}", e);
                }
                break;
            }
        }
    }

    // Drain before exit
    log::debug!("[PulseCapture] Draining before exit (total reads={}, total samples={})", read_count, total_samples);
    let _ = simple.drain();
    log::info!("[PulseCapture] Capture thread exiting after {} reads, {} total samples", read_count, total_samples);
}

/// Lightweight preview capture: reads from Pulse, computes level only (no ring buffer).
pub fn pulse_preview_thread(
    simple: Simple,
    spec: Spec,
    active: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) {
    let frame_bytes = spec.frame_size();
    let buf_frames = (spec.rate as usize) / 50;
    let buf_bytes = buf_frames * frame_bytes;
    let mut buffer = vec![0u8; buf_bytes];
    let mut read_count: u64 = 0;

    log::debug!("[PulsePreview] Preview thread started: format={:?} rate={}Hz channels={} buf={}B",
        spec.format, spec.rate, spec.channels, buf_bytes);

    while active.load(Ordering::SeqCst) {
        match simple.read(&mut buffer) {
            Ok(()) => {
                read_count += 1;
                let max_level: f32 = match spec.format {
                    Format::F32le => {
                        buffer.chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs())
                            .fold(0.0f32, f32::max)
                    }
                    Format::S16le => {
                        buffer.chunks_exact(2)
                            .map(|c| {
                                let s = i16::from_le_bytes([c[0], c[1]]);
                                ((s as f32) / 32768.0).abs()
                            })
                            .fold(0.0f32, f32::max)
                    }
                    _ => continue,
                };
                level.store((max_level * 1000.0) as u32, Ordering::SeqCst);

                if read_count == 1 {
                    log::debug!("[PulsePreview] First read OK: peak={:.4}", max_level);
                }
            }
            Err(e) => {
                if !active.load(Ordering::SeqCst) {
                    log::debug!("[PulsePreview] Read error after deactivation (expected)");
                    break;
                }
                log::warn!("[PulsePreview] Read error (reads={}): {}", read_count, e);
            }
        }
    }

    let _ = simple.drain();
    log::info!("[PulsePreview] Preview thread exiting after {} reads", read_count);
}
