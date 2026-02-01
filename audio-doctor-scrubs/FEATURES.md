# Clip Dr. (Audio Doctor Scrubs) - Features

## Audio Import & Playback
- Import audio files (WAV, MP3, FLAC, OGG)
- Variable speed playback (1x-5x forward, reverse scrubbing)
- Loop modes: Full, Zoom, In/Out, Tracks, Clip
- Volume control with per-track volume sliders

## Waveform Display
- Full waveform overview with selection window
- Zoomed waveform with scroll-wheel zoom
- Color-customizable waveform, playhead, and selection
- Follow playhead mode during playback
- Dynamic waveform switching based on soloed track

## Clip & Track Management
- Create clips from In/Out points
- Multi-track timeline with mute/solo controls
- Exclusive solo mode (only one track soloed at a time)
- Drag-to-reorder tracks
- Rename tracks with double-click
- Delete clip tracks

## Silence Detection & Removal
- VAD-based silence detection with adjustable sensitivity
- Visual silence region overlays (red highlights)
- Edit silence regions: resize, move, delete, restore
- "Skip Silence" playback mode
- Cut silence to new track (non-destructive)
- Auto-solo and auto-switch to clip loop mode after cutting

## Audio Cleaning
- High-pass filter (rumble removal)
- Low-pass filter
- Mains hum notch filter (50/60Hz with harmonics)
- Spectral noise reduction
- Neural denoising (RNNoise)
- Expander/noise gate
- Preset configurations (Podcast, Interview, Music, Aggressive)
- Non-destructive: creates new "Cleaned" track

## Transcription
- Auto-transcription on file load (Whisper-based)
- Word-level timestamps with clickable navigation
- Double-click to edit words inline
- Search transcription with stopword filtering
- Navigate between search results
- Re-transcribe option

## Export
- Export formats: WAV, FLAC, MP3, OGG
- Export active (non-muted) tracks
- Auto-close export panel after success

## UI Features
- Keyboard shortcuts for common operations
- Resizable track panel
- Settings panel for customization
- Dark theme optimized for audio editing
