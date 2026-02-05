//! Audio cleaning pipeline orchestration
//!
//! Coordinates all cleaning stages in the correct order.

use serde::{Deserialize, Serialize};

use super::filters::{BandLimiter, HumRemover, detect_mains_frequency};
use super::spectral::SpectralDenoiser;
use super::neural::NeuralDenoiser;
use super::expander::DownwardExpander;

/// Cleaning options that control each pipeline stage
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleaningOptions {
    /// Enable high-pass filter
    pub highpass_enabled: bool,
    /// High-pass frequency (40-150 Hz)
    pub highpass_freq: f32,

    /// Enable low-pass filter
    pub lowpass_enabled: bool,
    /// Low-pass frequency (5000-12000 Hz)
    pub lowpass_freq: f32,

    /// Enable notch filters for mains hum
    pub notch_enabled: bool,
    /// Mains frequency detection mode
    pub mains_frequency: MainsFrequency,
    /// Number of harmonics to remove (1-4)
    pub notch_harmonics: u32,

    /// Enable spectral noise suppression
    pub spectral_enabled: bool,
    /// Noise reduction amount (0-24 dB)
    pub noise_reduction_db: f32,

    /// Enable neural denoising (RNNoise)
    pub neural_enabled: bool,
    /// Neural denoise strength (0-1)
    pub neural_strength: f32,

    /// Enable downward expander
    pub expander_enabled: bool,
    /// Expander threshold (-60 to -20 dB)
    pub expander_threshold_db: f32,
    /// Expander ratio (1.5-4)
    pub expander_ratio: f32,
}

/// Mains frequency detection mode
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MainsFrequency {
    Auto,
    Hz50,
    Hz60,
}

impl Default for CleaningOptions {
    fn default() -> Self {
        Self {
            highpass_enabled: true,
            highpass_freq: 80.0,
            lowpass_enabled: true,
            lowpass_freq: 8000.0,
            notch_enabled: true,
            mains_frequency: MainsFrequency::Auto,
            notch_harmonics: 4,
            spectral_enabled: true,
            noise_reduction_db: 12.0,
            neural_enabled: true,
            neural_strength: 0.8,
            expander_enabled: true,
            expander_threshold_db: -40.0,
            expander_ratio: 2.0,
        }
    }
}

/// Silence segment for spectral noise profiling
#[derive(Debug, Clone)]
pub struct SilenceSegment {
    pub start_sample: usize,
    pub end_sample: usize,
}

