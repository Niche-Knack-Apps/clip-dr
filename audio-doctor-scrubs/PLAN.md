# Audio Doctor: Scrubs - Implementation Plan
## Audio Cleaning & Clip-Making Application

**App Name**: audio-doctor-scrubs
**Goal**: Fast, performant audio cleaning and clip extraction with CPU-only ASR
**Tech Stack**: Tauri 2.0 + Vue 3 + Pinia + Web Audio API + Canvas + FFmpeg

---

## Overview

A high-performance audio editing application for cleaning and creating clips from audio files. Features synchronized waveform views, automatic speech recognition for transcription, and a non-destructive clip/track workflow.

---

## Core Features

### 1. Three-Window Interface

```
┌─────────────────────────────────────────────────────────────┐
│  [Toolbar: Import | Play/Pause | Export | Settings]         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [====FULL WAVEFORM=====================================]   │
│       [  Selection Window  ]  ← Draggable/Resizable        │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [========ZOOMED WAVEFORM (selection content)==========]   │
│  | word | word | word | word | word | word | word |        │
│  ← Transcription aligned underneath                        │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Track 1: Full Audio] ████████████████████████████████    │
│  [Track 2: Clip]            ████████                       │
│  [Track 3: Clip]                        ████               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. Full Waveform View (Top Window)
- Displays entire audio file waveform
- Selection window overlay:
  - Draggable left/right for positioning
  - Resizable from both edges
  - Visual highlight of selected region
- Click-to-seek functionality
- Shows playhead position

### 3. Zoomed Waveform View (Middle Window)
- High-detail view of selection window content
- Transcription words aligned beneath waveform
- In/Out point markers for clipping
- Playhead with precise positioning
- **Loop playback** by default (toggleable)
- Synchronized scrolling with selection window

### 4. Track View (Bottom Window)
- Track 1: Full audio (always present)
- Additional tracks: Created clips
- Visual mute indicators
- Track management (delete to restore)
- Non-destructive editing workflow

### 5. Search Functionality
- Search bar in toolbar
- Auto-navigates after 3+ words typed
- Highlights matching words in transcription
- Moves selection window to match location

### 6. Clip Workflow
1. Set in-point (keyboard: `i`)
2. Set out-point (keyboard: `o`)
3. Create clip (keyboard: `c`)
4. Result:
   - New track created with clipped audio
   - Original track muted in that region
   - Clip can be exported independently
5. Delete track to restore original

### 7. ASR (Automatic Speech Recognition)
- CPU-only for speed (no GPU dependency)
- Uses Whisper.cpp or Vosk for fast transcription
- Rough word-level alignment
- Runs asynchronously with progress indicator

---

## Technical Architecture

### Performance Requirements (Critical)

Based on window-cleaner patterns:

1. **Frame-Accurate Sync**
   - requestAnimationFrame for UI updates
   - Throttled seeks (50ms minimum)
   - Separate sync for scrubbing vs playback

2. **Waveform Rendering**
   - Canvas-based rendering
   - Bucket-based downsampling for overview
   - Viewport culling (only render visible)
   - Pre-computed waveform data

3. **GPU Acceleration**
   - CSS transforms for playhead movement
   - will-change hints for animated elements
   - Avoid layout thrashing

4. **Buffer Management**
   - PCM streaming via FFmpeg
   - Chunked waveform extraction
   - Memory-efficient audio handling

### Directory Structure

```
audio-doctor-scrubs/
├── src/                          # Vue 3 frontend
│   ├── assets/
│   │   └── styles/
│   │       ├── main.css
│   │       └── waveform.css
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppToolbar.vue
│   │   │   └── AppLayout.vue
│   │   ├── waveform/
│   │   │   ├── FullWaveform.vue      # Top window
│   │   │   ├── ZoomedWaveform.vue    # Middle window
│   │   │   ├── SelectionWindow.vue   # Overlay control
│   │   │   ├── Playhead.vue          # Animated playhead
│   │   │   └── WaveformCanvas.vue    # Reusable canvas
│   │   ├── transcription/
│   │   │   ├── WordTimeline.vue
│   │   │   └── TranscriptionWord.vue
│   │   ├── tracks/
│   │   │   ├── TrackList.vue
│   │   │   ├── TrackLane.vue
│   │   │   └── ClipRegion.vue
│   │   ├── search/
│   │   │   └── SearchBar.vue
│   │   └── ui/
│   │       ├── Button.vue
│   │       ├── Slider.vue
│   │       ├── Toggle.vue
│   │       └── ProgressBar.vue
│   ├── views/
│   │   ├── EditorView.vue            # Main editor
│   │   └── SettingsView.vue
│   ├── stores/
│   │   ├── audio.ts                  # Audio file state
│   │   ├── playback.ts               # Playback control
│   │   ├── selection.ts              # Selection window state
│   │   ├── transcription.ts          # ASR results
│   │   ├── tracks.ts                 # Tracks/clips
│   │   └── settings.ts               # App settings
│   ├── composables/
│   │   ├── useAudio.ts               # Web Audio API
│   │   ├── useWaveform.ts            # Waveform data
│   │   ├── usePlayback.ts            # Playback control
│   │   ├── useFrameSync.ts           # Frame-accurate sync
│   │   ├── useSelection.ts           # Selection management
│   │   ├── useClipping.ts            # Clip creation
│   │   └── useSearch.ts              # Search functionality
│   ├── services/
│   │   ├── waveform-extractor.ts     # PCM → waveform data
│   │   ├── audio-buffer.ts           # Audio buffer management
│   │   └── keyboard-shortcuts.ts     # Hotkey handling
│   ├── shared/
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   └── utils.ts
│   ├── router.ts
│   ├── App.vue
│   └── main.ts
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── audio.rs          # Audio file operations
│   │   │   ├── waveform.rs       # Waveform extraction
│   │   │   ├── transcribe.rs     # ASR integration
│   │   │   └── export.rs         # Audio export
│   │   └── asr/
│   │       ├── mod.rs
│   │       ├── whisper.rs        # Whisper.cpp bindings
│   │       └── alignment.rs      # Word alignment
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
└── PLAN.md
```

---

## Data Model

### TypeScript Types

```typescript
// src/shared/types.ts

