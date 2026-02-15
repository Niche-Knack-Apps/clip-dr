## Project
Clip Dr. -- Audio editing app with transcription, cleaning, silence detection, and recording.

## Stack
- Vue 3 + TypeScript (strict), Pinia (14 stores), Vite 5, Tauri 2, Tailwind CSS
- Rust backend: symphonia, whisper-rs, nnnoiseless, rubato, hound, realfft, mp3lame-encoder, cpal

## Structure
- src/stores/ -- 14 stores: tracks (~49KB), transcription (~30KB), playback, silence, export, recording, cleaning, clipboard, history, audio, selection, settings, ui, vad
- src/components/ -- cleaning/, export/, recording/, tracks/, transcription/, waveform/, search/, ui/
- src/services/ -- keyboard-shortcuts, debug-logger, audio-buffer, waveform-extractor
- src-tauri/src/commands/ -- audio, transcribe, recording, waveform, export, clean, vad
- src-tauri/src/audio_clean/ -- Rust cleaning pipeline (filters, spectral, neural, expander)
- scripts/ -- utility scripts (recover-wav.py for oversized WAV recovery)

## Commands
- Dev: `npm run dev`
- Typecheck: `npm run typecheck` / Lint: `npm run lint`
- Build: `npm run build` (targets: deb, appimage, rpm)
- Release: `npm run build:release` -- builds + copies to _shared/releases/
- Arch pkg: `../_shared/builders/arch/build.sh clip-dr` (Podman) or via arch-build VM

## Verification
After changes, run in order:
1. `npx vue-tsc --noEmit` -- fix type errors
2. `npm run lint` -- fix lint errors

## Conventions
- History uses snapshots: pushState() for single mutations, beginBatch()/endBatch() for composite ops
- AudioBuffer references are shared (never cloned) in history snapshots to save memory
- Track has optional clips?: TrackClip[]; single-buffer tracks use audioData directly
- Word timestamps are 0-based (relative to audio file); add trackOffset when track has trackStart > 0
- TrackList.vue uses 10% padding (duration * 1.1); selection overlays must use same paddedDuration
- Drag operations: capture state BEFORE drag starts, not on each setClipStart/setWordOffset call
- Path aliases: `@` -> src/, `@shared` -> ../_shared/
- Releases output to ../_shared/releases/clip-dr/
- Arch/AUR packages built via Podman (see _shared/builders/arch/) or arch-build VM (builder:builder)
- Windows builds run on win11-build VM (user: builder, pass: builder) -- project shared via Samba on Z:\
- Recording segments stay as separate tracks -- NEVER concatenate WAV segments (causes >4GB header corruption)
- Recording uses AudioWriter enum (hound::WavWriter for split-tracks, Rf64Writer for rf64 mode)
- Rf64Writer starts as RIFF/WAV with JUNK reservation, upgrades JUNK→ds64 at ~4GB boundary
- RecordingResult includes extra_segments: Vec<String> for multi-segment recordings
- Playback supports both WAV and RF64 files via mmap (find_wav_data_offset accepts both magics)
- importStatus in finalizeImportWaveform must preserve 'ready', 'large-file', AND 'caching' statuses
- After recording finalize: fsync the file, then 200ms delay before frontend import
- Recording large file format setting: 'split-tracks' (default, separate ~3.9GB WAVs) or 'rf64' (single file)

## Don't
- Don't clone AudioBuffers in history snapshots -- share references to save memory
- Don't use require() -- use ES imports (this project's TS config doesn't support require)
- Don't capture history state during drag -- capture once at dragStart, not per-move
- Don't worry about pre-existing TS6133 (unused variable) warnings -- they are known
- Don't concatenate WAV segments after recording -- this was the root cause of the 4GB header corruption bug
- Don't regress importStatus in finalizeImportWaveform -- must check all playable statuses, not just 'ready'
