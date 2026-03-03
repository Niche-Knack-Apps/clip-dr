# Plan: Non-Destructive Editing (EDL Architecture)

## Context

After implementing the editing workflow spec fixes, testing revealed fundamental architecture problems:

1. **Small-file cut/delete don't show 2 sections** — `flattenAndRecacheClips` merges clips back into a single buffer immediately after every cut/delete, destroying the visual separation
2. **Large-file cut takes ~10s** — `splice_wav_remove_region` physically copies the entire file (writes 2 new WAVs for before/after portions of a 4GB file)
3. **Large-file second cut fails** — after first cut creates clips with `buffer: null`, dispatch routes to `cutRegionFromClips` which can't handle null-buffer clips
4. **Large-file delete fails** — same dispatch issue + 1GB size guard rejects large selections

**Root cause:** The editing system is destructive — it physically modifies audio data (buffers or files) on every edit. The fix is to switch to **non-destructive EDL (Edit Decision List) editing** where clips are metadata references into source files, and audio data is never copied during editing.

## Architecture Overview

### Current (Destructive)
```
Cut → splice file on disk (10s) OR splice buffers in memory
    → create clips → flattenAndRecacheClips → single buffer (clips destroyed)
    → write single WAV for Rust → playback from single file
```

### New (Non-Destructive EDL)
```
Cut → split clip reference in two (instant, metadata only)
    → clips persist with source file + offset
    → playback reads directly from source file at each clip's offset
    → no file copying, no buffer merging, no temp WAVs for large files
```

### Key Principle
**Clips are references, not containers.** A clip says "play source file X from offset A for duration B, starting at timeline position T." Cutting just splits one reference into two. No audio data moves.

## Phase 1: Core EDL + Instant Edits (implement now)

### Step 1: Extend `TrackClip` with source reference

**File:** `src/shared/types.ts` (line 62)

```typescript
export interface TrackClip {
  id: string;
  buffer: AudioBuffer | null;       // small-file clips (in-memory)
  waveformData: number[];
  clipStart: number;                 // timeline position (seconds)
  duration: number;
  // NEW: EDL source reference (large-file non-destructive editing)
  sourceFile?: string;               // path to source audio file
  sourceOffset?: number;             // offset in seconds within source file
}
```

- Small-file clips: `buffer` set, `sourceFile`/`sourceOffset` unset (or set to cachedPath/0)
- Large-file clips: `buffer = null`, `sourceFile` = original file path, `sourceOffset` = position in file
- After a cut, each resulting clip gets the correct `sourceOffset` calculated mathematically

### Step 2: Add `file_offset` to Rust `PlaybackTrackConfig`

**File:** `src-tauri/src/commands/playback.rs` (line 26)

```rust
pub struct PlaybackTrackConfig {
    pub track_id: String,
    pub source_path: String,
    pub track_start: f64,
    pub duration: f64,
    pub volume: f32,
    pub muted: bool,
    #[serde(default)]
    pub file_offset: f64,  // NEW: seconds offset into source file
    #[serde(default)]
    pub volume_envelope: Option<Vec<AutomationPoint>>,
}
```

**Mixing loop change** (line 1206):

```rust
// BEFORE:
let sample_idx = (rel_pos * src_rate) as usize;

// AFTER:
let sample_idx = ((track_src.config.file_offset + rel_pos) * src_rate) as usize;
```

This is a **one-line change**. `file_offset` defaults to 0.0 (backward compatible). For EDL clips, it tells the engine where in the source file to start reading.

### Step 3: Rewrite `cutRegionFromTrack` — large-file path becomes metadata-only

**File:** `src/stores/tracks.ts` (lines 482-570)

**Current:** Calls `splice_wav_remove_region` via Rust (copies entire file, 10+ seconds)

**New:** Pure math, instant:

