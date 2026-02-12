# Silence Detection, Word Timing & Skip-Silence Playback

## Architecture Overview

### Silence Detection Pipeline

1. **Audio loading** (`vad.rs`): Track audio is mixed to a single buffer, encoded as WAV, and sent to the Rust backend
2. **Frame analysis** (`vad.rs`): Audio is split into overlapping frames (configurable: 10/20/30ms). Each frame is analyzed for:
   - **RMS energy**: Root mean square of samples — measures loudness
   - **Zero-crossing rate (ZCR)**: How often the signal crosses zero — distinguishes speech (0.1-0.3) from noise (0.4+)
3. **Adaptive thresholding**: Energy threshold is computed from the audio's own distribution (10th percentile as noise floor, 95th as peak), scaled by user sensitivity setting
4. **Smoothing**: Median filter (window=5) removes isolated false-positive/negative frames
5. **Segment extraction**: Contiguous speech/silence frames are grouped into segments, filtered by `minSegmentDuration`
6. **Padding**: Speech segments are padded (configurable) to avoid cutting into word edges
7. **Silence filtering**: Silence gaps shorter than `minSilenceDuration` are discarded — these are natural pauses within sentences
8. **UI regions**: Results populate `SilenceRegion[]` in the silence store, rendered as overlay rectangles in the waveform view

### Skip-Silence Playback

The playback store's `requestAnimationFrame` loop checks silence regions on every frame:

```
rAF loop:
  1. Compute newTime from elapsed * speed
  2. Check boundary conditions (loop, end-of-track)
  3. [NEW] If compressionEnabled:
     - Forward: getNextSpeechTime(newTime) → skip to end of silence
     - Reverse: getPrevSpeechTime(newTime) → skip to start of silence
  4. Update currentTime
  5. Manage audio source nodes (start/stop clips as needed)
```

**Silence lookup is O(log n)** via binary search on sorted, non-overlapping active regions. This adds ~0.01ms per frame — negligible.

When a skip occurs, audio source nodes are restarted at the new position using the existing `stopAllNodes()` + `createClipNode()` pattern. This happens only at silence boundaries, not every frame.

### Word Timing (Whisper)

Transcription uses whisper-rs with configurable sampling strategy:

- **Fast** (default): `Greedy { best_of: 1 }` — single-pass decoding, fastest
- **Balanced**: `BeamSearch { beam_size: 3 }` — explores 3 hypotheses per step
- **Best**: `BeamSearch { beam_size: 5 }` — explores 5 hypotheses, most accurate word boundaries

Token-level timestamps (`set_token_timestamps(true)`) provide per-word timing. Tokens are reassembled into words by detecting space-prefixed tokens.

## VAD Parameter Tuning Guide

### Parameters

| Parameter | Range | Default | What it does |
|-----------|-------|---------|-------------|
| **Sensitivity** (`energyThreshold`) | 0.01 - 0.50 | 0.15 | How much energy is needed to classify a frame as speech. Lower = more sensitive (keeps quieter audio). This scales between the noise floor and peak energy. |
| **Padding** | 0 - 500ms | 150ms | Time added before/after each speech segment. Prevents cutting into word beginnings/endings. |
| **Min Silence** (`minSilenceDuration`) | 100ms - 2000ms | 300ms | Minimum gap duration to be classified as silence. Short pauses (< this value) are kept as part of speech. |
| **Min Segment** (`minSegmentDuration`) | — | 100ms | Minimum duration for any detected segment (speech or silence). Prevents micro-segments. |
| **Frame Size** (`frameSizeMs`) | 10 / 20 / 30ms | 30ms | Analysis window size. Smaller = more temporal resolution but noisier classification. |

### Presets

| Preset | Sensitivity | Padding | Min Silence | Best for |
|--------|------------|---------|-------------|----------|
| **Gentle** | 8% | 200ms | 500ms | Podcast/studio recordings with natural pauses |
| **Moderate** | 15% | 150ms | 300ms | General purpose — most recordings |
| **Aggressive** | 25% | 100ms | 200ms | Noisy environments, removing more dead air |

### Tuning Tips

- **Too many small regions?** Increase Min Silence to merge nearby gaps
- **Cutting into words?** Increase Padding
- **Missing quiet speech?** Lower Sensitivity
- **Keeping background noise?** Raise Sensitivity
- **Frame size**: 30ms is best for most audio. Use 10ms only if you need very precise boundaries on short sounds

## Whisper Transcription Parameter Guide

| Quality | Strategy | Beam Size | Best Of | Speed | Accuracy |
|---------|----------|-----------|---------|-------|----------|
| **Fast** | Greedy | 1 | 1 | Fastest | Good for clear audio |
| **Balanced** | BeamSearch | 3 | 3 | ~2-3x slower | Better word boundaries |
| **Best** | BeamSearch | 5 | 5 | ~4-5x slower | Most accurate timing |

**Temperature** is fixed at 0.0 for deterministic output. Higher values (0.2-0.8) would add randomness to token selection — useful for creative text but not for timestamp accuracy.

**When to use higher quality**: If word boundaries are visibly misaligned (words highlighted too early/late), try Balanced or Best. The extra compute time is per-transcription, not per-playback.

## Performance Constraints & Design Decisions

### rAF Loop Budget
- Target: < 8ms per frame (leaves headroom for 60fps)
- `isInSilence()`: O(log n) binary search — ~0.01ms even with 1000 regions
- Audio restart: ~1-2ms, only at silence boundaries
- Clip boundary management: Already existing, ~0.5ms

### Memory
- `SilenceRegion[]` is lightweight (id + start + end + enabled per region)
- AudioBuffer references are shared in history snapshots (never cloned)
- Silence regions are kept sorted and merged — no duplicates

### Reactivity
- Silence region mutations during playback: The rAF loop reads `activeSilenceRegions` on each frame, which is a Vue computed. If a user drag-resizes a region, the next frame naturally picks up the change
- No debouncing needed — binary search on the computed array is fast enough

### Design Decisions
1. **Binary search over interval tree**: With sorted, non-overlapping regions, binary search is O(log n) and simpler. An interval tree would only help if regions overlapped, which `mergeOverlapping()` prevents.
2. **Restart-on-skip over pre-scheduling**: We restart audio nodes when hitting silence boundaries rather than pre-computing a silence-free schedule. This keeps the system reactive to region edits during playback.
3. **No crossfade on skip**: Silence regions by definition have near-zero energy at boundaries, so clicks are unlikely. A crossfade would add complexity for minimal benefit.
4. **Seek snaps forward**: When skip-silence is enabled and you seek into a silence region, the playhead snaps to the end of that region (forward). This matches the mental model that silence "doesn't exist" during skip mode.
