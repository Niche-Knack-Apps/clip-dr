//! IIR filters for band-limiting and notch filtering
//!
//! Uses biquad filters for efficient real-time processing.

use biquad::{Biquad, Coefficients, DirectForm1, ToHertz, Type, Q_BUTTERWORTH_F32};

/// Band limiter combining high-pass and low-pass filters
pub struct BandLimiter {
    highpass: Option<[DirectForm1<f32>; 2]>,
    lowpass: Option<[DirectForm1<f32>; 2]>,
}

impl BandLimiter {
    /// Create a new band limiter
    ///
    /// Uses cascaded 2nd-order filters for 4th-order (24 dB/octave) slopes
    pub fn new(
        sample_rate: f32,
        highpass_freq: Option<f32>,
        lowpass_freq: Option<f32>,
    ) -> Result<Self, String> {
        let highpass = if let Some(freq) = highpass_freq {
            let coeffs = Coefficients::<f32>::from_params(
                Type::HighPass,
                sample_rate.hz(),
                freq.hz(),
                Q_BUTTERWORTH_F32,
            )
            .map_err(|e| format!("Failed to create highpass coefficients: {:?}", e))?;

            Some([
                DirectForm1::<f32>::new(coeffs),
                DirectForm1::<f32>::new(coeffs),
            ])
        } else {
            None
        };

        let lowpass = if let Some(freq) = lowpass_freq {
            let coeffs = Coefficients::<f32>::from_params(
                Type::LowPass,
                sample_rate.hz(),
                freq.hz(),
                Q_BUTTERWORTH_F32,
            )
            .map_err(|e| format!("Failed to create lowpass coefficients: {:?}", e))?;

            Some([
                DirectForm1::<f32>::new(coeffs),
                DirectForm1::<f32>::new(coeffs),
            ])
        } else {
            None
        };

        Ok(Self { highpass, lowpass })
    }

    /// Process samples in-place through the band-limiting filters
    pub fn process(&mut self, samples: &mut [f32]) {
        // Apply highpass (2x for 4th order)
        if let Some(ref mut filters) = self.highpass {
            for sample in samples.iter_mut() {
                *sample = filters[0].run(*sample);
            }
            for sample in samples.iter_mut() {
                *sample = filters[1].run(*sample);
            }
        }

        // Apply lowpass (2x for 4th order)
        if let Some(ref mut filters) = self.lowpass {
            for sample in samples.iter_mut() {
                *sample = filters[0].run(*sample);
            }
            for sample in samples.iter_mut() {
                *sample = filters[1].run(*sample);
            }
        }
    }
}

/// Notch filter bank for removing mains hum and harmonics
pub struct HumRemover {
    notches: Vec<DirectForm1<f32>>,
}

impl HumRemover {
    /// Create a hum remover for the specified mains frequency
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `mains_freq` - Mains frequency (50 or 60 Hz)
    /// * `harmonics` - Number of harmonics to remove (1-4)
    pub fn new(sample_rate: f32, mains_freq: f32, harmonics: u32) -> Result<Self, String> {
        let q = 30.0; // Narrow Q for precise notch
        let mut notches = Vec::new();

        for h in 1..=(harmonics.min(4)) {
            let freq = mains_freq * h as f32;

            // Skip if frequency is above Nyquist
            if freq >= sample_rate / 2.0 {
                continue;
            }

            let coeffs = Coefficients::<f32>::from_params(
                Type::Notch,
                sample_rate.hz(),
                freq.hz(),
                q,
            )
            .map_err(|e| format!("Failed to create notch coefficients at {} Hz: {:?}", freq, e))?;

            notches.push(DirectForm1::<f32>::new(coeffs));
        }

        Ok(Self { notches })
    }

    /// Process samples in-place through all notch filters
    pub fn process(&mut self, samples: &mut [f32]) {
        for notch in self.notches.iter_mut() {
            for sample in samples.iter_mut() {
                *sample = notch.run(*sample);
            }
        }
    }
}

/// Detect whether audio contains 50Hz or 60Hz mains hum
///
/// Analyzes energy at mains frequencies and their harmonics
pub fn detect_mains_frequency(samples: &[f32], sample_rate: f32) -> f32 {
    use realfft::RealFftPlanner;

    // Use a reasonable FFT size for frequency resolution
    let fft_size = 8192;

    if samples.len() < fft_size {
        return 60.0; // Default to 60Hz for short samples
    }

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);

    // Use first portion of audio
    let mut buffer: Vec<f32> = samples.iter().take(fft_size).copied().collect();
    buffer.resize(fft_size, 0.0);

    // Apply Hann window
    for (i, sample) in buffer.iter_mut().enumerate() {
        let window = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / fft_size as f32).cos());
        *sample *= window;
    }

    let mut spectrum = fft.make_output_vec();
    fft.process(&mut buffer, &mut spectrum).ok();

    let freq_resolution = sample_rate / fft_size as f32;

    // Calculate energy at 50Hz and 60Hz fundamental + harmonics
    let mut energy_50 = 0.0f32;
    let mut energy_60 = 0.0f32;

    for h in 1..=4 {
        // 50Hz harmonics: 50, 100, 150, 200
        let bin_50 = (50.0 * h as f32 / freq_resolution).round() as usize;
        if bin_50 < spectrum.len() {
            energy_50 += spectrum[bin_50].norm_sqr();
        }

        // 60Hz harmonics: 60, 120, 180, 240
        let bin_60 = (60.0 * h as f32 / freq_resolution).round() as usize;
        if bin_60 < spectrum.len() {
            energy_60 += spectrum[bin_60].norm_sqr();
        }
    }

    // Return whichever has more energy (with 50Hz bias if similar)
    if energy_50 > energy_60 * 1.2 {
        50.0
    } else {
        60.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_band_limiter_creation() {
        let limiter = BandLimiter::new(44100.0, Some(80.0), Some(8000.0));
        assert!(limiter.is_ok());
    }

    #[test]
    fn test_hum_remover_creation() {
        let remover = HumRemover::new(44100.0, 60.0, 4);
        assert!(remover.is_ok());
    }

    #[test]
    fn test_band_limiter_process() {
        let mut limiter = BandLimiter::new(44100.0, Some(80.0), Some(8000.0)).unwrap();
        let mut samples = vec![0.5f32; 1000];
        limiter.process(&mut samples);
        // Just verify it runs without panic
    }
}
