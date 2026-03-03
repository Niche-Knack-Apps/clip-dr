# EDL Contracts & Architectural Decisions

This document is the canonical reference for the EDL (Edit Decision List) editing
architecture in Clip Dr. Every contract listed here has corresponding tests enforcing it.

---

## Architectural Decisions

### 1. Canonical Model
`getTrackClips()` is the sole adapter for all editing/rendering/export. It returns explicit
`track.clips[]` when present, otherwise a synthesized single-clip from `track.audioData`.
Export, persistence, and paste all go through `getTrackClips()` exclusively.

### 2. EDL Contracts

**C1 — Metadata-only cuts:** An edit (cut/delete/split) MUST succeed using metadata alone.
Rust extraction is optional, late, and best-effort. If Rust extraction fails or is skipped
(mode: 'edit-only'), the track still splits into correct clips.
- Test: `"edit-only cut succeeds even when Rust extraction returns null"` in `editing-workflow.test.ts`

**C2 — Immediate sourceFile/sourceOffset:** Every clip produced by an edit MUST have
`sourceFile` and `sourceOffset` set immediately after the edit. These fields must never be
left undefined on a clip that has no in-memory buffer.
- Test: `"before and after clips get sourceFile and sourceOffset from track"`

**C3 — Single source of truth:** `getTrackClips()` is the only source of truth for clip
data. Never bypass it when iterating clips for export, rendering, or persistence.

**C4 — No silent failures:** No path may silently return without surfacing an error. Mutex
rejections, guard returns, missing-source failures — all must produce user-visible feedback
or structured errors.

### 3. Waveform Sourcing Policy
All cut/split operations produce clip waveforms by **proportional slicing** of the parent
`waveformData`. `generateWaveformFromBuffer()` is only called at initial import.
Clip waveform is **eventually-consistent UI data** — empty/partial waveforms (`[]`) are
allowed at clip creation; `finalizeClipWaveforms(trackId)` fills them in once the parent
track's import settles.

### 4. Format Assumption Policy
Export output: first contributing track's sample rate; channels capped at 2 (stereo).
Volume envelope times are **track-relative seconds** (relative to `track.trackStart`).
When expanding per-track → per-clip for export, envelope times must be rebased to each
clip's local origin.

### 5. History API Pattern
Two patterns — pick one, never mix:
- **Single user-intent mutation:** `pushState('label'); doMutation();`
- **Composite user-intent operation:** `beginBatch('label'); ...sub-mutations...; endBatch();`

Sub-operations called from composites: **no history calls at all.**
`beginBatch` captures "before" state on the outermost call; `endBatch` completes it.

### 6. No Silent Failures Rule
`let _ = risky_call()` is banned except with explicit justification comment.
Every guard (mutex, re-entrancy, missing-source) must produce a structured error or
user-visible notification.

### 7. Source Stability Policy (for persistence)
When serializing clip `sourceFile`: prefer `track.sourcePath` (stable user-granted import
path) over `cachedAudioPath` (managed cache, potentially volatile) over `clip.sourceFile`
(may be a temp path). If only a temp path is available, persist `source_kind: 'temp'`
and surface a "source not found — needs relink" error at load time.

### 8. Edit Epoch
Each track carries `editEpoch: number`. Any async edit captures `epoch` at entry; after
each `await` it checks epoch matches before writing back. Mismatch → abort with warning.

---

## isTrackPlayable Canonical Check

The function `isTrackPlayable(status: ImportStatus | undefined): boolean` in
`src/shared/utils.ts` is the single place that defines what statuses are "usable audio".

**Allowed statuses:** `undefined`, `'ready'`, `'large-file'`, `'caching'`

Add new playable `ImportStatus` values here — do NOT add inline checks elsewhere.

---

## Contract Test Locations

| Contract | Test File | Test Name |
|----------|-----------|-----------|
| C1 | `editing-workflow.test.ts` | "edit-only cut succeeds even when Rust extraction returns null" |
| C2 | `editing-workflow.test.ts` | "before and after clips get sourceFile and sourceOffset from track" |
| C3 | `editing-workflow.test.ts` | "getTrackClips returns sourceFile from track cachedAudioPath" |
| C4 | (various) | error surfacing tests |
