//! Downward expander for gentle noise reduction
//!
//! Unlike a hard gate, a downward expander gradually reduces gain below the threshold.

/// Downward expander with envelope following
pub struct DownwardExpander {
    threshold_linear: f32,
    ratio: f32,
    attack_coeff: f32,
    release_coeff: f32,
    envelope: f32,
}

impl DownwardExpander {
    /// Create a new downward expander
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `threshold_db` - Threshold in dB (typically -60 to -20)
    /// * `ratio` - Expansion ratio (typically 1.5 to 4.0)
    /// * `attack_ms` - Attack time in milliseconds
    /// * `release_ms` - Release time in milliseconds
    pub fn new(
        sample_rate: f32,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
    ) -> Self {
        // Convert dB threshold to linear
        let threshold_linear = 10.0_f32.powf(threshold_db / 20.0);

        // Calculate envelope follower coefficients
        // Time constant: samples = time_ms * sample_rate / 1000
        let attack_samples = attack_ms * sample_rate / 1000.0;
        let release_samples = release_ms * sample_rate / 1000.0;

        // Exponential smoothing coefficients
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

    /// Process samples in-place through the expander
    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            // Get absolute value for envelope detection
            let input_abs = sample.abs();

            // Envelope follower (peak detector with attack/release)
            let coeff = if input_abs > self.envelope {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.envelope = self.envelope * coeff + input_abs * (1.0 - coeff);

            // Calculate gain reduction
            let gain = if self.envelope < self.threshold_linear && self.envelope > 0.0 {
                // Below threshold: apply expansion
                // Expansion formula: gain = (envelope / threshold) ^ (1 - 1/ratio)
                let db_below = 20.0 * (self.envelope / self.threshold_linear).log10();
                let db_reduction = db_below * (1.0 - 1.0 / self.ratio);
                10.0_f32.powf(db_reduction / 20.0)
            } else {
                1.0
            };

            // Apply gain
            *sample *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expander_creation() {
        let expander = DownwardExpander::new(44100.0, -40.0, 2.0, 5.0, 50.0);
        assert!(expander.threshold_linear > 0.0);
    }

    #[test]
    fn test_expander_loud_signal() {
        let mut expander = DownwardExpander::new(44100.0, -40.0, 2.0, 5.0, 50.0);

        // Loud signal (above threshold) should pass through mostly unchanged
        let mut samples: Vec<f32> = (0..1000)
            .map(|i| 0.5 * (i as f32 * 0.1).sin())
            .collect();
        let original_energy: f32 = samples.iter().map(|s| s * s).sum();

        expander.process(&mut samples);

        let processed_energy: f32 = samples.iter().map(|s| s * s).sum();

        // Energy should be mostly preserved for loud signals
        assert!(processed_energy > original_energy * 0.8);
    }

    #[test]
    fn test_expander_quiet_signal() {
        let mut expander = DownwardExpander::new(44100.0, -20.0, 4.0, 1.0, 50.0);

        // Very quiet signal (well below threshold) should be reduced
        let mut samples: Vec<f32> = (0..1000)
            .map(|i| 0.001 * (i as f32 * 0.1).sin())
            .collect();
        let original_energy: f32 = samples.iter().map(|s| s * s).sum();

        expander.process(&mut samples);

        let processed_energy: f32 = samples.iter().map(|s| s * s).sum();

        // Energy should be reduced for quiet signals
        assert!(processed_energy < original_energy);
    }
}
