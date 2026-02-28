//! PulseAudio backend for Linux.
//!
//! Delegates to `pulse_devices.rs` for low-level PA Simple API.
//! Default backend on Linux (PipeWire-compatible via pw-pulse).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use super::backend::{
    AudioBackend, AudioSink, BackendKind, DeviceKey, InputHandle, NegotiatedConfig,
    StreamConfigRequest,
};
use super::error::AudioError;
use super::ring_buffer::RecordingRingBuffer;
use super::types::AudioDevice;

// ── PulseBackend ──

/// Linux audio backend using PulseAudio Simple API.
/// Works on both native PulseAudio and PipeWire (via pw-pulse).
pub struct PulseBackend;

impl PulseBackend {
    /// Try to create a PulseBackend.  Fails if libpulse is not available.
    pub fn try_new() -> Result<Self, AudioError> {
        // Quick check: can we enumerate at all?
        match super::super::pulse_devices::enumerate_pulse_sources() {
            Ok(_) => Ok(PulseBackend),
            Err(e) => Err(AudioError::BackendUnavailable(format!(
                "PulseAudio not available: {}",
                e
            ))),
        }
    }
}

impl AudioBackend for PulseBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Pulse
    }

    fn list_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        super::super::pulse_devices::enumerate_pulse_sources()
            .map_err(|e| AudioError::BackendUnavailable(e))
    }

    fn open_input(
        &self,
        device_key: &DeviceKey,
        config_req: StreamConfigRequest,
        sink: AudioSink,
    ) -> Result<Box<dyn InputHandle>, AudioError> {
        let source_name = &device_key.opaque_id;
        let rate = config_req.preferred_rate.unwrap_or(48000);
        let channels = config_req.preferred_channels.unwrap_or(2);

        let (simple, spec) =
            super::super::pulse_devices::open_pulse_capture(source_name, rate, channels)
                .map_err(|e| AudioError::StreamOpenFailed(e))?;

        let negotiated_rate = spec.rate;
        let negotiated_channels = spec.channels as u16;

        let active = Arc::new(AtomicBool::new(false)); // start() sets true

        // Spawn capture thread (Simple is moved into the thread)
        let ring = sink.ring.clone();
        let a = active.clone();
        let session_level = sink.meter.clone();
        let shared_level = sink.shared_meter.clone();
        let handle = std::thread::Builder::new()
            .name(format!("pulse-capture-{}", source_name))
            .spawn(move || {
                super::super::pulse_devices::pulse_capture_thread(
                    simple,
                    spec,
                    ring,
                    a,
                    session_level,
                    shared_level,
                );
            })
            .map_err(|e| AudioError::StreamOpenFailed(format!("Failed to spawn thread: {}", e)))?;

        Ok(Box::new(PulseInputHandle {
            active,
            thread: Some(handle),
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
        let source_name = &device_key.opaque_id;

        let (simple, spec) =
            super::super::pulse_devices::open_pulse_capture(source_name, 48000, 2)
                .map_err(|e| AudioError::StreamOpenFailed(e))?;

        let negotiated_rate = spec.rate;
        let negotiated_channels = spec.channels as u16;

        let active = Arc::new(AtomicBool::new(false));

        let a = active.clone();
        let l = level;
        let handle = std::thread::Builder::new()
            .name(format!("pulse-preview-{}", source_name))
            .spawn(move || {
                super::super::pulse_devices::pulse_preview_thread(simple, spec, a, l);
            })
            .map_err(|e| AudioError::StreamOpenFailed(format!("Failed to spawn thread: {}", e)))?;

        Ok(Box::new(PulseInputHandle {
            active,
            thread: Some(handle),
            config: NegotiatedConfig {
                rate: negotiated_rate,
                channels: negotiated_channels,
            },
        }))
    }
}

// ── PulseInputHandle ──

/// Handle to a running Pulse capture thread.
/// The Simple connection is owned by the capture thread; we control it
/// via the `active` flag and join the thread on stop/drop.
struct PulseInputHandle {
    active: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    config: NegotiatedConfig,
}

impl InputHandle for PulseInputHandle {
    fn negotiated_config(&self) -> NegotiatedConfig {
        self.config.clone()
    }

    fn start(&mut self) -> Result<(), AudioError> {
        self.active.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.active.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for PulseInputHandle {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}
