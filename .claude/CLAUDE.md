## Project
Clip Doctor Scrubs -- Audio editing app with transcription, cleaning, silence detection, and recording.

## Stack
- Vue 3 + TypeScript (strict), Pinia (14 stores), Vite 5, Tauri 2, Tailwind CSS
- Rust backend: symphonia, whisper-rs, nnnoiseless, rubato, hound, realfft, mp3lame-encoder, cpal

## Structure
- src/stores/ -- 14 stores: tracks (~49KB), transcription (~30KB), playback, silence, export, recording, cleaning, clipboard, history, audio, selection, settings, ui, vad
- src/components/ -- cleaning/, export/, recording/, tracks/, transcription/, waveform/, search/, ui/
- src/services/ -- keyboard-shortcuts, debug-logger, audio-buffer, waveform-extractor
- src-tauri/src/commands/ -- audio, transcribe, recording, waveform, export, clean, vad
- src-tauri/src/audio_clean/ -- Rust cleaning pipeline (filters, spectral, neural, expander)

## Commands
- Dev: `npm run dev`
- Typecheck: `npm run typecheck` / Lint: `npm run lint`
- Build: `npm run build` (targets: deb, appimage, rpm)
- Release: `npm run build:release` -- builds + copies to _shared/releases/
- Arch pkg: `../_shared/builders/arch/build.sh project-scrubs-clip-dr` (Podman) or via arch-build VM

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
- Releases output to ../_shared/releases/project-scrubs-clip-dr/
- Arch/AUR packages built via Podman (see _shared/builders/arch/) or arch-build VM (builder:builder)
- Windows builds run on win11-build VM (user: builder, pass: builder) -- project shared via Samba on Z:\

## Don't
- Don't clone AudioBuffers in history snapshots -- share references to save memory
- Don't use require() -- use ES imports (this project's TS config doesn't support require)
- Don't capture history state during drag -- capture once at dragStart, not per-move
- Don't worry about pre-existing TS6133 (unused variable) warnings -- they are known
