# Clip Dr Investigation Report

## 1. Executive Summary

After tracing through all relevant code paths (playback transport, recording pipeline, import/track placement, waveform rendering, click handlers, and export pipeline), three concrete root causes have been identified for the reported issues. The bugs are largely independent, but share a common theme: the application uses multiple independent timing/audio pipelines that do not always agree.

**Issue A (click-to-seek intermittent):** `ClipRegion.vue` calls `stopPropagation()` on every mousedown, so clicks on clips (which cover most of the timeline) never reach `TrackLane`'s seek handler. Sub-threshold clicks become "clip select" instead of seeks.

**Issue B (recording offset):** When a recording has pre-record buffer audio prepended, the frontend never subtracts `pre_record_seconds` from the track start position. The WAV file starts with up to 10 seconds of pre-roll audio, but the timeline treats sample 0 as the moment recording was requested.

**Issue C (export quality degradation):** The JS fallback export path uses `encodeWav()` which converts to **16-bit PCM**, while the Rust playback engine works with **32-bit float** throughout. This 16-bit quantization is the most likely cause of audible quality loss. Additionally, the JS fallback path applies peak normalization (scaling down if any sample exceeds 1.0) which changes the gain staging relative to playback.

**Fix priority:** C (export quality) > A (click-to-seek) > B (recording offset)

---

## 2. Architecture Map

### UI Interaction Layer
- `FullWaveform.vue` -- top overview waveform, click handler at line 225
- `ZoomedWaveform.vue` -- zoomed detail view
- `TrackLane.vue` -- per-track timeline row, click handler at line 101
- `ClipRegion.vue` -- per-clip display within TrackLane
- `SelectionWindow.vue` -- selection overlay (z-index 15, captures mousedown)
- `Playhead.vue` -- playhead line with drag handle (z-index 20, 12px wide hit zone)

### Timeline Model
- `tracksStore` (Pinia) -- `tracks[]`, `timelineDuration`, `getTrackClips()`
- `selectionStore` (Pinia) -- `selection.start/end`, `inOutPoints`
- Each Track has `trackStart`, `duration`; each clip has `clipStart`, `duration`, `sourceOffset`

### Playback Transport
- **Frontend:** `playbackStore` -- `isPlaying`, `currentTime`, `seek()`, `play()`, `pause()`
- **Backend:** `PlaybackEngine` (Rust) -- `position: AtomicU64`, `playing: AtomicBool`
- **Audio callback:** cpal output stream in `playback.rs` line 1116-1317
- Position polling: `requestAnimationFrame` loop calling `playback_get_position` IPC

### Recording Pipeline
- `recording.ts` store -- `startRecording()`, `stopRecording()`, `createTrackFromRecording()`
- `recording/mod.rs` -- cpal input stream, ring buffer, WAV writer
- Pre-record buffer: `PreRecordBuffer` (10s ring buffer filled during monitoring)
- Track creation: delegates to `audioStore.importFile(segPath, segTrackStart)`

### Waveform Generation
- Rust `import_audio_start` -> waveform chunks -> `import-waveform-chunk` events
- Frontend `createImportingTrack` with progressive fill-in
- ClipRegion draws waveform from `track.audioData.waveformData` or hi-res extraction from AudioBuffer

### Export Pipeline
- **EDL path** (primary): `buildEdl()` in `export.ts` -> `export_edl` Rust command -> `mix_chunk()` -> WAV/MP3/FLAC/OGG
- **JS fallback path**: `mixActiveTracks()` -> `encodeWav()` (16-bit!) -> write temp WAV -> Rust convert
- **Single track export**: `exportTrackWithProfile()` -> same two paths

---

## 3. Issue A -- Intermittent Click-to-Seek

### Symptoms
Clicking in the waveform/timeline during playback sometimes moves the playhead, sometimes does not.

### Relevant Code Paths

**Click handlers that should trigger seek:**

