//! Audio cleaning pipeline module
//!
//! Provides multi-stage audio processing for noise reduction and cleanup:
//! 1. Band-limiting filters (IIR high-pass/low-pass)
//! 2. Notch filters for mains hum removal
//! 3. Spectral noise suppression (FFT-based Wiener filter)
//! 4. Neural denoising (RNNoise via nnnoiseless)
//! 5. Downward expander (gentle noise gate)

pub mod filters;
pub mod spectral;
pub mod neural;
pub mod expander;
pub mod pipeline;

pub use pipeline::{process_audio, CleaningOptions};