```typescript
// Large-file path: metadata-only cut (no file I/O)
if (!track.audioData.buffer && (track.cachedAudioPath || track.sourcePath)) {
  const sourceFile = track.cachedAudioPath || track.sourcePath!;
  // For tracks that already have clips, this is handled by cutRegionFromClips
  // For single-source tracks, the implicit sourceOffset is 0
  const sourceOffset = 0;

  const newClips: TrackClip[] = [];

  if (cutStart > 0.001) {
    // Before clip: same source, same offset, shorter duration
    newClips.push({
      id: `${trackId}-before`,
      buffer: null,
      waveformData: existingWaveform.slice(0, beforeBucketEnd * 2),
      clipStart: trackStart,
      duration: cutStart,
      sourceFile,
      sourceOffset,
    });
  }

  if (cutEnd < track.duration - 0.001) {
    // After clip: same source, offset advanced past cut region
    newClips.push({
      id: `${trackId}-after`,
      buffer: null,
      waveformData: existingWaveform.slice(afterBucketStart * 2),
      clipStart: trackStart + cutEnd,  // gap preserved (caller closes for cut, leaves for delete)
      duration: track.duration - cutEnd,
      sourceFile,
      sourceOffset: sourceOffset + cutEnd,  // skip past the cut region in the file
    });
  }

  // Update track with clips (no Rust call, no file I/O)
  // ... update track duration from clip span ...
}
```

**Result:** Large-file cut goes from ~10 seconds to **instant** (<1ms).

### Step 4: Rewrite `cutRegionFromClips` for EDL clips

**File:** `src/stores/tracks.ts` (lines 711-867)

Currently this function fails for large-file clips because:
- Size guard rejects large selections (line 724)
- `if (!buf) continue` silently skips null-buffer clips (line 747)

**New logic for EDL clips** (clips with `sourceFile` + `sourceOffset`, `buffer: null`):

```typescript
for (const clip of clips) {
  const clipEnd = clip.clipStart + clip.duration;

  // No overlap → keep as-is
  if (clip.clipStart >= outPoint || clipEnd <= inPoint) {
    newClips.push(clip);
    continue;
  }

  // Fully contained → remove (contributes to cut buffer)
  if (clip.clipStart >= inPoint && clipEnd <= outPoint) {
    // Extract for clipboard if needed
    continue;
  }

  // Partial overlap — split by adjusting offsets (pure math)
  const cutStartInClip = Math.max(0, inPoint - clip.clipStart);
  const cutEndInClip = Math.min(clip.duration, outPoint - clip.clipStart);

  if (cutStartInClip > 0.001) {
    // Before portion
    newClips.push({
      ...clip,
      id: generateId(),
      duration: cutStartInClip,
      waveformData: sliceWaveform(clip, 0, cutStartInClip),
      // sourceFile and sourceOffset unchanged — reads same start in file
    });
  }

  if (cutEndInClip < clip.duration - 0.001) {
    // After portion
    newClips.push({
      ...clip,
      id: generateId(),
      clipStart: clip.clipStart + cutEndInClip,
      duration: clip.duration - cutEndInClip,
      sourceFile: clip.sourceFile,
      sourceOffset: (clip.sourceOffset ?? 0) + cutEndInClip,
      waveformData: sliceWaveform(clip, cutEndInClip, clip.duration),
    });
  }
}
```

**Key:** No size guard needed — we're not creating buffers, just splitting references. No Rust calls. Works for any file size.

### Step 5: Remove `flattenAndRecacheClips`, add per-clip WAV caching

**File:** `src/stores/clipboard.ts`

**Remove:** Both calls to `flattenAndRecacheClips` (lines ~294 and ~439)

**Replace with:** `cacheClipsForPlayback()` — writes per-clip temp WAVs for **small-file clips only**:

```typescript
async function cacheClipsForPlayback(ctx: AudioContext): Promise<void> {
  for (const track of tracksStore.tracks) {
    if (!track.clips || track.clips.length === 0) continue;
    for (const clip of track.clips) {
      // Skip if already cached or if EDL clip (has sourceFile)
      if (clip.sourceFile) continue;
      if (!clip.buffer) continue;
      // Write this clip's buffer to a temp WAV
      const wavData = encodeWavFloat32(clip.buffer);
      const fileName = `clip_${clip.id}_${Date.now()}.wav`;
      await writeFile(fileName, wavData, { baseDir: BaseDirectory.Temp });
      const tmpDir = await tempDir();
      clip.sourceFile = `${tmpDir}${tmpDir.endsWith('/') ? '' : '/'}${fileName}`;
      clip.sourceOffset = 0;
    }
  }
}
```

**Large-file clips:** Already have `sourceFile` pointing to the original source. No caching needed.

### Step 6: Update playback sync to expand clips into virtual tracks

