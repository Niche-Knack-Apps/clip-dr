//! Post-clean dynamics processing
//!
//! Compensates for loudness loss from the cleaning pipeline's 5 gain-reduction
//! stages. Three components applied in order:
//! 1. Upward compression (boost quiet passages, leave loud passages alone)
//! 2. Makeup gain (restore pre-clean RMS level)
//! 3. Peak limiter (brickwall at -0.3 dBFS to prevent clipping)

/// Measure RMS of a sample buffer
pub fn measure_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt() as f32
}

/// Upward compressor with envelope follower
///
/// Boosts signal below threshold while leaving signal above threshold untouched.
/// This restores body to quiet speech passages that were attenuated by cleaning.
pub struct UpwardCompressor {
    threshold_linear: f32,
    ratio: f32,
    attack_coeff: f32,
    release_coeff: f32,
    envelope: f32,
}

impl UpwardCompressor {
    /// Create a new upward compressor
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `threshold_db` - Threshold in dB (signals below this get boosted)
    /// * `ratio` - Compression ratio (2.0 = 2:1 upward compression)
    pub fn new(sample_rate: f32, threshold_db: f32, ratio: f32) -> Self {
        let threshold_linear = 10.0_f32.powf(threshold_db / 20.0);

        // Fixed attack/release for musical behavior
        let attack_ms = 10.0;
        let release_ms = 100.0;

        let attack_samples = attack_ms * sample_rate / 1000.0;
        let release_samples = release_ms * sample_rate / 1000.0;

        let attack_coeff = (-2.2 / attack_samples).exp();
        let release_coeff = (-2.2 / release_samples).exp();

        Self {
            threshold_linear,
            ratio,
            attack_coeff,
            release_coeff,
            envelope: 0.0,
        }
    }

    /// Process samples in-place
    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            let input_abs = sample.abs();

            // Envelope follower
            let coeff = if input_abs > self.envelope {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.envelope = self.envelope * coeff + input_abs * (1.0 - coeff);

            // Upward compression: boost signals below threshold
            if self.envelope > 0.0 && self.envelope < self.threshold_linear {
                // How far below threshold (in dB)
                let db_below = 20.0 * (self.envelope / self.threshold_linear).log10();
                // Reduce the "distance below threshold" by the ratio
                // ratio=2 means 10dB below threshold becomes 5dB below
                let db_boost = db_below * (1.0 - 1.0 / self.ratio);
                // db_below is negative, db_boost is negative, so gain > 1
                let gain = 10.0_f32.powf(-db_boost / 20.0);
                *sample *= gain;
            }
            // Above threshold: unity gain (no change)
        }
    }
}

/// Sample-accurate brickwall peak limiter
///
/// Prevents output from exceeding ceiling. Fast attack ensures no overshoot,
/// slow release avoids pumping artifacts.
pub struct PeakLimiter {
    ceiling_linear: f32,
    release_coeff: f32,
    gain_reduction: f32,
}

impl PeakLimiter {
    /// Create a new peak limiter
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `ceiling_db` - Maximum output level in dBFS (e.g., -0.3)
    pub fn new(sample_rate: f32, ceiling_db: f32) -> Self {
        let ceiling_linear = 10.0_f32.powf(ceiling_db / 20.0);
        let release_ms = 50.0;
        let release_samples = release_ms * sample_rate / 1000.0;
        let release_coeff = (-2.2 / release_samples).exp();

        Self {
            ceiling_linear,
            release_coeff,
            gain_reduction: 1.0,
        }
    }

    /// Process samples in-place
    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            let input_abs = sample.abs();

            if input_abs > self.ceiling_linear {
                // Instant attack: calculate required gain reduction
                let required_gr = self.ceiling_linear / input_abs;
                if required_gr < self.gain_reduction {
                    self.gain_reduction = required_gr;
                }
            } else {
                // Release: smoothly return to unity
                self.gain_reduction =
                    self.gain_reduction * self.release_coeff + 1.0 * (1.0 - self.release_coeff);
                // Clamp to 1.0 max
                if self.gain_reduction > 1.0 {
                    self.gain_reduction = 1.0;
                }
            }

            *sample *= self.gain_reduction;
        }
    }
}