1. `FullWaveform.vue:225` `handleWaveformClick()` -- maps clientX to time, calls `playbackStore.seek()`
2. `TrackLane.vue:101` `handleTimelineClick()` -- maps clientX to time within timeline, calls `playbackStore.seek()`
3. `Playhead.vue` -- drag handler calls `playbackStore.scrub()` (different path)

**The `seek()` function in `playbackStore` (line 322-340):**
```typescript
async function seek(time: number): Promise<void> {
    const wasPlaying = isPlaying.value;
    if (wasPlaying) {
      pause();           // (1) pause first
    }
    let seekTime = Math.max(0, Math.min(time, getEffectiveDuration()));
    if (silenceStore.compressionEnabled) {
      seekTime = silenceStore.getNextSpeechTime(seekTime);
    }
    currentTime.value = seekTime;  // (2) update JS state
    if (wasPlaying) {
      await play();      // (3) restart playback
    }
}
```

**The `play()` function (line 248-293):**
```typescript
async function play(): Promise<void> {
    if (isPlaying.value) return;   // *** GUARD ***
    // ...
    isPlaying.value = true;
    // ... syncTracksToRust, syncLoopToRust, playback_set_speed, playback_set_volume ...
    await invoke('playback_seek', { position: playStart });
    await invoke('playback_play');
    startPositionPoll();
}
```

### Likely Root Causes (ranked by likelihood)

#### Root Cause A1: Click Events Swallowed by Overlapping Elements (HIGH confidence)

The ClipRegion component has `@mousedown="handleMouseDown"` and `@click.stop` on line 294. The `handleMouseDown` calls `event.stopPropagation()` and `event.preventDefault()` on **every** mousedown. This means:

- `ClipRegion.vue:271-276`:
  ```typescript
  function handleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();   // <--- blocks parent click
    emit('dragStart', clipId.value, event);
  }
  ```

The clip region is positioned absolutely within the TrackLane container. When the user clicks on a clip, the click is captured by ClipRegion, which stops propagation. The TrackLane's `handleTimelineClick` never fires.

The clip drag system uses a 5px threshold (`DRAG_THRESHOLD = 5`). If the mouse doesn't move 5px, `handleClipDragEnd` fires and emits `clipSelect` (not `seek`). The `clipSelect` handler in TrackList (line 382-388) only changes track/clip selection -- **it does not seek**.

**This is the primary cause.** When the user clicks on a clip during playback intending to seek, the click is swallowed by the clip's mousedown handler, and the resulting action is "select clip" rather than "seek to position."

Clicking on **empty space** in the TrackLane (outside any clip) works because no ClipRegion intercepts it. This explains the intermittent behavior: it depends on whether the click lands on a clip region or on empty timeline space.

#### Root Cause A2: Playhead Hit Zone Interference (MEDIUM confidence)

`Playhead.vue` has a 12px-wide hit zone (line 115: `width: draggable ? '12px' : '2px'`) at z-index 20. If the user clicks near the playhead position, the Playhead's mousedown handler intercepts the event and starts a drag operation instead of allowing the click to reach the waveform/timeline click handler.

The playhead calls `event.stopPropagation()` and `event.preventDefault()` (line 59) and emits `dragStart` which calls `playbackStore.startScrubbing()`. A brief click-and-release on the playhead would go through the scrub path, which:
1. Sets `isScrubbing = true`
2. Pauses if playing
3. Then on mouseup, calls `endScrubbing()` which sets `isScrubbing = false` but does NOT resume playback

So if the user clicks near the playhead, playback stops and the position might snap to the playhead's current position rather than the clicked position.

#### Root Cause A3: Seek Pause-Play Race (MEDIUM confidence)

The `seek()` function calls `pause()` synchronously (fire-and-forget -- `pause()` calls `invoke('playback_pause').catch(...)` without await), then immediately sets `currentTime.value`, then calls `await play()`.

Inside `play()`, there's the guard `if (isPlaying.value) return;`. But `pause()` sets `isPlaying.value = false` synchronously, so this guard is fine. However, `play()` does a sequence of async operations:
1. `syncTracksToRust()` -- potentially loads files (can be slow)
2. `syncLoopToRust()`
3. `playback_set_speed`
4. `playback_set_volume`
5. `playback_seek({ position: playStart })`
6. `playback_play`

