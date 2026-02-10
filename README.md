# Clip Dr.

A multi-track audio editor for cutting, arranging, and exporting clips. Built with Vue 3, Pinia, and Tauri.

## Supported Formats

**Import:** MP3, WAV, FLAC, M4A, OGG, AAC, WMA

**Export:** WAV, MP3 (128/192/256/320 kbps), FLAC, OGG

## Features

### Multi-Track Editor
- Import multiple audio files onto separate tracks
- Drag clips to reposition on the timeline
- Snap clips to edges (magnetic alignment, toggle on/off)
- Reorder tracks via drag handle
- Mute, solo, and per-track volume controls
- Per-track color coding
- Export individual tracks or all active tracks mixed together
- Add empty tracks for organization
- Resizable track control panel (80-300px)

### Recording
- Record from microphone or system audio (PipeWire/PulseAudio)
- Real-time level meter and duration counter
- Input device selection
- Track placement options: append, at playhead, or at time zero

### Clip & Selection Operations
- Set In/Out points to define regions
- Create clips from In/Out regions
- Cut, copy, and paste clips or regions
- Delete selected clips, I/O regions, or entire tracks
- Cut preserves empty tracks; Delete removes them
- Ripple delete (closes gaps automatically)
- Slide remaining tracks left after cut

### Waveform Views
- **Full waveform (Panel 1):** Shows entire timeline with selection window overlay, silence regions, and time markers
- **Zoomed waveform (Panel 2):** Shows the selection window contents zoomed in, with In/Out marker handles
- Scroll-wheel zoom on both panels
- Click to set playhead, drag to create I/O selection
- Follow-playhead mode (auto-scroll during playback)
- Resizable panel heights via drag dividers

### Playback
- JKL shuttle control (forward, reverse, variable speed)
- Playback speed adjustment (0.5x-2x via keyboard)
- Five loop modes: Full, Zoom, I/O, Tracks, Clip
- Master volume slider

### History
- Unlimited undo/redo (snapshot-based)
- Batch operations grouped as single undo steps

### Audio Cleaning — COMING SOON
- High-pass / low-pass filtering
- Notch filter for hum removal
- Spectral noise reduction
- Neural noise reduction
- Expander/gate
- Presets: Podcast/Voice, Interview, Aggressive, Hum Only

### Silence Detection — COMING SOON
- VAD-based silence detection with configurable sensitivity and padding
- Visual silence overlays on waveforms (draggable, resizable, deletable)
- Skip/compress silence during playback
- Cut silence to new track (non-destructive)
- Manual silence region creation from In/Out points

### Transcription — COMING SOON
- Whisper-tiny CPU model (no GPU required)
- Word-level timestamps
- Searchable transcription
- Clickable word timeline for navigation
- Live transcription during recording
- Re-transcribe selected tracks

## Keyboard Shortcuts

### Playback

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `L` or `Right` | Play forward |
| `J` or `Left` | Play reverse |
| `K` (hold with J/L) | 2x speed |
| `Shift` (hold with J/L) | 0.5x speed |
| `.` / `>` | Speed up |
| `,` / `<` | Speed down |
| `1`-`9` | Nudge playhead (10ms per digit) |

### Navigation

| Key | Action |
|-----|--------|
| `Home` | Jump to start |
| `End` | Jump to end |
| `[` | Jump to In point |
| `]` | Jump to Out point |
| `S` | Jump to selected track/clip start |
| `E` | Jump to selected track/clip end |
| `Tab` | Select next track |
| `Shift+Tab` | Select previous track |

### Editing

| Key | Action |
|-----|--------|
| `I` | Set In point |
| `O` | Set Out point |
| `C` | Create clip from I/O region |
| `X` | Cut selection |
| `V` | Paste |
| `Delete` / `Backspace` | Delete selection |
| `Ctrl+X` | Cut |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

### Zoom

| Key | Action |
|-----|--------|
| `+` | Zoom in (track timeline) |
| `-` | Zoom out (track timeline) |
| `Ctrl+Scroll` | Zoom tracks at mouse position |
| `Scroll` (on waveform panels) | Zoom selection window |

### Other

| Key | Action |
|-----|--------|
| `Ctrl+F` | Focus search bar |
| `Escape` | Unfocus text input |

## Development

```bash
# Install dependencies
npm install

# Development (Tauri + Vite)
npm run tauri dev

# Type check
npx vue-tsc --noEmit

# Build for production
npm run tauri build
```

## License

Copyright 2025 Niche-Knack Apps

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