/// Apply post-clean dynamics processing
///
/// # Arguments
/// * `samples` - Audio samples to process in-place
/// * `sample_rate` - Audio sample rate in Hz
/// * `pre_clean_rms` - RMS measured before cleaning stages
/// * `threshold_db` - Upward compressor threshold (-40 to -10 dB)
/// * `ratio` - Upward compressor ratio (1.5 to 4.0)
pub fn apply_dynamics(
    samples: &mut [f32],
    sample_rate: f32,
    pre_clean_rms: f32,
    threshold_db: f32,
    ratio: f32,
) {
    if samples.is_empty() || pre_clean_rms <= 0.0 {
        return;
    }

    // Step 1: Upward compression
    let mut compressor = UpwardCompressor::new(sample_rate, threshold_db, ratio);
    compressor.process(samples);

    // Step 2: Makeup gain to restore pre-clean RMS
    let post_rms = measure_rms(samples);
    if post_rms > 0.0 {
        let makeup_gain = pre_clean_rms / post_rms;
        // Cap makeup gain at +12 dB to avoid extreme amplification
        let max_gain = 10.0_f32.powf(12.0 / 20.0); // ~3.98x
        let gain = makeup_gain.min(max_gain);
        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }

    // Step 3: Peak limiter at -0.3 dBFS
    let mut limiter = PeakLimiter::new(sample_rate, -0.3);
    limiter.process(samples);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_measure_rms_empty() {
        assert_eq!(measure_rms(&[]), 0.0);
    }

    #[test]
    fn test_measure_rms_sine() {
        let sample_rate = 44100.0;
        let num_samples = 44100; // 1 second
        let samples: Vec<f32> = (0..num_samples)
            .map(|i| 0.5 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / sample_rate).sin())
            .collect();
        let rms = measure_rms(&samples);
        // RMS of sine wave with amplitude A is A/sqrt(2) ≈ 0.354
        assert!((rms - 0.354).abs() < 0.01, "RMS was {}", rms);
    }

    #[test]
    fn test_upward_compressor_boosts_quiet() {
        let mut compressor = UpwardCompressor::new(44100.0, -20.0, 2.0);

        // Quiet signal well below threshold
        let mut samples: Vec<f32> = (0..4410)
            .map(|i| 0.01 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / 44100.0).sin())
            .collect();
        let pre_rms = measure_rms(&samples);

        compressor.process(&mut samples);

        let post_rms = measure_rms(&samples);
        // Should be boosted
        assert!(
            post_rms > pre_rms,
            "Expected boost: pre={}, post={}",
            pre_rms,
            post_rms
        );
    }

    #[test]
    fn test_upward_compressor_leaves_loud_alone() {
        let mut compressor = UpwardCompressor::new(44100.0, -40.0, 2.0);

        // Loud signal well above threshold
        let mut samples: Vec<f32> = (0..4410)
            .map(|i| 0.5 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / 44100.0).sin())
            .collect();
        let original = samples.clone();

        compressor.process(&mut samples);

        // Should be mostly unchanged
        let diff: f32 = samples
            .iter()
            .zip(original.iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / samples.len() as f32;
        assert!(diff < 0.01, "Loud signal changed too much: avg diff={}", diff);
    }

    #[test]
    fn test_peak_limiter_caps_output() {
        let mut limiter = PeakLimiter::new(44100.0, -0.3);
        let ceiling = 10.0_f32.powf(-0.3 / 20.0); // ~0.966

        // Signal that exceeds ceiling
        let mut samples: Vec<f32> = (0..4410)
            .map(|i| 1.5 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / 44100.0).sin())
            .collect();

        limiter.process(&mut samples);

        // No sample should exceed ceiling (with small tolerance for envelope)
        let max_abs = samples.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
        assert!(
            max_abs <= ceiling + 0.001,
            "Peak {} exceeded ceiling {}",
            max_abs,
            ceiling
        );
    }

    #[test]
    fn test_peak_limiter_quiet_passthrough() {
        let mut limiter = PeakLimiter::new(44100.0, -0.3);

        // Quiet signal well below ceiling
        let mut samples: Vec<f32> = (0..4410)
            .map(|i| 0.1 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / 44100.0).sin())
            .collect();
        let original = samples.clone();

        limiter.process(&mut samples);

        // Should be unchanged
        assert_eq!(samples, original);
    }

    #[test]
    fn test_apply_dynamics_restores_rms() {
        let sample_rate = 44100.0;
        let num_samples = 44100;

        // Simulate pre-clean signal
        let pre_samples: Vec<f32> = (0..num_samples)
            .map(|i| {
                0.3 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / sample_rate).sin()
            })
            .collect();
        let pre_rms = measure_rms(&pre_samples);

        // Simulate post-clean signal (quieter — cleaning removed energy)
        let mut post_samples: Vec<f32> = (0..num_samples)
            .map(|i| {
                0.1 * (440.0 * 2.0 * std::f32::consts::PI * i as f32 / sample_rate).sin()
            })
            .collect();

        apply_dynamics(&mut post_samples, sample_rate, pre_rms, -25.0, 2.0);

        let final_rms = measure_rms(&post_samples);
        // Final RMS should be closer to pre-clean RMS than post-clean was
        let original_gap = (pre_rms - measure_rms(&vec![0.1_f32; 1])).abs();
        let final_gap = (pre_rms - final_rms).abs();
        assert!(
            final_gap < original_gap,
            "Dynamics didn't help: pre_rms={}, final_rms={}, original_post_rms=~0.071",
            pre_rms,
            final_rms
        );
    }

    #[test]
    fn test_apply_dynamics_disabled_passthrough() {
        // When pre_clean_rms is 0, dynamics should be a no-op
        let mut samples = vec![0.5_f32; 1000];
        let original = samples.clone();

        apply_dynamics(&mut samples, 44100.0, 0.0, -25.0, 2.0);

        assert_eq!(samples, original);
    }

    #[test]
    fn test_apply_dynamics_empty() {
        let mut samples: Vec<f32> = vec![];
        apply_dynamics(&mut samples, 44100.0, 0.5, -25.0, 2.0);
        assert!(samples.is_empty());
    }
}