The position clamping at line 277-280 may override the seek target:
```typescript
let playStart = currentTime.value;
if (playStart < region.start || playStart >= region.end) {
  playStart = playbackSpeed.value >= 0 ? region.start : region.end;
  currentTime.value = playStart;
}
```
If `getActiveRegion()` returns an unexpected region (e.g., a muted track's region), the seek position could get clamped away from the user's intended position.

#### Root Cause A4: Position Poll Overwrite (LOW confidence)

During playback, the position poll runs via `requestAnimationFrame` and reads position from Rust's `playback_get_position`. There's a theoretical race: if the poll fires between `pause()` and the new `play()`, it could overwrite `currentTime.value` with the old Rust position. However, `pause()` stops the poll via `stopPositionPoll()`, so this is unlikely unless there's a queued rAF callback that fires after `stopPositionPoll()`.

### Evidence
- `ClipRegion.vue:271-276` -- `stopPropagation()` on every mousedown, preventing parent click handler
- `ClipRegion.vue:294` -- `@click.stop` on the element, double-blocking
- `TrackLane.vue:101-108` -- `handleTimelineClick` guard: `if (isClipDragging.value || clipDragPending.value) return;` -- if clipDragPending is true from the mousedown, even a quick click-release gets filtered

### Recommended Fixes

**Fix A1 (targeted):** In `TrackLane.vue`'s `handleClipDragEnd`, when the drag threshold was NOT met (it was a click, not a drag), seek to the clicked position in addition to selecting the clip:
```typescript
} else if (!wasDragging && clipId) {
  // Drag threshold not met - this was a click
  emit('clipSelect', props.track.id, clipId);
  // Also seek to the clicked position
  const rect = containerRef.value?.getBoundingClientRect();
  if (rect && duration.value > 0) {
    const time = ((event.clientX - rect.left) / rect.width) * duration.value;
    playbackStore.seek(Math.max(0, Math.min(duration.value, time)));
  }
}
```

**Fix A2 (targeted):** Reduce the Playhead hit zone from 12px to 6px, or make the Playhead not intercept clicks when not actively dragging.

**Architectural fix:** Separate "click to position" from "click to select clip". Use Alt+click or double-click for clip selection, and always seek on single click. This matches DAW conventions (Pro Tools, Reaper).

### Recommended Instrumentation

Add to `TrackLane.vue`'s `handleTimelineClick`:
```typescript
console.log('[TrackLane] handleTimelineClick:', { button: event.button, isClipDragging: isClipDragging.value, clipDragPending: clipDragPending.value, target: event.target });
```

Add to `ClipRegion.vue`'s `handleMouseDown`:
```typescript
console.log('[ClipRegion] mousedown intercepted, stopping propagation');
```

---

## 4. Issue B -- New Recording Offset / Needs Nudging Left

### Symptoms
A fresh recording's waveform appears shifted to the right on the timeline. The user must manually nudge it left to align with where the audio actually starts.

### Relevant Code Paths

1. **Recording stop:** `recording.ts:547-613` -- `stopRecording()` returns `RecordingResult` with `pre_record_seconds`
2. **Track creation:** `recording.ts:616-661` -- `createTrackFromRecording()` calls `audioStore.importFile(segPath, segTrackStart)` where `segTrackStart` is `undefined` for first segment (line 631)
3. **Import file:** `audio.ts:142-483` -- line 172: `const trackStart = overrideTrackStart ?? tracksStore.timelineDuration;`
4. **Pre-record buffer:** `recording/mod.rs:676-691` -- drains up to 10 seconds of pre-monitoring audio into the WAV file

### Likely Root Causes (ranked by likelihood)

#### Root Cause B1: Pre-Record Buffer Not Compensated (HIGH confidence)

When monitoring is active before recording starts, the recording backend maintains a 10-second pre-record ring buffer (`PRE_RECORD_SECONDS = 10` in `ring_buffer.rs:134`). When recording begins (`start_recording` in `mod.rs:676-691`), this buffer is drained into the WAV file:

```rust
let (samples, secs) = buf.drain();
// ... writes samples to ring buffer ...
pre_record_secs = secs;
```

The `RecordingResult` carries `pre_record_seconds: session.pre_record_seconds` (line 842). **But the frontend never uses this value.**

In `createTrackFromRecording()` (line 616-661), the `trackStart` for the first segment is passed as `undefined`, which means `audioStore.importFile(segPath, undefined)` gets `trackStart = tracksStore.timelineDuration` (end of current timeline).

The WAV file contains `pre_record_seconds` worth of audio BEFORE the actual recording start. But the track is placed at the timeline end without subtracting this offset. The waveform therefore shows the pre-record audio at the beginning of the track, pushing the actual content rightward.

**If the user was NOT monitoring before hitting record**, `pre_record_seconds` is 0.0 and this issue doesn't manifest. This could explain why the issue is intermittent -- it depends on whether monitoring was active.

For a **fresh project** (no other tracks), `timelineDuration` is 0, so the track starts at 0. But the recording WAV has `pre_record_seconds` of audio prepended. The track duration is `actual_recording_duration + pre_record_seconds`, and the waveform starts with the pre-record audio. The user hears the pre-record silence/noise at the beginning, which makes it seem offset.

#### Root Cause B2: Recording Duration Mismatch (MEDIUM confidence)

The recording duration is tracked in the frontend via `Date.now()` wall clock (line 522-528):
```typescript
durationInterval = window.setInterval(() => {
  recordingDuration.value = (Date.now() - recordingStartTime) / 1000;
}, 100);
```

But the actual WAV file duration is determined by sample count. The WAV file includes pre-record buffer samples. So the metadata probe will report a longer duration than the user expected. When the track is placed at timeline position 0, the extra pre-record audio shifts the "real" content to the right.

#### Root Cause B3: Waveform/Playback Timing Discrepancy (MEDIUM confidence)

The waveform is generated from the WAV file contents (including pre-record audio). Playback also reads from sample 0 of the WAV file. So waveform and playback are consistent -- but both are offset from the user's expectation of "recording started here."

The fix should either:
- Trim the pre-record audio from the WAV before importing, OR
- Set `trackStart = timelineDuration - pre_record_seconds` to shift the track left, OR
- Set `sourceOffset = pre_record_seconds * sampleRate * channels` on the track's clip to skip the pre-record portion

### Evidence
- `recording/mod.rs:676-691` -- pre-record buffer drained into WAV file
- `recording/ring_buffer.rs:134` -- `PRE_RECORD_SECONDS = 10`
- `recording.ts:62` -- `pre_record_seconds` field exists in RecordingResult
- `recording.ts:616-661` -- `createTrackFromRecording()` ignores `pre_record_seconds`
- `audio.ts:172` -- trackStart defaults to `timelineDuration`, no pre-record compensation

### Recommended Fixes

**Targeted fix:** In `createTrackFromRecording()`, compensate for pre-record seconds:
```typescript
async function createTrackFromRecording(result: RecordingResult, trackStart?: number): Promise<void> {
  // Compute effective track start, compensating for pre-record buffer
  const preRecordOffset = result.pre_record_seconds || 0;
  const baseStart = trackStart ?? tracksStore.timelineDuration;
  const effectiveStart = Math.max(0, baseStart - preRecordOffset);

  // ... pass effectiveStart to importFile ...
  const segTrackStart = (i === 0) ? effectiveStart : undefined;
  await audioStore.importFile(segPath, segTrackStart);
}
```

**Better architectural fix:** After importing, set the clip's `sourceOffset` to `preRecordOffset * sampleRate * channels` so the pre-record audio is hidden but available for "extend left" edits. This preserves the pre-record audio without confusing the user.

### Recommended Instrumentation

In `createTrackFromRecording`, log:
```typescript
console.log('[Recording] Pre-record seconds:', result.pre_record_seconds,
            'Effective track start:', effectiveStart);
```

---

## 5. Issue C -- Clip/Export Sounds Worse Than Timeline

### Symptoms
Exported audio or clipped segments sound noticeably degraded compared to timeline playback.

### Relevant Code Paths

**Timeline playback (high quality):**
- Rust cpal callback (`playback.rs:1116-1317`) reads **32-bit float** samples directly from mmap'd WAV or decoded PCM
- No format conversion, no normalization, no clipping
- Volume applied as simple float multiplication
- Output goes straight to cpal device at native sample rate

**EDL export path (should match playback):**
- `export.rs:297-349` `mix_chunk()` -- reads same 32-bit float samples via `PcmData::samples()`
- Writes to 32-bit float WAV (`hound::SampleFormat::Float`)
- No normalization applied
- For MP3/FLAC/OGG: writes temp WAV then converts via ffmpeg/vorbis

**JS fallback export path (degraded):**
- `export.ts:595-680` `mixActiveTracks()` -- mixes AudioBuffer data
- `audio-utils.ts:16-73` `encodeWav()` -- **converts to 16-bit PCM!**
- Lines 63-69:
  ```typescript
  const sample = Math.max(-1, Math.min(1, channels[ch][i]));
  const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  view.setInt16(offset, intSample, true);
  ```
- Lines 662-677: **Peak normalization applied** -- scales down if any sample exceeds 1.0:
  ```typescript
  if (maxAbs > 1) {
    const scale = 0.95 / maxAbs;
    // ... scales all samples ...
  }
  ```
- This normalized 16-bit WAV is then passed to Rust for conversion to MP3/FLAC/OGG

### Likely Root Causes (ranked by likelihood)

#### Root Cause C1: 16-Bit Quantization in JS Fallback Path (HIGH confidence)

`encodeWav()` in `audio-utils.ts` uses 16-bit PCM (line 19: `bitsPerSample = 16`). The playback engine uses 32-bit float throughout. 16-bit PCM has a dynamic range of ~96 dB vs 32-bit float's ~1528 dB. For audio that has any quiet passages, reverb tails, or low-level detail, the 16-bit quantization introduces quantization noise.

The JS fallback path is used when `canUseEdlExport()` returns false -- i.e., when any clip lacks a resolvable source path (`clip.sourceFile || t.cachedAudioPath || t.sourcePath`). This can happen for tracks that were pasted, created from clipboard operations, or imported without source path preservation.

**Note:** The codebase does have `encodeWavFloat32()` in `audio-utils.ts:80-135` which uses 32-bit float, but the export store uses `encodeWav()` (16-bit) at line 275 and 401.

#### Root Cause C2: Peak Normalization in JS Fallback Path (HIGH confidence)

`mixActiveTracks()` (line 662-677) applies normalization:
```typescript
if (maxAbs > 1) {
  const scale = 0.95 / maxAbs;
  for (let ch = 0; ch < numChannels; ch++) {
    const data = mixedBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] *= scale;
    }
  }
}
```

This reduces the overall level if any peak exceeds 1.0. Playback does NOT apply this normalization -- it allows the output to exceed 1.0 (handled by the DAC/driver). So the export sounds quieter and has different dynamics than playback.

The EDL export path (`mix_chunk`) also does NOT apply normalization, so this is only a JS fallback issue.

#### Root Cause C3: Sample Rate Mismatch in EDL Export (MEDIUM confidence)

In `buildEdl()` (export.ts:163-208), the EDL's sample rate is taken from the first track:
```typescript
const sampleRate = firstTrack?.audioData.sampleRate || 44100;
```

But `mix_chunk()` in `export.rs:329` computes source sample indices using the **source file's native sample rate**, while output frames use the **EDL's declared sample rate**:
```typescript
let src_frame = ((rel_t + src.file_offset) * src_rate) as usize;
```

If the source file is at 48kHz but the EDL declares 44100Hz (because `audioData.sampleRate` was set from the browser's `AudioContext` which may resample), the mix_chunk function would read source samples at the wrong rate. The time-to-sample conversion would be wrong: it would read frames from the source at the source's rate, but advance through the output at the EDL's rate. This produces **no resampling** -- just wrong sample selection, causing slight pitch shift or timing artifacts.

The playback engine has the same potential issue: it uses the output device sample rate for position advancement but reads source samples at the source's rate. The time-based lookup means both playback and export handle mismatched rates the same way (nearest-neighbor resampling via truncation), so this alone wouldn't explain a difference between playback and export quality.

However, when the output device rate differs from source rate, **both** playback and export do nearest-neighbor sample selection (truncation, no interpolation). This means aliasing artifacts are present in both, but may be more audible in the export because the export is played back through the user's normal playback chain rather than the cpal output stream.

#### Root Cause C4: ffmpeg Conversion Quality (LOW confidence)

For MP3 export, `wav_to_mp3()` in `export.rs:500-514` uses:
```
ffmpeg -y -i wav_path -c:a libmp3lame -b:a {bitrate}k mp3_path
```

The default quality settings for libmp3lame are reasonable. However, the ffmpeg call uses constant bitrate (`-b:a`) rather than VBR quality mode (`-q:a`). At 192kbps CBR, the quality is acceptable for most content. At lower bitrates, quality could be notably worse.

For OGG export via Vorbis encoder, the quality parameter (default 0.4) is moderate -- equivalent to ~128kbps. This could sound worse than the 32-bit float playback.

#### Root Cause C5: Channel Mismatch (LOW confidence)

`buildEdl()` caps channels to 2 with `Math.min(firstTrack?.audioData.channels || 2, 2)`. If the source is mono but `audioData.channels` reports 2 (from browser decode), the export writes stereo silence in one channel. Playback handles mono correctly (duplicates to both channels at line 1219-1220).

### Evidence

- `audio-utils.ts:19` -- `bitsPerSample = 16` in `encodeWav()`
- `audio-utils.ts:80-135` -- `encodeWavFloat32()` exists but is NOT used for export
- `export.ts:275` -- `const wavData = encodeWav(mixedBuffer);` -- uses 16-bit version
- `export.ts:401` -- same 16-bit path for single-track export
- `export.ts:662-677` -- normalization in JS fallback path
- `playback.rs:1116-1317` -- 32-bit float throughout, no normalization
- `export.rs:397-400` -- EDL WAV uses 32-bit float (correct)

### Recommended Fixes

**Critical fix C1:** Change `export.ts` to use `encodeWavFloat32()` instead of `encodeWav()`:
```typescript
// Line 275
const wavData = encodeWavFloat32(mixedBuffer);  // was: encodeWav(mixedBuffer)
// Line 401
const wavData = encodeWavFloat32(trackBuffer);  // was: encodeWav(trackBuffer)
```

Import `encodeWavFloat32` from `@/shared/audio-utils` (it already exists).

**Fix C2:** Remove the normalization from `mixActiveTracks()` or make it opt-in. The playback engine doesn't normalize, so the export shouldn't either:
```typescript
// Delete or comment out lines 662-677
// Or change to: if (maxAbs > 1) { console.warn('Peaks exceed 1.0, export may clip'); }
```

**Fix C3:** Add linear interpolation in `mix_chunk()` for sample rate conversion (both Rust export and playback). Currently both use nearest-neighbor (truncation cast `as usize`). Linear interpolation would improve quality:
```rust
let src_pos_f = (rel_t + src.file_offset) * src_rate;
let src_frame_lo = src_pos_f as usize;
let src_frame_hi = src_frame_lo + 1;
let frac = (src_pos_f - src_frame_lo as f64) as f32;
// lerp between samples
```

### Recommended Instrumentation

In `doMixedExport()`, log which path is taken:
```typescript
console.log('[Export] Using EDL path:', canUseEdlExport(tracks), 'tracks:', tracks.length);
```

In `mixActiveTracks()`, log normalization:
```typescript
if (maxAbs > 1) {
  console.warn(`[Export] Normalizing: maxAbs=${maxAbs.toFixed(3)}, scale=${scale.toFixed(4)}`);
}
```

---

## 6. Cross-Cutting Architectural Risks

### Risk 1: No Resampling Engine

Neither the playback engine nor the export pipeline performs proper resampling when source sample rates differ from output sample rates. Both use nearest-neighbor sample selection (time-based index truncation). This means:
- 48kHz source played/exported at 44.1kHz: aliasing artifacts, slight speed change
- Source sample rate preserved in EDL only if first track's `audioData.sampleRate` matches source -- browser's `decodeAudioData` may resample to AudioContext sample rate

**Files affected:** `playback.rs:1212`, `export.rs:329`

### Risk 2: Dual Audio Pipelines (JS vs Rust)

The JS fallback export path (`mixActiveTracks` + `encodeWav`) diverges significantly from the Rust EDL path and the Rust playback path:
- JS: 16-bit PCM, peak normalization, AudioBuffer-based mixing
- Rust: 32-bit float, no normalization, mmap/streaming PCM

Users may unknowingly hit the JS path and experience quality loss.

**Recommendation:** Log prominently when the JS fallback path is used. Consider deprecating it entirely and always requiring source paths for export.

### Risk 3: Pre-Record Buffer Creates Hidden Audio

The 10-second pre-record buffer introduces audio at the beginning of recordings that the user didn't intentionally capture. This audio is included in exports, waveform display, and duration calculations. It should be treated as a hidden region by default.

### Risk 4: Click Event Architecture

The current design where ClipRegion swallows all mousedown events means click-to-seek only works in "empty" areas of the timeline. This is unlike standard DAW behavior where clicking in a track lane always moves the playhead.

---

## 7. Highest-Value Fix Plan

### Priority 1: Fix export quality (Issue C)
**Impact: Highest** -- directly affects the product's core value proposition (producing clean audio).
**Effort: Low** -- change `encodeWav` to `encodeWavFloat32` in two lines, remove normalization.
**Files:** `src/stores/export.ts` (lines 275, 401, 662-677)

### Priority 2: Fix click-to-seek (Issue A)
**Impact: High** -- core UX issue that makes editing frustrating.
**Effort: Low-Medium** -- add seek on clip-click in `TrackLane.vue`'s drag-end handler.
**Files:** `src/components/tracks/TrackLane.vue` (line 210-213)

### Priority 3: Fix recording offset (Issue B)
**Impact: Medium** -- affects recording workflow but has a manual workaround (nudge).
**Effort: Low** -- compensate `pre_record_seconds` in `createTrackFromRecording()`.
**Files:** `src/stores/recording.ts` (line 616-661)

---

## 8. Regression Test Recommendations

### For Issue A (click-to-seek):
1. Click on a clip region during playback -- verify playhead moves to clicked position
2. Click on empty timeline area during playback -- verify playhead moves
3. Click near the playhead during playback -- verify correct behavior
4. Click during rapid seek sequences -- verify no lost seeks
5. Verify clip selection still works (perhaps via modifier key)

### For Issue B (recording offset):
1. Start monitoring, then start recording -- verify track starts at correct position
2. Record without monitoring first -- verify no offset
3. Record with 5+ seconds of monitoring pre-roll -- verify pre-record audio is accounted for
4. Multi-segment recording -- verify all segments align correctly

### For Issue C (export quality):
1. Import a 48kHz 32-bit float WAV, export as WAV -- verify output is 32-bit float
2. Export a multi-track mix -- verify no normalization artifacts
3. Compare A/B: play a section in the app, export the same section, compare waveforms
4. Test JS fallback path specifically (create a track without sourcePath) -- verify 32-bit export
5. Export MP3 at various bitrates -- verify quality matches expectations

### For sample rate handling:
1. Import a 48kHz file when AudioContext is 44.1kHz -- verify export preserves source rate
2. Mix tracks at different sample rates -- verify no pitch shift in export