/// Process audio through the cleaning pipeline
///
/// # Arguments
/// * `samples` - Mutable audio samples to process in-place
/// * `sample_rate` - Audio sample rate in Hz
/// * `options` - Cleaning options controlling each stage
/// * `silence_segments` - Optional silence segments for noise profiling
pub fn process_audio(
    samples: &mut [f32],
    sample_rate: f32,
    options: &CleaningOptions,
    silence_segments: Option<&[SilenceSegment]>,
) -> Result<(), String> {
    // Process in chunks for large files to manage memory
    const CHUNK_SIZE: usize = 44100 * 60; // 1 minute at 44.1kHz

    if samples.len() <= CHUNK_SIZE {
        process_chunk(samples, sample_rate, options, silence_segments)
    } else {
        // Process large files in overlapping chunks
        let overlap = 4096;
        let mut pos = 0;

        while pos < samples.len() {
            let end = (pos + CHUNK_SIZE).min(samples.len());
            let chunk = &mut samples[pos..end];

            // Convert silence segments to chunk-local coordinates
            let chunk_silence: Vec<SilenceSegment> = silence_segments
                .map(|segs| {
                    segs.iter()
                        .filter_map(|seg| {
                            if seg.end_sample > pos && seg.start_sample < end {
                                Some(SilenceSegment {
                                    start_sample: seg.start_sample.saturating_sub(pos),
                                    end_sample: (seg.end_sample - pos).min(chunk.len()),
                                })
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();

            let chunk_silence_ref: Option<&[SilenceSegment]> = if chunk_silence.is_empty() {
                None
            } else {
                Some(&chunk_silence)
            };

            process_chunk(chunk, sample_rate, options, chunk_silence_ref)?;

            // Crossfade overlap region with previous chunk
            if pos > 0 && pos < samples.len() {
                let fade_len = overlap.min(end - pos);
                for i in 0..fade_len {
                    let fade = i as f32 / fade_len as f32;
                    // The overlap region is already processed, just ensure smooth transition
                    samples[pos + i] *= fade;
                }
            }

            pos = end - overlap;
            if pos + overlap >= samples.len() {
                break;
            }
        }

        Ok(())
    }
}

/// Process a single chunk of audio through all enabled stages
fn process_chunk(
    samples: &mut [f32],
    sample_rate: f32,
    options: &CleaningOptions,
    silence_segments: Option<&[SilenceSegment]>,
) -> Result<(), String> {
    // Stage 1: Band-limiting filters (IIR - very fast)
    if options.highpass_enabled || options.lowpass_enabled {
        let highpass = if options.highpass_enabled {
            Some(options.highpass_freq)
        } else {
            None
        };
        let lowpass = if options.lowpass_enabled {
            Some(options.lowpass_freq)
        } else {
            None
        };

        let mut limiter = BandLimiter::new(sample_rate, highpass, lowpass)?;
        limiter.process(samples);
    }

    // Stage 2: Notch filters for mains hum (IIR - very fast)
    if options.notch_enabled {
        let mains_freq = match options.mains_frequency {
            MainsFrequency::Hz50 => 50.0,
            MainsFrequency::Hz60 => 60.0,
            MainsFrequency::Auto => detect_mains_frequency(samples, sample_rate),
        };

        let mut hum_remover = HumRemover::new(sample_rate, mains_freq, options.notch_harmonics)?;
        hum_remover.process(samples);
    }

    // Stage 3: Spectral noise suppression (FFT-based)
    if options.spectral_enabled {
        let mut denoiser = SpectralDenoiser::new(2048, options.noise_reduction_db);

        // Estimate noise profile
        let silence_tuples: Vec<(usize, usize)> = silence_segments
            .map(|segs| {
                segs.iter()
                    .map(|seg| (seg.start_sample, seg.end_sample))
                    .collect()
            })
            .unwrap_or_default();

        denoiser.estimate_noise_profile(samples, &silence_tuples);
        denoiser.process(samples);
    }

    // Stage 4: Neural denoise (RNNoise via nnnoiseless)
    if options.neural_enabled && options.neural_strength > 0.0 {
        let neural = NeuralDenoiser::new(sample_rate, options.neural_strength);
        neural.process(samples)?;
    }

    // Stage 5: Downward expander (gentle gate)
    if options.expander_enabled {
        let mut expander = DownwardExpander::new(
            sample_rate,
            options.expander_threshold_db,
            options.expander_ratio,
            5.0,   // 5ms attack
            50.0,  // 50ms release
        );
        expander.process(samples);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_options() {
        let options = CleaningOptions::default();
        assert!(options.highpass_enabled);
        assert!(options.lowpass_enabled);
        assert!(options.notch_enabled);
        assert!(options.spectral_enabled);
        assert!(options.neural_enabled);
        assert!(options.expander_enabled);
    }

    #[test]
    fn test_process_audio_empty() {
        let mut samples: Vec<f32> = vec![];
        let options = CleaningOptions::default();
        let result = process_audio(&mut samples, 44100.0, &options, None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_process_audio_basic() {
        // Generate test signal
        let sample_rate = 44100.0;
        let duration = 0.1; // 100ms
        let num_samples = (sample_rate * duration) as usize;

        let mut samples: Vec<f32> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate;
                // Mix of 440Hz tone and noise
                0.3 * (440.0 * 2.0 * std::f32::consts::PI * t).sin()
                    + 0.1 * (i as f32 * 0.1).sin()
            })
            .collect();

        let options = CleaningOptions {
            neural_enabled: false, // Skip neural for faster tests
            ..CleaningOptions::default()
        };

        let result = process_audio(&mut samples, sample_rate, &options, None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_process_audio_all_disabled() {
        let mut samples = vec![0.5f32; 1000];
        let original = samples.clone();

        let options = CleaningOptions {
            highpass_enabled: false,
            lowpass_enabled: false,
            notch_enabled: false,
            spectral_enabled: false,
            neural_enabled: false,
            expander_enabled: false,
            ..CleaningOptions::default()
        };

        let result = process_audio(&mut samples, 44100.0, &options, None);
        assert!(result.is_ok());

        // With all stages disabled, samples should be unchanged
        assert_eq!(samples, original);
    }
}