**File:** `src/stores/playback.ts` (lines 116-150)

**`syncTracksToRust`** — expand each track's clips into separate Rust track entries:

```typescript
async function syncTracksToRust(): Promise<void> {
  const hash = computeClipHash();  // updated hash function
  if (hash === lastSyncedTrackHash) return;

  const playable = getPlayableTracks();
  const trackConfigs: PlaybackTrackConfig[] = [];

  for (const t of playable) {
    const clips = tracksStore.getTrackClips(t.id);
    for (const clip of clips) {
      const sourcePath = clip.sourceFile || t.cachedAudioPath || t.sourcePath;
      if (!sourcePath) continue;

      trackConfigs.push({
        track_id: `${t.id}:${clip.id}`,
        source_path: sourcePath,
        track_start: clip.clipStart,
        duration: clip.duration,
        file_offset: clip.sourceOffset ?? 0,
        volume: t.volume,
        muted: false,
        volume_envelope: t.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })) ?? null,
      });
    }
  }

  await invoke('playback_set_tracks', { tracks: trackConfigs });
  lastSyncedTrackHash = hash;
  await syncMuteSoloToRust();
}
```

**`computeClipHash`** — include clip details:

```typescript
function computeClipHash(): string {
  return getPlayableTracks()
    .map(t => {
      const clips = tracksStore.getTrackClips(t.id);
      return clips.map(c =>
        `${t.id}:${c.id}:${c.sourceFile || ''}:${c.clipStart.toFixed(4)}:${c.duration.toFixed(4)}:${(c.sourceOffset ?? 0).toFixed(4)}`
      ).join(';');
    })
    .sort()
    .join('|');
}
```

**`syncMuteSoloToRust`** — send mute for each virtual clip track:

```typescript
async function syncMuteSoloToRust(): Promise<void> {
  const allTracks = tracksStore.tracks;
  const hasSolo = allTracks.some(t => t.solo && !t.muted);

  for (const track of getPlayableTracks()) {
    let muted = track.muted;
    if (hasSolo) muted = !track.solo || track.muted;

    const clips = tracksStore.getTrackClips(track.id);
    for (const clip of clips) {
      await invoke('playback_set_track_muted', {
        trackId: `${track.id}:${clip.id}`,
        muted,
      });
    }
  }
}
```

**`getPlayableTracks`** — update to check clips for source paths, not just track-level:

```typescript
function getPlayableTracks(): Track[] {
  return tracksStore.tracks.filter(t => {
    if (t.importStatus && t.importStatus !== 'ready' && t.importStatus !== 'large-file' && t.importStatus !== 'caching') return false;
    // Playable if track has source OR any clip has source
    if (t.cachedAudioPath || t.sourcePath) return true;
    if (t.clips?.some(c => c.sourceFile)) return true;
    return false;
  });
}
```

### Step 7: Update `extractRegionViaRust` for clip-based tracks

**File:** `src/stores/tracks.ts` (line ~1078)

When extracting a region for the clipboard, we need to account for which clip's file and offset to read from:

```typescript
async function extractRegionViaRust(
  track: Track,
  relStart: number,   // track-relative start
  relEnd: number,     // track-relative end
  ctx: AudioContext
): Promise<AudioBuffer | null> {
  // If track has clips, find the clip that contains the region
  if (track.clips && track.clips.length > 0) {
    for (const clip of track.clips) {
      const clipRelStart = clip.clipStart - track.trackStart;
      const clipRelEnd = clipRelStart + clip.duration;
      if (relStart >= clipRelStart && relStart < clipRelEnd) {
        const sourceFile = clip.sourceFile || track.cachedAudioPath || track.sourcePath;
        if (!sourceFile) return null;
        // Convert to source-file-relative coordinates
        const fileStart = (clip.sourceOffset ?? 0) + (relStart - clipRelStart);
        const fileEnd = (clip.sourceOffset ?? 0) + Math.min(relEnd - clipRelStart, clip.duration);
        return await invokeExtract(sourceFile, fileStart, fileEnd, ctx);
      }
    }
    return null;
  }

  // Non-clip track: use existing path
  const sourcePath = track.cachedAudioPath || track.sourcePath;
  if (!sourcePath) return null;
  return await invokeExtract(sourcePath, relStart, relEnd, ctx);
}
```

### Step 8: Set `sourceFile` during import and recording finalization