export interface AudioFile {
  id: string;
  path: string;
  name: string;
  duration: number;           // seconds
  sampleRate: number;
  channels: number;
  waveformData: Float32Array; // Downsampled peaks
  loadedAt: number;
}

export interface Selection {
  start: number;              // seconds
  end: number;                // seconds
}

export interface Word {
  id: string;
  text: string;
  start: number;              // seconds
  end: number;                // seconds
  confidence: number;         // 0-1
}

export interface Transcription {
  audioId: string;
  words: Word[];
  fullText: string;
  language: string;
  processedAt: number;
}

export interface Track {
  id: string;
  name: string;
  audioId: string;
  type: 'full' | 'clip';
  start: number;              // Clip start in source
  end: number;                // Clip end in source
  trackStart: number;         // Position in timeline
  muted: boolean;
  solo: boolean;
  volume: number;             // 0-1
}

export interface Clip {
  id: string;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  audioBuffer?: AudioBuffer;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
}

export interface InOutPoints {
  inPoint: number | null;
  outPoint: number | null;
}

export interface SearchResult {
  wordIndex: number;
  word: Word;
  matchStart: number;         // Character position in query
  matchEnd: number;
}

export interface Settings {
  loopByDefault: boolean;
  autoNavigateAfterWords: number;  // Default: 3
  waveformColor: string;
  playheadColor: string;
  selectionColor: string;
  showTranscription: boolean;
  asrModel: 'whisper-tiny' | 'whisper-base' | 'vosk';
}
```

---

## Key Algorithms

### Waveform Extraction (Performance Critical)

```typescript
// Bucket-based downsampling for overview
function extractWaveformBuckets(
  pcmData: Float32Array,
  bucketCount: number
): { min: number; max: number }[] {
  const samplesPerBucket = Math.ceil(pcmData.length / bucketCount);
  const buckets: { min: number; max: number }[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, pcmData.length);

    let min = Infinity;
    let max = -Infinity;

    for (let j = start; j < end; j++) {
      const sample = pcmData[j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    buckets.push({ min, max });
  }

  return buckets;
}
```

### Frame-Accurate Sync (from window-cleaner)

```typescript
// useFrameSync pattern
function useFrameSync() {
  const currentTime = ref(0);
  const isScrubbing = ref(false);
  let rafId: number | null = null;
  let lastSeekTime = 0;
  const SEEK_THROTTLE = 50; // ms

  function startSync(audioElement: HTMLAudioElement) {
    const update = () => {
      if (!isScrubbing.value) {
        currentTime.value = audioElement.currentTime;
      }
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
  }

  function scrub(time: number) {
    const now = performance.now();
    if (now - lastSeekTime >= SEEK_THROTTLE) {
      currentTime.value = time;
      lastSeekTime = now;
    }
  }

  return { currentTime, isScrubbing, startSync, scrub };
}
```

### Search with Auto-Navigate

```typescript
function searchTranscription(
  words: Word[],
  query: string,
  minWords: number = 3
): SearchResult[] {
  const queryWords = query.toLowerCase().split(/\s+/);

  if (queryWords.length < minWords) {
    return [];
  }

  const results: SearchResult[] = [];
  const fullText = words.map(w => w.text.toLowerCase()).join(' ');
  const searchQuery = queryWords.join(' ');

  let searchIndex = 0;
  while (true) {
    const foundIndex = fullText.indexOf(searchQuery, searchIndex);
    if (foundIndex === -1) break;

    // Find corresponding word
    let charCount = 0;
    for (let i = 0; i < words.length; i++) {
      if (charCount >= foundIndex) {
        results.push({
          wordIndex: i,
          word: words[i],
          matchStart: foundIndex,
          matchEnd: foundIndex + searchQuery.length
        });
        break;
      }
      charCount += words[i].text.length + 1; // +1 for space
    }

    searchIndex = foundIndex + 1;
  }

  return results;
}
```

---

## Implementation Phases

### Phase 1: Project Setup & Audio Loading
- [ ] Project scaffolding (Tauri 2.0 + Vue 3)
- [ ] Basic app layout with three windows
- [ ] Audio file import (FFmpeg)
- [ ] Waveform data extraction
- [ ] Web Audio API setup

### Phase 2: Full Waveform View
- [ ] Canvas-based waveform rendering
- [ ] Selection window overlay
- [ ] Drag to reposition selection
- [ ] Resize from both edges
- [ ] Click-to-seek

### Phase 3: Zoomed Waveform View
- [ ] Zoomed canvas rendering
- [ ] Frame-accurate playhead
- [ ] Synchronized scrolling
- [ ] Loop playback
- [ ] In/Out point markers

### Phase 4: Transcription
- [ ] Whisper.cpp integration (Rust)
- [ ] Word-level alignment
- [ ] Word timeline component
- [ ] Transcription display under waveform

### Phase 5: Search
- [ ] Search bar component
- [ ] Auto-navigate after 3 words
- [ ] Highlight matching words
- [ ] Selection window auto-positioning

### Phase 6: Track System
- [ ] Track list component
- [ ] Clip creation (in/out → track)
- [ ] Track muting
- [ ] Track deletion (restore)
- [ ] Multi-track playback

### Phase 7: Export & Settings
- [ ] Audio export (full/clip)
- [ ] Settings panel
- [ ] Keyboard shortcuts
- [ ] Performance optimization

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `I` | Set In Point |
| `O` | Set Out Point |
| `C` | Create Clip from In/Out |
| `L` | Toggle Loop |
| `Home` | Jump to Start |
| `End` | Jump to End |
| `[` | Jump to In Point |
| `]` | Jump to Out Point |
| `Delete` | Delete Selected Track |
| `Cmd/Ctrl + S` | Save Project |
| `Cmd/Ctrl + E` | Export |
| `Cmd/Ctrl + F` | Focus Search |

---

## Performance Optimizations

1. **Waveform Rendering**
   - Pre-compute waveform buckets on import
   - Use OffscreenCanvas for background rendering
   - Implement viewport culling (only draw visible)
   - Cache rendered canvas regions

2. **Playback Sync**
   - requestAnimationFrame for UI updates
   - Throttle seek operations (50ms)
   - Use CSS transforms for playhead (GPU)
   - Batch state updates

3. **Memory Management**
   - Stream large audio files
   - Release unused AudioBuffers
   - Limit undo history

4. **ASR Processing**
   - Run in separate thread (Rust)
   - Stream results as available
   - Cache transcription results

---

## Verification Plan

### Testing
- Unit: Waveform extraction, search algorithm, time calculations
- Integration: Audio import → transcription → clip workflow
- Performance:
  - 1-hour audio file load < 5s
  - Smooth 60fps during scrubbing
  - No audio dropouts during playback
  - Memory usage < 500MB for 1-hour file

### Manual Testing
- Import various audio formats (MP3, WAV, FLAC, M4A)
- Test selection window at various zoom levels
- Verify clip creation and deletion workflow
- Test search with different query lengths
- Stress test with long audio files (2+ hours)

---

## Dependencies

### Frontend (package.json)
- vue: ^3.4
- pinia: ^2.1
- @tauri-apps/api: ^2.0
- tailwindcss: ^3.4

### Backend (Cargo.toml)
- tauri: 2.0
- whisper-rs: CPU-only Whisper bindings
- symphonia: Audio decoding
- hound: WAV handling
- rubato: Resampling
- serde: Serialization
