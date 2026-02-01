//! Spectral noise suppression using FFT-based Wiener filtering
//!
//! Estimates noise profile from silent segments and applies spectral subtraction.

use realfft::{RealFftPlanner, RealToComplex, ComplexToReal};
use std::sync::Arc;

/// FFT-based spectral denoiser
pub struct SpectralDenoiser {
    fft_size: usize,
    hop_size: usize,
    noise_profile: Vec<f32>,
    reduction_db: f32,
    forward_fft: Arc<dyn RealToComplex<f32>>,
    inverse_fft: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,
}

impl SpectralDenoiser {
    /// Create a new spectral denoiser
    ///
    /// # Arguments
    /// * `fft_size` - FFT size (typically 2048)
    /// * `reduction_db` - Amount of noise reduction in dB (0-24)
    pub fn new(fft_size: usize, reduction_db: f32) -> Self {
        let hop_size = fft_size / 4; // 75% overlap

        let mut planner = RealFftPlanner::<f32>::new();
        let forward_fft = planner.plan_fft_forward(fft_size);
        let inverse_fft = planner.plan_fft_inverse(fft_size);

        // Hann window
        let window: Vec<f32> = (0..fft_size)
            .map(|i| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / fft_size as f32).cos())
            })
            .collect();

        Self {
            fft_size,
            hop_size,
            noise_profile: vec![0.0; fft_size / 2 + 1],
            reduction_db,
            forward_fft,
            inverse_fft,
            window,
        }
    }

    /// Estimate noise profile from silent segments
    ///
    /// # Arguments
    /// * `samples` - Audio samples
    /// * `silent_segments` - List of (start, end) sample indices for silent regions
    pub fn estimate_noise_profile(&mut self, samples: &[f32], silent_segments: &[(usize, usize)]) {
        if silent_segments.is_empty() {
            // No silence detected, use simple noise floor estimation
            self.estimate_noise_from_low_energy(samples);
            return;
        }

        let mut spectrum_sum = vec![0.0f32; self.fft_size / 2 + 1];
        let mut frame_count = 0;

        for &(start, end) in silent_segments {
            let segment = &samples[start.min(samples.len())..end.min(samples.len())];

            // Process frames within this silent segment
            let mut pos = 0;
            while pos + self.fft_size <= segment.len() {
                let frame = &segment[pos..pos + self.fft_size];

                // Apply window and FFT
                let mut buffer: Vec<f32> = frame
                    .iter()
                    .zip(&self.window)
                    .map(|(s, w)| s * w)
                    .collect();

                let mut spectrum = self.forward_fft.make_output_vec();
                if self.forward_fft.process(&mut buffer, &mut spectrum).is_ok() {
                    // Accumulate magnitude spectrum
                    for (i, c) in spectrum.iter().enumerate() {
                        spectrum_sum[i] += c.norm();
                    }
                    frame_count += 1;
                }

                pos += self.hop_size;
            }
        }

        // Average the noise profile
        if frame_count > 0 {
            for (profile, sum) in self.noise_profile.iter_mut().zip(&spectrum_sum) {
                *profile = sum / frame_count as f32;
            }
        }
    }

    /// Estimate noise from low-energy frames when no silence segments available
    fn estimate_noise_from_low_energy(&mut self, samples: &[f32]) {
        // Find frames with lowest energy
        let mut frame_energies: Vec<(usize, f32)> = Vec::new();

        let mut pos = 0;
        while pos + self.fft_size <= samples.len() {
            let frame = &samples[pos..pos + self.fft_size];
            let energy: f32 = frame.iter().map(|s| s * s).sum();
            frame_energies.push((pos, energy));
            pos += self.hop_size;
        }

        if frame_energies.is_empty() {
            return;
        }

        // Sort by energy and take bottom 10%
        frame_energies.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let quiet_count = (frame_energies.len() / 10).max(1);

        let mut spectrum_sum = vec![0.0f32; self.fft_size / 2 + 1];
        let mut frame_count = 0;

        for &(start, _) in frame_energies.iter().take(quiet_count) {
            let frame = &samples[start..start + self.fft_size];

            let mut buffer: Vec<f32> = frame
                .iter()
                .zip(&self.window)
                .map(|(s, w)| s * w)
                .collect();

            let mut spectrum = self.forward_fft.make_output_vec();
            if self.forward_fft.process(&mut buffer, &mut spectrum).is_ok() {
                for (i, c) in spectrum.iter().enumerate() {
                    spectrum_sum[i] += c.norm();
                }
                frame_count += 1;
            }
        }

        if frame_count > 0 {
            for (profile, sum) in self.noise_profile.iter_mut().zip(&spectrum_sum) {
                *profile = sum / frame_count as f32;
            }
        }
    }

    /// Process audio through the spectral denoiser
    ///
    /// Applies Wiener filtering: gain = max(floor, 1 - (noise/signal)^power)
    pub fn process(&mut self, samples: &mut [f32]) {
        if samples.len() < self.fft_size {
            return;
        }

        // Noise reduction factor from dB
        let reduction_factor = 10.0_f32.powf(self.reduction_db / 20.0);
        let floor = 0.02; // Minimum gain to avoid complete silence

        // Output buffer for overlap-add
        let mut output = vec![0.0f32; samples.len()];
        let mut window_sum = vec![0.0f32; samples.len()];

        let mut pos = 0;
        while pos + self.fft_size <= samples.len() {
            // Extract and window frame
            let mut buffer: Vec<f32> = samples[pos..pos + self.fft_size]
                .iter()
                .zip(&self.window)
                .map(|(s, w)| s * w)
                .collect();

            let mut spectrum = self.forward_fft.make_output_vec();

            if self.forward_fft.process(&mut buffer, &mut spectrum).is_ok() {
                // Apply Wiener filter
                for (i, c) in spectrum.iter_mut().enumerate() {
                    let signal_mag = c.norm();
                    let noise_mag = self.noise_profile[i] * reduction_factor;

                    // Wiener gain
                    let gain = if signal_mag > 0.0 {
                        let snr = signal_mag / (noise_mag + 1e-10);
                        ((snr - 1.0) / snr).max(floor)
                    } else {
                        floor
                    };

                    *c = *c * gain;
                }

                // Inverse FFT
                let mut time_buffer = self.inverse_fft.make_output_vec();
                if self.inverse_fft.process(&mut spectrum, &mut time_buffer).is_ok() {
                    // Normalize and apply window
                    let norm = 1.0 / self.fft_size as f32;
                    for (i, sample) in time_buffer.iter().enumerate() {
                        if pos + i < output.len() {
                            output[pos + i] += sample * norm * self.window[i];
                            window_sum[pos + i] += self.window[i] * self.window[i];
                        }
                    }
                }
            }

            pos += self.hop_size;
        }

        // Normalize by window sum (overlap-add normalization)
        for (i, sample) in samples.iter_mut().enumerate() {
            if window_sum[i] > 0.001 {
                *sample = output[i] / window_sum[i];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spectral_denoiser_creation() {
        let denoiser = SpectralDenoiser::new(2048, 12.0);
        assert_eq!(denoiser.fft_size, 2048);
        assert_eq!(denoiser.hop_size, 512);
    }

    #[test]
    fn test_spectral_denoiser_process() {
        let mut denoiser = SpectralDenoiser::new(2048, 12.0);
        let mut samples = vec![0.1f32; 4096];
        denoiser.process(&mut samples);
        // Just verify it runs without panic
    }
}
