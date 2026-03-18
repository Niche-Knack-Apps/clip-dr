# Clip Dr. v0.20.0 — Waveform Sync, Dynamics, Export Trim, Clean Playback, Transcription Slider

## Context

Five interlinked issues need holistic fixes to ensure rock-solid synchronization project-wide:
1. Waveform desync across the three views (FullWaveform, ZoomedWaveform, TrackLane) and audio playback
2. Volume increase sounds tinny — needs intelligent dynamics processing instead of simple gain
3. Single-track export includes leading/trailing silence instead of trimming to audio boundaries
4. Cleaned audio track is not playable; needs to also auto-mute all other tracks and reposition playhead
5. Transcription global offset slider is broken (no-ops when no track explicitly selected)

## Git Workflow

1. Merge any pending work into `main` (currently clean — nothing unmerged)
2. Create branch `dev/v0.20-sync-dynamics` from `main`
3. Bump version to `0.20.0` in `package.json` and `src-tauri/tauri.conf.json`
4. Implement each fix as a separate commit, incrementing bugfix version (0.20.1, 0.20.2, etc.)
5. Run ALL regression tests after each change (`npx vue-tsc --noEmit 2>&1 | grep -v TS6133` + `npm test` + `cargo build` for Rust changes)
6. Write NEW regression tests for each feature
7. Pause after each commit for user manual testing before proceeding

---

## Fix 6: selectedTrack auto-resolve + Settings version → v0.20.5

**Problem 1 — selectedTrack**: `tracksStore.selectedTrack` (computed, `tracks.ts:96-101`) returns `null` when `selectedTrackId === 'ALL'` (the default). This breaks every operation that depends on it:
- **Cleaning**: `canClean` is false, `cleanSelectedTrack()` early-returns with "No track selected"
- **Silence detection**: `detectSilence()` falls back to `tracks[0]` silently (non-obvious)
- **Silence cutting**: `cutSilenceToNewTrack()` falls back to `tracks[0]`

Same root cause as Fix 5 (transcription slider), but Fix 5 was component-local. This fix goes to the source.

**Problem 2 — Settings version**: `src/views/SettingsView.vue` line 15 has `APP_VERSION = '0.19.38'` hardcoded.

### Fix approach — selectedTrack auto-resolve

Modify the `selectedTrack` computed in `src/stores/tracks.ts` (lines 96-101) to auto-resolve when exactly one track exists:

```typescript
const selectedTrack = computed(() => {
  if (selectedTrackId.value === 'ALL' || selectedTrackId.value === null) {
    // Auto-resolve: if exactly one track exists, use it
    if (tracks.value.length === 1) return tracks.value[0];
    return null;
  }
  return getTrackById(selectedTrackId.value) ?? null;
});
```

**Why `tracks.length === 1` and not per-feature filtering**: Unlike the transcription slider (which filters for "tracks with transcription"), cleaning and silence detection work on *any* track. The unambiguous case is simply "there's only one track." With multiple tracks, the user must explicitly select one — this matches DAW convention.

**No changes needed** to `cleaning.ts`, `vad.ts`, or `silence.ts` — they all read `tracksStore.selectedTrack`, so the fix propagates automatically.

### Files to modify
- **`src/stores/tracks.ts`** (line 96-101): Auto-resolve `selectedTrack` when single track
- **`src/views/SettingsView.vue`** (line 15): Update `APP_VERSION` to `'0.20.5'`

### Edge cases
- Single track + 'ALL' selection: auto-resolves → cleaning/silence work
- Multiple tracks + 'ALL' selection: returns null → user must select (correct, avoids wrong-track cleaning)
- Explicit track selection: unchanged behavior
- Zero tracks: returns null → operations correctly disabled

### New tests (add to existing `src/__tests__/clean-playback.test.ts`)
- `selectedTrack` auto-resolves to single track when selection is 'ALL'
- `selectedTrack` returns null when multiple tracks and selection is 'ALL'

---

## Fix 2: Intelligent Dynamics Processing (Volume/Loudness) → v0.20.6+

**Problem**: Cleaning pipeline is purely subtractive (5 gain-reduction stages). No loudness compensation. Simple gain boost creates tinny, over-processed sound.

**This fix is split into two stages** due to implementation scope and verification risk.

### Stage A (v0.20.6): Conservative gain compensation + simple compressor/limiter

A simpler post-clean processing stage that addresses the core complaint without requiring full LUFS measurement infrastructure.