**File:** `src/stores/tracks.ts`

When a large file is imported and gets `cachedAudioPath` or `sourcePath` set, also initialize the implicit EDL reference. The synthetic clip from `getTrackClips` should include source info:

```typescript
function getTrackClips(trackId: string): TrackClip[] {
  const track = tracks.value.find((t) => t.id === trackId);
  if (!track) return [];

  if (track.clips && track.clips.length > 0) {
    return track.clips;
  }

  if (track.importStatus === 'importing' || track.importStatus === 'decoding') return [];

  // Synthetic single clip — include source reference for EDL playback
  return [{
    id: `${trackId}-main`,
    buffer: track.audioData.buffer,
    waveformData: track.audioData.waveformData,
    clipStart: track.trackStart,
    duration: track.duration,
    sourceFile: track.cachedAudioPath || track.sourcePath,
    sourceOffset: 0,
  }];
}
```

## Phase 2: Future Enhancements (not implemented now)

These are noted for context but deferred:

- **Multi-resolution peak cache**: Sidecar `.peaks` files with multiple levels (256/2048/16384 samples per bucket) for efficient zoom/scroll on huge files
- **Virtual clipboard**: Clip references instead of materialized audio — only materialize on paste-to-new-track or export
- **Chunked export**: When exporting, resolve EDL clips to audio in chunks (never build >1GB buffers)
- **Streaming renderer**: Replace virtual-track approach with a proper multi-source streaming renderer in Rust
- **Undo optimization**: Since edits are metadata-only, history snapshots become much lighter (just clip lists, no audio buffer references)

## Files Modified

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `sourceFile?: string` and `sourceOffset?: number` to `TrackClip` |
| `src-tauri/src/commands/playback.rs` | Add `file_offset: f64` to `PlaybackTrackConfig`; one-line change in mixing loop (line 1206) |
| `src/stores/tracks.ts` | Rewrite large-file `cutRegionFromTrack` path (metadata-only); rewrite `cutRegionFromClips` for EDL clips; update `getTrackClips` to include source refs; update `extractRegionViaRust` for clips |
| `src/stores/clipboard.ts` | Remove `flattenAndRecacheClips`; add `cacheClipsForPlayback` (per-clip WAVs for small files); remove both flatten calls from cut/delete |
| `src/stores/playback.ts` | Rewrite `syncTracksToRust` to expand clips into virtual tracks; update `computeTrackHash`; update `syncMuteSoloToRust` for virtual track IDs; update `getPlayableTracks` |

## Verification

1. `npx vue-tsc --noEmit` — fix type errors
2. `npm run lint` — fix lint issues
3. `npx vitest run` — update tests for new clip structure
4. **Manual tests:**
   - Import small file (~2min WAV), cut with I/O points → verify 2 visible sections, gap closed, playback works
   - Import small file, delete with I/O points → verify 2 visible sections, gap preserved, playback works
   - Import large file (>500MB), cut with I/O points → verify instant (<100ms), 2 sections visible, playback works
   - Import large file, delete → verify instant, gap preserved, playback works
   - Chain multiple cuts on large file → verify all work instantly
   - Undo/redo after cut/delete → verify clips restore correctly
   - Clip (c) operation → verify still works (creates new track from extracted region)

## Design Decisions

1. **Why virtual tracks instead of a multi-segment Rust renderer?** The Rust engine already handles multiple tracks perfectly. Expanding clips into virtual tracks reuses all existing playback infrastructure (mmap, volume envelope, mute/solo) with zero Rust architecture changes. A proper multi-segment renderer is better long-term but is a much larger Rust refactor.

2. **Why keep two cut paths (small-file vs large-file)?** Small-file in-memory cutting is fast and precise. Large-file EDL cutting is instant. Both produce the same clip output format. Unifying to all-EDL is possible but adds unnecessary disk I/O for small files that are already in memory.

3. **Why not virtual clipboard?** Materializing a small audio region for the clipboard is fast even for large files (Rust `extract_audio_region` reads a few seconds, not the whole file). Virtual clipboard adds complexity for minimal gain. Deferred to Phase 2.

4. **Original source file must stay accessible.** EDL clips reference the original file. If the user moves/deletes it, clips become unplayable. This is standard DAW behavior (Audacity, Reaper, etc. all work this way).
