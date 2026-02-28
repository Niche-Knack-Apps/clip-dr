/// Typed audio errors (replaces string-based errors in future phases).
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("Backend unavailable: {0}")]
    BackendUnavailable(String),
    #[error("Device not found: {0}")]
    DeviceNotFound(String),
    #[error("Format negotiation failed for '{device}': tried {attempts} combinations")]
    FormatNegotiationFailed { device: String, attempts: usize },
    #[error("Stream open failed: {0}")]
    StreamOpenFailed(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Device disconnected: {0}")]
    DeviceDisconnected(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
