//! Neural denoising using RNNoise via nnnoiseless
//!
//! Provides deep learning-based noise suppression with configurable strength.

use nnnoiseless::DenoiseState;
use rubato::{SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction, Resampler};

/// RNNoise frame size (fixed at 480 samples at 48kHz = 10ms)
const RNNOISE_FRAME_SIZE: usize = 480;
/// RNNoise sample rate (fixed at 48kHz)
const RNNOISE_SAMPLE_RATE: usize = 48000;

/// Neural denoiser wrapper around nnnoiseless
pub struct NeuralDenoiser {
    strength: f32,
    source_sample_rate: f32,
}

impl NeuralDenoiser {
    /// Create a new neural denoiser
    ///
    /// # Arguments
    /// * `source_sample_rate` - Sample rate of the input audio
    /// * `strength` - Blend strength (0.0 = original, 1.0 = fully denoised)
    pub fn new(source_sample_rate: f32, strength: f32) -> Self {
        Self {
            strength: strength.clamp(0.0, 1.0),
            source_sample_rate,
        }
    }

    /// Process audio through RNNoise
    ///
    /// Handles resampling to/from 48kHz as required by RNNoise
    pub fn process(&self, samples: &mut [f32]) -> Result<(), String> {
        if samples.is_empty() || self.strength <= 0.0 {
            return Ok(());
        }

        // Keep original for blending
        let original: Vec<f32> = samples.to_vec();

        // Resample to 48kHz if needed
        let needs_resample = (self.source_sample_rate - RNNOISE_SAMPLE_RATE as f32).abs() > 1.0;

        let samples_48k = if needs_resample {
            self.resample_to_48k(&original)?
        } else {
            original.clone()
        };

        // Process through RNNoise
        let denoised_48k = self.run_rnnoise(&samples_48k)?;

        // Resample back if needed
        let denoised = if needs_resample {
            self.resample_from_48k(&denoised_48k, samples.len())?
        } else {
            denoised_48k
        };

        // Blend with original based on strength
        for (i, sample) in samples.iter_mut().enumerate() {
            if i < denoised.len() {
                *sample = original[i] * (1.0 - self.strength) + denoised[i] * self.strength;
            }
        }

        Ok(())
    }

    /// Resample input to 48kHz
    fn resample_to_48k(&self, samples: &[f32]) -> Result<Vec<f32>, String> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        let ratio = RNNOISE_SAMPLE_RATE as f64 / self.source_sample_rate as f64;

        let mut resampler = SincFixedIn::<f32>::new(
            ratio,
            2.0,
            params,
            samples.len(),
            1,
        ).map_err(|e| format!("Failed to create upsampler: {}", e))?;

        let input = vec![samples.to_vec()];
        let resampled = resampler.process(&input, None)
            .map_err(|e| format!("Failed to resample to 48k: {}", e))?;

        Ok(resampled.into_iter().next().unwrap_or_default())
    }

    /// Resample from 48kHz back to original rate
    fn resample_from_48k(
        &self,
        samples: &[f32],
        target_len: usize,
    ) -> Result<Vec<f32>, String> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        let ratio = self.source_sample_rate as f64 / RNNOISE_SAMPLE_RATE as f64;

        // Create resampler with the ACTUAL input length
        let mut resampler = SincFixedIn::<f32>::new(
            ratio,
            2.0,
            params,
            samples.len(),
            1,
        ).map_err(|e| format!("Failed to create downsampler: {}", e))?;

        let input = vec![samples.to_vec()];
        let mut resampled = resampler.process(&input, None)
            .map_err(|e| format!("Failed to resample from 48k: {}", e))?
            .into_iter()
            .next()
            .unwrap_or_default();

        // Ensure output matches original length
        resampled.resize(target_len, 0.0);
        Ok(resampled)
    }

    /// Run audio through RNNoise
    fn run_rnnoise(&self, samples: &[f32]) -> Result<Vec<f32>, String> {
        let mut state = DenoiseState::new();
        let mut output = Vec::with_capacity(samples.len());

        // Process in RNNOISE_FRAME_SIZE chunks
        let mut pos = 0;
        while pos < samples.len() {
            let remaining = samples.len() - pos;
            let chunk_size = remaining.min(RNNOISE_FRAME_SIZE);

            // Prepare input frame (pad with zeros if needed)
            let mut frame = [0.0f32; RNNOISE_FRAME_SIZE];
            for (i, sample) in samples[pos..pos + chunk_size].iter().enumerate() {
                frame[i] = *sample;
            }

            // Process frame
            let mut output_frame = [0.0f32; RNNOISE_FRAME_SIZE];
            state.process_frame(&mut output_frame, &frame);

            // Copy output (only the valid portion)
            output.extend_from_slice(&output_frame[..chunk_size]);

            pos += chunk_size;
        }

        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_neural_denoiser_creation() {
        let denoiser = NeuralDenoiser::new(44100.0, 0.8);
        assert!((denoiser.strength - 0.8).abs() < 0.01);
    }

    #[test]
    fn test_neural_denoiser_48k() {
        // Test with 48kHz input (no resampling needed)
        let denoiser = NeuralDenoiser::new(48000.0, 1.0);
        let mut samples = vec![0.1f32; 4800]; // 100ms at 48kHz
        let result = denoiser.process(&mut samples);
        assert!(result.is_ok());
    }

    #[test]
    fn test_neural_denoiser_zero_strength() {
        let denoiser = NeuralDenoiser::new(44100.0, 0.0);
        let original = vec![0.5f32; 1000];
        let mut samples = original.clone();
        let result = denoiser.process(&mut samples);
        assert!(result.is_ok());
        // With zero strength, output should equal input
        assert_eq!(samples, original);
    }
}
