use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::error::AudioError;
use super::ring_buffer::RecordingRingBuffer;
use super::types::AudioDevice;

#[cfg(target_os = "linux")]
use super::pulse_backend::PulseBackend;
use super::cpal_backend::CpalBackend;

// ── Backend kind & stable device identity ──

/// Which audio backend produced / owns a device.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum BackendKind {
    Pulse,
    Cpal,
}

/// Stable device identity: backend kind + opaque ID.
/// Survives replug/reorder; safe to persist in settings.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct DeviceKey {
    pub backend: BackendKind,
    /// Backend-specific stable id (e.g. Pulse source name, CPAL device name)
    pub opaque_id: String,
}

impl std::fmt::Display for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}:{}", self.backend, self.opaque_id)
    }
}

// ── Stream configuration ──

/// What the caller would like (best-effort, backend negotiates).
pub struct StreamConfigRequest {
    pub preferred_rate: Option<u32>,
    pub preferred_channels: Option<u16>,
}

/// What the backend actually opened.
#[derive(Clone, Debug)]
pub struct NegotiatedConfig {
    pub rate: u32,
    pub channels: u16,
}

// ── AudioSink: where backends push samples ──

/// Passed to `open_input` — the backend writes interleaved f32 frames here.
/// The engine owns the ring buffer and meters; the backend just pushes data.
pub struct AudioSink {
    pub ring: Arc<RecordingRingBuffer>,
    /// Per-session peak level (0–1000), written by backend callback
    pub meter: Arc<AtomicU32>,
    /// Shared level for UI polling (same value, separate atomic for legacy compat)
    pub shared_meter: Arc<AtomicU32>,
}

// ── AudioBackend trait ──

/// One audio backend (chosen once at startup).  Backends enumerate devices
/// and open input streams that push samples into an [`AudioSink`].
pub trait AudioBackend: Send + Sync {
    /// Which backend this is.
    fn kind(&self) -> BackendKind;

    /// Enumerate available devices.
    fn list_devices(&self) -> Result<Vec<AudioDevice>, AudioError>;

    /// Open a recording input stream for the given device.
    /// The backend pushes interleaved f32 into `sink` from its audio thread.
    /// Call `InputHandle::start()` on the returned handle to begin capture.
    fn open_input(
        &self,
        device: &DeviceKey,
        config: StreamConfigRequest,
        sink: AudioSink,
    ) -> Result<Box<dyn InputHandle>, AudioError>;

    /// Open a preview-only stream (level metering, no ring buffer).
    fn open_preview(
        &self,
        device: &DeviceKey,
        level: Arc<AtomicU32>,
    ) -> Result<Box<dyn InputHandle>, AudioError>;
}

// ── InputHandle trait ──

/// Backend-owned handle to an active (or paused) input stream.
/// Backends implement `Drop` for cleanup (join threads, kill subprocesses, etc.).
pub trait InputHandle: Send {
    /// The config that the backend actually negotiated.
    fn negotiated_config(&self) -> NegotiatedConfig;

    /// Begin capturing audio.
    fn start(&mut self) -> Result<(), AudioError>;

    /// Stop capturing (idempotent).  After stop, the handle can be dropped.
    fn stop(&mut self) -> Result<(), AudioError>;

    /// Whether capture is currently active.
    fn is_running(&self) -> bool;
}

// ── DeviceRegistry ──

/// Holds the chosen audio backend (selected once at startup) and a cached
/// device list.  On Linux, defaults to PulseBackend; falls back to CpalBackend
/// if Pulse init fails.  On other platforms, uses CpalBackend directly.
pub struct DeviceRegistry {
    backend: Arc<dyn AudioBackend>,
    devices: Mutex<Vec<AudioDevice>>,
}

impl DeviceRegistry {
    /// Create a new registry, selecting the best available backend.
    pub fn new() -> Self {
        #[cfg(target_os = "linux")]
        {
            match PulseBackend::try_new() {
                Ok(pulse) => {
                    log::info!("DeviceRegistry: using PulseBackend");
                    return Self {
                        backend: Arc::new(pulse),
                        devices: Mutex::new(Vec::new()),
                    };
                }
                Err(e) => {
                    log::warn!(
                        "DeviceRegistry: PulseBackend unavailable ({}), falling back to cpal",
                        e
                    );
                }
            }
        }

        log::info!("DeviceRegistry: using CpalBackend");
        Self {
            backend: Arc::new(CpalBackend),
            devices: Mutex::new(Vec::new()),
        }
    }

    /// Refresh the cached device list from the backend.
    pub fn refresh(&self) -> Result<Vec<AudioDevice>, AudioError> {
        let devices = self.backend.list_devices()?;
        if let Ok(mut cache) = self.devices.lock() {
            *cache = devices.clone();
        }
        Ok(devices)
    }

    /// Get a reference to the active backend.
    pub fn backend(&self) -> &dyn AudioBackend {
        &*self.backend
    }

    /// Which backend is active.
    pub fn kind(&self) -> BackendKind {
        self.backend.kind()
    }

    /// Get the last cached device list (without querying the backend).
    pub fn cached_devices(&self) -> Vec<AudioDevice> {
        self.devices
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}