**New file: `src-tauri/src/audio_clean/dynamics.rs`**:
- `RmsLoudness` struct: measure RMS loudness of signal (simple, well-understood)
- `UpwardCompressor` struct: envelope follower with configurable attack/release, threshold, ratio. Boosts quiet passages while leaving loud passages untouched
- `PeakLimiter` struct: sample-accurate brickwall limiter with fast attack and slow release. Prevents clipping after gain compensation. No oversampling in this stage (keeps implementation straightforward)
- `DynamicsProcessor` struct: orchestrates the flow:
  1. Measure pre-processing RMS
  2. Apply upward compression
  3. Apply makeup gain to restore loudness
  4. Run peak limiter to prevent clipping

**Pipeline integration** (`src-tauri/src/audio_clean/pipeline.rs`):
- Add to `CleaningOptions`: `dynamics_enabled: bool`, `upward_compression_threshold_db: f32`, `upward_compression_ratio: f32`
- Defaults: `dynamics_enabled: true, threshold: -25 dB, ratio: 2.0`
- Stage 6 runs after stages 1-5 as a full-signal pass (not chunked, since it needs pre/post RMS comparison)

**Frontend changes**:
- `src/shared/types.ts`: Add dynamics fields to `CleaningOptions`
- `src/shared/constants.ts`: Add defaults, update presets (podcast/interview: dynamics on, hum-only: dynamics off)
- `src/stores/cleaning.ts`: Pass new fields in `backendOptions`
- `src/components/cleaning/CleaningPanel.vue`: Add "Dynamics" toggle + threshold/ratio sliders

**Rust tests**:
- Upward compressor: quiet signal boosted, loud signal unchanged
- Peak limiter: output never exceeds ceiling
- Full pipeline: cleaned audio is fuller, no clipping

### Stage B (future milestone): LUFS + true-peak + polished UI

Deferred to a dedicated feature milestone after v0.20.x stabilizes:
- LUFS measurement per ITU-R BS.1770-4 with K-weighting and gating
- True-peak limiter with 4x oversampling (inter-sample peak detection)
- Target LUFS selection (-23 broadcast, -16 podcast, -14 YouTube)
- Multi-band dynamics (optional)
- Stricter DSP reference testing with known calibration signals

---

## Implementation Order

| Step | Fix | Version | Description | Status |
|------|-----|---------|-------------|--------|
| 0 | Setup | 0.20.0 | Create dev branch, bump version | DONE |
| 1 | Fix 5 | 0.20.1 | Transcription slider auto-resolve | DONE |
| 2 | Fix 3 | 0.20.2 | Export trim (rebaseEdlToZero) | DONE |
| 3 | Fix 4 | 0.20.3 | Clean playback + mute-all + playhead | DONE |
| 4 | Fix 1 | 0.20.4 | Sync epoch (5 files) | DONE |
| 5 | Fix 6 | 0.20.5 | selectedTrack auto-resolve + settings version | **NEXT** |
| 6 | Fix 2A | 0.20.6 | Conservative dynamics (Rust + TS/Vue) | Pending |
| — | Stop | — | Validate entire train thoroughly | — |
| 7 | Fix 4+ | 0.20.7 | Clip-level cleaning (deferred) | Pending |
| 8 | Fix 2B | future | Full LUFS + true-peak | Deferred |

**Current state**: 214 tests passing, version 0.20.4, branch `dev/v0.20-sync-dynamics`.

## Verification After Each Step

1. `npx vue-tsc --noEmit 2>&1 | grep -v TS6133` — type check
2. `npm test` — all regression tests pass (currently 214)
3. `cargo build` (in src-tauri) — for any Rust changes
4. Manual testing by user before proceeding to next step

## Key Files Reference

| File | Role |
|------|------|
| `src/components/transcription/WordTimeline.vue` | Fix 5: slider auto-resolve |
| `src/stores/export.ts` | Fix 3: EDL rebase for single-track |
| `src/stores/cleaning.ts` | Fix 4: sourcePath, mute-all, playhead |
| `src/stores/tracks.ts` | Fix 4: muteAllExcept; Fix 1: syncEpoch; Fix 6: selectedTrack |
| `src/composables/useCompositeWaveform.ts` | Fix 1: waveformVersion + epoch |
| `src/stores/playback.ts` | Fix 1: live re-sync watcher |
| `src/components/tracks/ClipRegion.vue` | Fix 1: epoch-aware cache invalidation |
| `src/composables/useWaveform.ts` | Fix 1: tile cache epoch |
| `src/views/SettingsView.vue` | Fix 6: APP_VERSION update |
| `src-tauri/src/audio_clean/dynamics.rs` | Fix 2A: new dynamics module |
| `src-tauri/src/audio_clean/pipeline.rs` | Fix 2A: stage 6 integration |
| `src/shared/types.ts` | Fix 2A: CleaningOptions extension |
| `src/shared/constants.ts` | Fix 2A: defaults + presets |
| `src/components/cleaning/CleaningPanel.vue` | Fix 2A: dynamics UI |
