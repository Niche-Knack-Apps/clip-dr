# Multi-Source Recording & Audio Routing -- Research & Implementation Reference

## Table of Contents
1. [Context & Goals](#context--goals)
2. [Current Architecture](#current-architecture)
3. [Platform Research: Device Enumeration](#platform-research-device-enumeration)
4. [cpal 0.15 Capabilities & Limitations](#cpal-015-capabilities--limitations)
5. [Multi-Device Simultaneous Recording](#multi-device-simultaneous-recording)
6. [UI/UX Research & Best Practices](#uiux-research--best-practices)
7. [Implementation Plan (Phased)](#implementation-plan-phased)
8. [File Reference Map](#file-reference-map)
9. [Sources](#sources)

---

## Context & Goals

Clip Dr. currently supports single-source recording (one microphone OR system audio at a time). The goal is to evolve into a multi-source recording system where users can:

1. **See ALL available audio devices** (inputs + outputs) on Linux, Windows, macOS
2. **Select any device from a dropdown** with live activity monitoring (VU meter or mini waveform)
3. **Record from MULTIPLE sources simultaneously** (multiple mics + multiple system interfaces)
4. **Route playback to any specific output device** (not just the OS default)
5. **Each source records to its own track**, aligned by recording start time
6. **Audio is sacred** -- always recoverable, even after crashes
7. **Performance-maxed, memory-safe** -- lock-free audio paths, no allocations in callbacks

### Design Principles
- Feature-by-feature implementation, tested between each commit
- Progressive disclosure UI: simple by default, complex when needed
- Backward compatible with current single-source recording
- No cpal version upgrade required (stay on 0.15, design for future 0.17+ upgrade)

---

## Current Architecture

### Recording Pipeline (Rust Backend)

**File:** `src-tauri/src/commands/recording.rs` (2,417 lines)

#### Global Static State (THE MAIN REFACTOR TARGET)
```
recording.rs:43   static RECORDING_STREAM: Mutex<Option<StreamHolder>>
recording.rs:44   static MONITOR_STREAM: Mutex<Option<StreamHolder>>
recording.rs:68   static RECORDING_STATE: Arc<Mutex<Option<RecordingState>>>
recording.rs:69   static RECORDING_ACTIVE: AtomicBool
recording.rs:70   static MONITORING_ACTIVE: AtomicBool
recording.rs:71   static SYSTEM_MONITOR_ACTIVE: AtomicBool
recording.rs:72   static SYSTEM_MONITOR_CHILD: Arc<Mutex<Option<Child>>>
recording.rs:73   static CURRENT_LEVEL: AtomicU32
recording.rs:77   static SYSTEM_WAV_WRITER: Arc<Mutex<Option<AudioWriter>>>
recording.rs:79   static SYSTEM_SEGMENT_BASE_PATH: Mutex<Option<PathBuf>>
recording.rs:80   static SYSTEM_COMPLETED_SEGMENTS: Mutex<Vec<PathBuf>>
recording.rs:87   static SYSTEM_SEGMENT_DATA_BYTES: AtomicUsize
recording.rs:89   static SYSTEM_SEGMENT_INDEX: AtomicUsize
```

**Problem:** All globals assume ONE recording at a time. `RECORDING_ACTIVE` is a single bool. `CURRENT_LEVEL` is a single value. Multi-source recording requires per-session state.

#### Key Structs
```
recording.rs:18   struct StreamHolder           -- wraps cpal::Stream with unsafe Send
recording.rs:48   pub struct AudioDevice        -- {id, name, is_default, is_input, is_loopback}
recording.rs:57   pub struct RecordingResult     -- {path, duration, sample_rate, channels, extra_segments}
recording.rs:91   struct RecordingState          -- {output_path, sample_rate, channels, ring, writer_handle, ...}
recording.rs:109  struct RecordingRingBuffer     -- lock-free SPSC: data, capacity, write_pos, read_pos, active, overrun_count
recording.rs:189  struct Rf64Writer              -- custom RF64 WAV writer (JUNK->ds64 upgrade at ~4GB)
recording.rs:338  enum AudioWriter              -- Hound(WavWriter) | Rf64(Rf64Writer)
recording.rs:1683 pub struct ConfigInfo          -- {sample_format, sample_rate, channels}
recording.rs:1691 pub struct DeviceTestResult    -- {working, configs, error, detected_signal, ...}
recording.rs:2075 pub struct SystemAudioInfo     -- {available, method, monitor_source, cpal_monitor_device}
```

#### Key Functions
```
recording.rs:159  fn segment_path()              -- generates segment file paths (_002.wav, _003.wav)
recording.rs:368  fn spawn_wav_writer_thread()   -- creates writer thread draining ring buffer to disk
recording.rs:588  fn patch_wav_header_if_needed() -- safety net for WAV header overflow
recording.rs:659  pub async fn list_audio_devices()  -- enumerates cpal input devices + pw-cli monitors
recording.rs:750  pub async fn start_recording()     -- opens cpal stream, creates writer, begins capture
recording.rs:907  (spawns writer thread)
recording.rs:924-928 (builds input stream per sample format: F32, I16, U16, I32, U8)
recording.rs:942  fn build_input_stream<T>()     -- creates cpal input stream with ring buffer callback
recording.rs:1015 pub async fn stop_recording()  -- stops stream, joins writer, patches headers, fsync
recording.rs:1136 pub fn get_recording_level()   -- reads CURRENT_LEVEL atomic (0-1000 -> 0.0-1.0)
recording.rs:1147 pub async fn cancel_recording() -- drops stream, cleans up files
recording.rs:1195 pub async fn start_monitoring() -- opens input stream for level metering only
recording.rs:1304 pub fn stop_monitoring()
recording.rs:1317 fn kill_all_stale_processes()   -- pkill pw-record/parec/parecord
recording.rs:1399 pub async fn start_system_audio_monitoring()  -- spawns parec/pw-record subprocess
recording.rs:1414 pub fn stop_system_audio_monitoring()
recording.rs:1438 fn system_audio_monitor_reader() -- reads f32 from subprocess stdout, updates level + writes
recording.rs:1534 pub fn reset_recording_state() -- force-resets all globals
recording.rs:1562 pub fn test_audio_device()     -- 200ms test stream on a device
recording.rs:1699 pub fn check_input_muted()     -- wpctl/pactl mute check (Linux)
recording.rs:1746 pub async fn start_system_audio_recording()  -- begins accumulating from monitor subprocess
recording.rs:1915 pub async fn stop_system_audio_recording()   -- finalizes system audio WAV
recording.rs:2037 pub fn unmute_input()          -- wpctl/pactl unmute (Linux)
recording.rs:2086 pub fn probe_system_audio()    -- tests parec/pw-record/cpal monitor availability
recording.rs:2232 fn find_cpal_monitor_device()  -- finds PipeWire monitor via cpal enumeration
```

#### Ring Buffer Architecture (Lock-Free SPSC)
```
recording.rs:109-154  RecordingRingBuffer
  - data: *mut f32 (raw pointer to heap-allocated buffer)
  - capacity: usize (10 seconds at device sample rate * channels)
  - write_pos: AtomicUsize (producer: audio callback thread)
  - read_pos: AtomicUsize (consumer: writer thread)
  - active: AtomicBool (signals writer to stop)
  - overrun_count: AtomicUsize (telemetry)
  - max_fill_level: AtomicUsize (telemetry)
  - bad_channel: AtomicI32 (-1=none, 0=left, 1=right)
```

**Audio callback** (recording.rs:942-1012):
- Wrapped in `panic::catch_unwind()` for ALSA timing panics
- Converts sample format (f32/i16/u16/i32/u8) -> f32
- Writes to ring buffer via raw pointer arithmetic (zero allocation)
- Updates `CURRENT_LEVEL` atomically (scaled 0-1000)

**Writer thread** (recording.rs:368-526):
- Drains ring buffer to disk via hound or Rf64Writer
- Bad-channel fixup: duplicates good channel if one is clipped
- Segment splitting at 3,900,000,000 bytes
- RF64 header patching every ~2 seconds

#### System Audio (Linux-Specific Subprocess)
```
recording.rs:1333-1394  start_system_audio_monitoring_impl()
  - Detects PipeWire or PulseAudio
  - Spawns pw-record or parec subprocess capturing default monitor
  - Pipes stdout to reader thread
  - parec: --format=float32le --rate=44100 --channels=2
  - pw-record: --format=f32 --rate=44100 --channels=2

recording.rs:1438-1530  system_audio_monitor_reader()
  - Reads f32le samples from subprocess stdout (4096-byte chunks)
  - Always updates CURRENT_LEVEL (metering)
  - When RECORDING_ACTIVE: writes to SYSTEM_WAV_WRITER, handles segment splits
```

### Playback Pipeline (Rust Backend)

**File:** `src-tauri/src/commands/playback.rs` (2,639 lines)

#### Key Structs
```
playback.rs:20    pub struct AutomationPoint     -- {time, value}
playback.rs:26    pub struct PlaybackTrackConfig  -- {track_id, source_path, track_start, duration, volume, muted, volume_envelope}
playback.rs:38    struct TrackSource             -- loaded track with PcmData, config, sample_rate, channels
playback.rs:46    enum PcmData                   -- Mmap{mmap,data_offset,sample_count} | Vec(Vec<f32>) | Stream(Arc<StreamBuffer>)
playback.rs:95    struct StreamBuffer            -- lock-free ring for streaming decode (seqlock seeks)
playback.rs:230   static PLAYBACK_STREAM         -- Mutex<Option<StreamHolder>>
playback.rs:259   pub struct PlaybackEngine       -- inner: Arc<Mutex<EngineInner>>, position: AtomicU64, playing: AtomicBool, meter: Arc<MeterData>
playback.rs:268   struct EngineInner             -- tracks, output_sample_rate, speed, master_volume, track_volumes, envelopes, loop
playback.rs:292   pub struct MeterData           -- per-track + master peak/RMS via AtomicU32 arrays (MAX_METER_TRACKS)
```

#### Output Device Selection (CURRENTLY HARDCODED)
```
playback.rs:1070  fn build_output_stream(...)
playback.rs:1076    let host = cpal::default_host();
playback.rs:1077    let device = host.default_output_device()  <-- HARDCODED TO DEFAULT
playback.rs:1092    let stream = device.build_output_stream(...)
```

**To add output routing:** Modify `build_output_stream()` to accept `device_id: Option<String>`, find device in `host.output_devices()` if provided.

#### Audio Callback (Real-Time Mixing)
```
playback.rs:1092-1299  cpal output callback
  - For each output frame at timeline position:
    1. Loop boundary check (wrap at loop points)
    2. Per-track mixing: iterate tracks, map timeline pos -> track-relative pos
    3. Volume envelope evaluation with walking-pointer (O(1) amortized)
    4. Sample interpolation from PcmData
    5. Stereo mix accumulation + master volume
    6. Lock-free metering (peak/RMS via atomics)
    7. Position advance
```

#### Managed State Registration
```
main.rs:29  .manage(import::ImportState::new())
main.rs:30  .manage(playback::PlaybackEngine::new())
            -- RecordingManager will be added here (Phase 4)
```

#### Registered Commands
```
main.rs:64-81   recording:: commands (18 total)
main.rs:86-100  playback:: commands (14 total)
```

### Frontend Recording Store

**File:** `src/stores/recording.ts` (584 lines)

#### State
```
recording.ts:44   isRecording: ref(false)
recording.ts:45   isPreparing: ref(false)
recording.ts:46   isMonitoring: ref(false)
recording.ts:47   currentLevel: ref(0)
recording.ts:48   recordingDuration: ref(0)
recording.ts:49   recordingPath: ref<string | null>(null)
recording.ts:50   devices: ref<AudioDevice[]>([])
recording.ts:51   selectedDeviceId: ref<string | null>(null)
recording.ts:52   source: ref<RecordingSource>('microphone')
recording.ts:58   timemarks: ref<TimeMark[]>([])
recording.ts:59   triggerPhrases: ref<string[]>([])
recording.ts:63   systemAudioInfo: ref<SystemAudioInfo | null>(null)
recording.ts:67   placement: ref<TrackPlacement>('append')
```

#### Interfaces
```
recording.ts:11   AudioDevice {id, name, is_default, is_input, is_loopback}
recording.ts:19   RecordingResult {path, duration, sample_rate, channels, extra_segments}
recording.ts:28   RecordingSource = 'microphone' | 'system'
recording.ts:30   SystemAudioInfo {available, method, monitor_source, sink_name, test_result, cpal_monitor_device}
```

#### Key Functions
```
recording.ts:90   refreshDevices()           -- invoke('list_audio_devices')
recording.ts:108  setSource(newSource)       -- switches source, auto-selects device
recording.ts:129  probeSystemAudio()         -- invoke('probe_system_audio')
recording.ts:195  quickStart(source)         -- immediate start
recording.ts:237  startRecording()           -- full recording lifecycle
recording.ts:313  stopRecording()            -- stop + create tracks
recording.ts:365  createTrackFromRecording() -- imports segments as tracks
recording.ts:411  cancelRecording()          -- cancel + cleanup
recording.ts:473  startMonitoring()          -- start level metering
recording.ts:511  stopMonitoring()           -- stop metering
```

### UI Components

#### Recording
```
src/components/recording/RecordingPanel.vue  (453 lines)
  - 3-state UI: Source Selection -> Recording Active -> Closing
  - Source cards (microphone/system), channel mode toggle
  - Hold-to-stop (1500ms), recording lock, timemarks
  - Live waveform (60px), level meter, duration display

src/components/recording/LevelMeter.vue  (49 lines)
  - Horizontal bar meter (3px height)
  - Color: green (<70%), yellow (70-90%), red (>90%)
  - dB scale marks: -60, -24, -12, -6, 0 dB
```

#### Track Meters
```
src/components/tracks/TrackMeter.vue  (from TrackLane.vue)
  - Stereo level meter per track (two 5px channels)
  - Peak hold (2s decay), clip indicator
  - Gradient: green (0-57%) -> yellow (57-90%) -> red (90-100%)

src/components/ui/FloatingMeter.vue
  - Detachable floating meter panel

src/stores/meter.ts  (178 lines)
  - DECAY_COEFF = 0.92, PEAK_HOLD_MS = 2000
  - rAF-based polling of playback_get_meter_levels
  - Per-track + master smoothed levels
```

#### Waveform
```
src/components/waveform/LiveWaveform.vue  (166 lines)
  - Canvas-based, 200-sample history, 50ms update interval
  - Used during active recording

src/components/waveform/WaveformCanvas.vue
  - High DPI canvas, ResizeObserver debounced
  - Uses useWaveform() composable
```

#### UI Primitives
```
src/components/ui/Button.vue     -- variants: primary/secondary/ghost/danger, sizes: sm/md/lg
src/components/ui/Toggle.vue     -- boolean switch
src/components/ui/Slider.vue     -- range input with gradient fill
src/components/ui/InfiniteKnob.vue -- rotary control for zoom
```

### Settings

**File:** `src/stores/settings.ts` (347 lines)
```
settings.ts:167   defaultRecordingSource: 'microphone' | 'system'
settings.ts:172   lastRecordingSource: tracks user's last-used source
settings.ts:233   recordingChannelMode: 'mono' | 'stereo'
settings.ts:238   recordingLargeFileFormat: 'split-tracks' | 'rf64'
```
Storage: localStorage key `'clip-doctor-settings'`

### Shared Types

**File:** `src/shared/types.ts`
```
types.ts:1    AudioFile {path, name, type, size}
types.ts:62   TrackClip {id, audioData, clipStart, clipEnd, ...}
types.ts:75   VolumeAutomationPoint {id, time, value}
types.ts:84   TimeMark {id, time, label, source, color}
types.ts:110  ImportStatus = 'importing' | 'decoding' | 'ready' | 'error' | 'large-file' | 'caching'
types.ts:135  Track {id, name, audioData, trackStart, duration, color, muted, solo, volume, ...}
```

### Testing Infrastructure

**Current state: NO unit tests exist.**
- No vitest, jest, mocha in package.json
- No test scripts
- Verification: `npx vue-tsc --noEmit` + `npm run lint`
- `[dev-dependencies]` in Cargo.toml: `tempfile = "3"` (available but unused for recording tests)
- playback.rs has existing `#[cfg(test)] mod tests` with 30+ tests (good pattern to follow)

### Dependencies
```
Cargo.toml:40   cpal = "0.15"              -- audio I/O (recording + playback)
Cargo.toml:23   rubato = "0.14"            -- resampling (available for drift compensation)
Cargo.toml:24   hound = "3.5"              -- WAV reading/writing
Cargo.toml:37   memmap2 = "0.9"            -- memory-mapped file I/O
Cargo.toml:22   symphonia = "0.5"          -- compressed audio codec support
Cargo.toml:46   wasapi = "0.13"            -- Windows loopback (additional to cpal)
```

---

## Platform Research: Device Enumeration

### Linux (ALSA, PulseAudio, PipeWire, JACK)

#### cpal 0.15 Hosts Available
| Host | Feature Flag | Default? |
|------|-------------|----------|
| **ALSA** | Always included | Yes |
| **JACK** | `jack` feature flag | No (opt-in) |

PulseAudio host: Merged in cpal PR #957 (Feb 2026), available in 0.17+, NOT in 0.15.
PipeWire host: PR #938, still open, not merged anywhere.

#### What ALSA Enumeration Sees
- Built-in mic/speakers: YES (as hw:/plughw: entries)
- USB audio interfaces: YES (separate cards)
- HDMI audio: YES (separate devices on card)
- Line-in/Line-out: YES (as subdevices)
- PulseAudio devices: INDIRECTLY (via PulseAudio's ALSA plugin if configured)
- PipeWire devices: INDIRECTLY (via PipeWire's ALSA emulation layer)
- Monitor/loopback sources: NO (these are PA/PW abstractions, not ALSA devices)
- Virtual sinks: PARTIALLY (only if registered as ALSA PCM devices)

#### ALSA Enumeration Method
cpal uses two approaches:
1. `alsa::device_name::HintIter::new_str(None, "pcm")` -- virtual/user-configured devices
2. `alsa::card::Iter::new()` + `alsa::ctl::DeviceIter::new()` -- physical cards

Device names: `"hw:CARD=0,DEV=0"`, `"plughw:CARD=0,DEV=0"`, `"default"`, `"sysdefault"`

#### Monitor/Loopback Sources (Linux)
**Existing workaround** (recording.rs:706-738): Shell out to `pw-cli list-objects` to find PipeWire monitor devices. Also checks cpal-enumerated device names for "monitor"/"loopback" at recording.rs:690.

#### Additional Linux Enumeration Options
- `pactl list sources short` -- PulseAudio sources (includes monitors)
- `pw-cli list-objects` -- PipeWire nodes (all application streams)
- `pw-dump` -- detailed PipeWire object dump (JSON)
- `wpctl status` -- WirePlumber managed devices

#### ALSA Known Issues
- **Device lock contention** (cpal issue #634): `hw:` devices are exclusive (EBUSY). Use `plughw:` for shared access.
- **ALSA error spam**: Silence with `let _silence = alsa::Output::local_error_handler()?;`
- Multiple `hw:` devices on the same card cannot be opened simultaneously.

### Windows (WASAPI, ASIO)

#### cpal 0.15 Hosts Available
| Host | Feature Flag | Default? |
|------|-------------|----------|
| **WASAPI** | Always included | Yes |
| **ASIO** | `asio` feature flag | No (opt-in) |
| **JACK** | `jack` feature flag | No (opt-in) |

#### WASAPI Device Enumeration
Enumerates ALL active audio endpoints registered with Windows:
- Built-in speakers/microphones
- USB audio devices
- HDMI audio outputs
- Bluetooth audio
- Virtual devices (VB-Cable, Virtual Audio Cable, etc.)
- Stereo Mix (if enabled in Windows Sound Settings)

#### WASAPI Loopback (System Audio Capture)
**Supported in cpal 0.15.** The mechanism: call `build_input_stream()` on an **output** device. cpal detects this and sets `AUDCLNT_STREAMFLAGS_LOOPBACK` automatically.

```rust
let output_device = host.default_output_device()?;
let config = output_device.default_output_config()?;
// This triggers loopback mode automatically:
let stream = output_device.build_input_stream(&config.into(), callback, err_cb, None)?;
```

**Known quirk:** WASAPI loopback randomly switches between 960-sample and 192-sample buffer sizes.

**Note:** The project also has `wasapi = "0.13"` (Cargo.toml:46) as a Windows-specific dependency for additional loopback control.

#### ASIO
- One driver per process (cannot use two ASIO devices simultaneously)
- Requires LLVM/Clang + ASIO SDK for building
- Mainly useful for professional interfaces (Focusrite, RME, MOTU)
- Input/output streams must be configured simultaneously (duplex constraint)

### macOS (CoreAudio)

#### cpal 0.15 Hosts Available
| Host | Feature Flag | Default? |
|------|-------------|----------|
| **CoreAudio** | Always included | Yes |
| **JACK** | `jack` feature flag | No (opt-in) |

#### CoreAudio Device Enumeration
Enumerates all registered audio devices:
- Built-in microphone and speakers
- USB audio interfaces
- Bluetooth audio devices
- AirPlay destinations
- Virtual devices (BlackHole, Soundflower, Loopback by Rogue Amoeba)
- Aggregate devices (created in Audio MIDI Setup)

#### System Audio Capture (macOS)
**cpal 0.15 has NO native loopback/system audio capture on macOS.**

CoreAudio Tap API (via `AudioHardwareCreateProcessTap`) was added in cpal PR #1003 for macOS 14.6+, but that's cpal 0.17+.

Options for cpal 0.15:
1. **BlackHole** or **Soundflower** -- virtual audio device (user must install)
2. **Aggregate Device** -- combine virtual device + real output in Audio MIDI Setup
3. **ScreenCaptureKit** (macOS 13+) -- requires separate `screencapturekit-rs` crate

---

## cpal 0.15 Capabilities & Limitations

### Can Do
- Enumerate all ALSA hardware devices (hw:, plughw:, default, sysdefault)
- Enumerate all WASAPI input/output endpoints on Windows
- Enumerate all CoreAudio devices on macOS
- WASAPI loopback capture (system audio on Windows)
- Open multiple concurrent streams on different devices (except ASIO)
- Get device name, supported configs (sample rates, channels, formats)
- Build input/output streams on any specific enumerated device
- JACK support via feature flag

### Cannot Do (available in 0.17+)
- PulseAudio native host (no monitor source enumeration)
- PipeWire native host (not merged yet)
- CoreAudio loopback/tap (macOS system audio capture)
- Stable device IDs (`Device::id()`)
- Device descriptions (`Device::description()`)
- `Stream: Send` (requires unsafe wrapper)
- Synchronized duplex streams

### Device Identification
In cpal 0.15, only `device.name()` is available. No `device.id()` or `device.description()`.
Our existing code uses name-based matching (recording.rs:690-692).
Stable device IDs would require cpal 0.17+ or platform-specific APIs.

### Existing Workarounds in Codebase
- `StreamHolder` with `unsafe impl Send` -- recording.rs:18-40
- `pw-cli list-objects` shell-out for PipeWire monitors -- recording.rs:706-738
- Name-based loopback detection -- recording.rs:690-692
- `wasapi = "0.13"` crate for Windows system audio -- Cargo.toml:46

---

## Multi-Device Simultaneous Recording

### Can cpal Open Multiple Input Streams?
**Yes, with platform caveats:**

| Platform | Multiple Streams? | Notes |
|----------|------------------|-------|
| **ALSA** | Limited | `hw:` exclusive, `plughw:` shared. Different cards OK. |
| **WASAPI** | Yes (shared mode) | Multiple shared-mode streams fine. Exclusive mode locks device. |
| **CoreAudio** | Yes | No known restrictions. |
| **ASIO** | NO | One driver per process. |
| **JACK** | Yes | All ports managed by JACK server. |

### Thread Model
Each `build_input_stream()` creates a dedicated high-priority thread. Memory per stream: minimal (<1MB for kernel buffers + callback buffer).

### Clock Drift Between Devices
Different physical devices have independent clock crystals. Drift: typically 1-50 ppm.
- At 48kHz, 10ppm = ~0.48 samples/second divergence
- Over 1 hour: ~1728 samples (~36ms) drift

**Compensation Strategies:**
1. **Resampling** with `rubato` (already in Cargo.toml) -- dynamically adjust ratio based on buffer fill levels
2. **Timestamp-based alignment** -- cpal provides `InputStreamTimestamp` with `callback`/`capture` `StreamInstant`
3. **Ring buffer monitoring** -- track fill rate vs wall-clock time per stream
4. **Post-processing alignment** -- since each device records to its own track, let the user or algorithm align in post (simplest approach for initial implementation)

### Memory Safety
- Each session gets its own `RecordingRingBuffer` and `Arc<AtomicU32>` level
- Audio callbacks capture `Arc`s of per-session state (no global contention)
- No allocation in audio callback path
- Ring buffer overrun: drops samples (telemetry), never blocks

---

## UI/UX Research & Best Practices

### Device Selection Patterns (From Professional DAWs)

**Audacity Model** -- Toolbar dropdowns:
1. Host dropdown (ALSA/WASAPI/CoreAudio)
2. Recording Device dropdown (filtered by host)
3. Recording Channels dropdown (Mono/Stereo)
4. Playback Device dropdown
5. Rescan button for hot-plug detection

**Reaper Model** -- Right-click context menus per track for input selection. Scales better for multi-track.

**Hindenburg Model** -- Per-track dropdown in track header. Simplest model for speech/podcast.

**OBS Studio Model** -- Configure 2 output + 4 input devices. Additional via "Add Source". Each gets VU meter + volume + mute. Best model for multi-source monitoring.

### Multi-Track Simultaneous Recording
- Most DAWs bind to single audio device; multi-device requires aggregate devices or virtual routing
- **Our approach is better:** Tauri/Rust backend opens multiple cpal streams independently
- Ableton: Cmd/Ctrl+click to arm multiple tracks (safety feature)
- OBS: Multiple mixer strips with independent VU meters

### Audio Routing UI
| Approach | Best For | Examples |
|----------|----------|---------|
| Per-track dropdown | Simple input/output assignment | Logic, Hindenburg, Audacity |
| Mixer strips | Per-track volume/pan/effects | Ableton, GarageBand |
| Routing matrix | Complex many-to-many connections | Ardour Patchbay, hardware interfaces |
| Visual cables | Educational/skeuomorphic | Reason |

### Activity Monitoring (Pre-Recording)
- **VU bars**: Quick to read, standard green/yellow/red gradient, peak hold. Best for device lists.
- **Scrolling waveforms**: Show temporal pattern. Best for confirming audio is "real."
- **Recommendation**: VU bars in device list (compact), scrolling waveform in recording view.

### Color Coding (Industry Standard)
- **Blue**: Input devices (microphones, line-in)
- **Green**: Output devices (speakers, headphones)
- **Purple/Violet**: Loopback/virtual devices (system audio)
- **Gray**: Inactive/disconnected

### Progressive Disclosure Strategy
**Level 0 -- Zero Config (default):**
- Auto-detect default mic + output. Single "Record" button.

**Level 1 -- Simple Device Selection:**
- One input dropdown with VU preview, one output dropdown, channel selector.

**Level 2 -- Multi-Source Recording:**
- "+ Add Source" button. Each source -> own track with input selector + VU.
- Record-arm toggles per track.

**Level 3 -- Advanced Routing (power users):**
- Routing matrix (inputs as rows, tracks as columns). Per-track output routing.

### Safety & Recovery Patterns

**Pre-Recording Buffer** (Logic Pro "Capture Recording"):
- Circular buffer continuously captures audio during monitoring
- When recording starts, buffer contents prepended
- Default: 5-10 seconds. Logic uses it for MIDI; Cubase for audio.

**Crash Recovery** (Audacity model):
- Continuous state snapshots during recording
- On crash restart: recovery dialog with Recover/Discard/Skip
- Recording files written incrementally to disk (not buffered in RAM)

**Write-Through**:
- WAV data written incrementally during recording (already implemented)
- RF64 header patched every 2 seconds (already implemented at recording.rs:189-334)
- fsync() at finalization (already implemented)

**Redundant Recording**: Some pro setups write to two drives. Out of scope for now.

---

## Implementation Plan (Phased)

### Phase 1: Test Infrastructure

**Goal:** Establish Rust + TypeScript test foundations. Every subsequent phase adds tests.

**Rust Backend:**
- Add `#[cfg(test)] mod tests` to `recording.rs`
- Tests (no hardware required):
  - `test_ring_buffer_basic` -- write/read SPSC cycle
  - `test_ring_buffer_overrun` -- verify overrun_count increments
  - `test_ring_buffer_bad_channel_detection` -- clipped channel detection
  - `test_segment_path` -- verify path generation (_002.wav, _003.wav)
  - `test_rf64_writer_header` -- write samples, verify WAV header bytes
  - `test_audio_writer_enum` -- both Hound and Rf64 variants write/finalize
  - `test_patch_wav_header` -- corrupt header, verify fix
- May need to extract `RecordingRingBuffer` to make fields accessible to tests (currently private)

**TypeScript Frontend:**
- Install vitest + @vue/test-utils (`devDependencies`)
- Add vitest.config.ts with path aliases (@, @shared)
- Add `"test": "vitest run"` to package.json scripts
- Initial tests:
  - `recording-store.test.ts` -- device filtering (microphoneDevices, loopbackDevices), timemark CRUD
  - `level-meter.test.ts` -- LevelMeter.vue renders correct colors at different levels

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- add test module
- `package.json` -- add vitest deps + test scripts

**Files to create:**
- `vitest.config.ts`
- `src/__tests__/recording-store.test.ts`
- `src/__tests__/level-meter.test.ts`

**Verification:**
```bash
cd src-tauri && cargo test -- --nocapture
cd .. && npm run test
npx vue-tsc --noEmit && npm run lint
```

---

### Phase 2: Enhanced Device Enumeration

**Goal:** Discover ALL input AND output devices on all platforms. Enrich AudioDevice struct.

**Rust Backend:**
- Expand `AudioDevice` struct (recording.rs:48):
  ```
  + is_output: bool
  + device_type: String       // "microphone", "output", "loopback", "virtual", "monitor"
  + channels: u16             // max channel count
  + sample_rates: Vec<u32>    // supported sample rates
  + platform_id: String       // platform-specific ID for stable reconnection
  ```
- Create `list_all_audio_devices()` command:
  - Linux: cpal ALSA input/output + pw-cli monitors
  - Windows: WASAPI input + output, mark outputs as loopback-capable
  - macOS: CoreAudio input/output, detect virtual devices by name
  - Query `supported_input_configs()` / `supported_output_configs()` per device
- Keep old `list_audio_devices()` as backward-compatible wrapper
- Add `get_device_capabilities(device_id)` for detailed per-device info

**Frontend:**
- Update `AudioDevice` interface in recording.ts:11
- Add `outputDevices` computed
- Add `allDevices` ref + `refreshAllDevices()` action
- No UI changes yet (data available for Phase 3)

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- expand AudioDevice, add commands
- `src-tauri/src/main.rs` -- register new commands
- `src/stores/recording.ts` -- update interface, add computeds

**Tests:**
- Rust: `test_list_all_devices_no_panic`, `test_device_type_categorization`, `test_backward_compat`
- TS: `test_output_devices_computed`, `test_all_devices_grouping`

---

### Phase 3: Device Selection UI + Per-Device VU Meters

**Goal:** Dropdown device selection with live activity monitoring before recording.

**Rust Backend:**
- Add `start_device_preview(device_id)` -- separate `PREVIEW_STREAM` + `PREVIEW_LEVEL` atomic
- Add `get_device_preview_level(device_id) -> f32`
- Add `stop_device_preview()`

**Frontend:**
- Create `DevicePicker.vue` in `src/components/recording/`:
  - Grouped device list: Microphones (blue), System Audio (purple)
  - Radio button selection per device
  - Inline horizontal VU meter per device row
- Create `DeviceMeter.vue` in `src/components/recording/`:
  - Tiny horizontal bar (green/yellow/red gradient)
  - Polls preview level at 100ms
- Update `RecordingPanel.vue`: Replace source cards with DevicePicker

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- add preview commands
- `src-tauri/src/main.rs` -- register commands
- `src/components/recording/RecordingPanel.vue` -- replace source cards
- `src/stores/recording.ts` -- add preview state/actions

**Files to create:**
- `src/components/recording/DevicePicker.vue`
- `src/components/recording/DeviceMeter.vue`

**Tests:**
- Rust: `test_preview_lifecycle`
- TS: `test_device_picker_groups`, `test_device_picker_emits_select`, `test_device_meter_colors`

---

### Phase 4: Per-Stream Recording Architecture (CRITICAL REFACTOR)

**Goal:** Replace global static state with per-session model. Foundation for multi-source.

**Rust Backend (major refactor):**
- Define `RecordingSession`:
  ```rust
  struct RecordingSession {
      id: String,
      device_id: String,
      device_name: String,
      stream: Option<StreamHolder>,
      ring_buffer: Arc<RecordingRingBuffer>,
      writer_handle: Option<JoinHandle<...>>,
      level: Arc<AtomicU32>,
      active: Arc<AtomicBool>,
      start_time: Instant,
  }
  ```
- Define `RecordingManager`:
  ```rust
  pub struct RecordingManager {
      sessions: Mutex<HashMap<String, RecordingSession>>,
      system_sessions: Mutex<HashMap<String, SystemAudioSession>>,
  }
  ```
- Register as Tauri managed state: `main.rs:29` area, `.manage(RecordingManager::new())`
- Refactor ALL commands to use `State<'_, RecordingManager>`:
  - `start_recording(session_id, device_id, ...)` -- creates a session
  - `stop_recording(session_id)` -- stops specific session
  - `get_recording_level(session_id)` -- per-session level
  - `cancel_recording(session_id)` -- cancels specific session
  - `list_active_recordings()` -- returns all active sessions
- **Backward compat:** Old signatures map to `"default"` session ID internally
- `build_input_stream` captures per-session `Arc`s instead of globals

**Frontend:**
- Add `RecordingSession` interface
- Change `isRecording` to computed: `sessions.value.length > 0`
- Add `sessions: ref<RecordingSession[]>([])`
- Level polling polls per-session
- **Still single-session only** (architecture change, not multi-source yet)

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- MAJOR: replace all globals with RecordingManager
- `src-tauri/src/main.rs` -- add `.manage(RecordingManager::new())`
- `src/stores/recording.ts` -- session model
- `src/components/recording/RecordingPanel.vue` -- use session-based API

**Tests:**
- Rust: `test_manager_create_session`, `test_manager_multiple_sessions`, `test_session_cleanup`, `test_backward_compat`, `test_per_session_level_isolation`
- TS: `test_sessions_computed`, `test_session_lifecycle`

---

### Phase 5: Multi-Source Simultaneous Recording

**Goal:** Record from multiple devices at the same time.

**Rust Backend:**
- Remove single-session restriction from RecordingManager
- Add `start_multi_recording(sessions: Vec<SessionConfig>)`:
  - Opens all streams, calls `.play()` in tight loop (minimize start skew)
  - Stores shared `start_instant: Arc<Instant>` for alignment
  - Returns Vec of output paths
- Add `stop_all_recordings()`:
  - Sets all active flags to false, joins all writers
  - Returns Vec<RecordingResult> with `start_offset_us: i64` per session

**Frontend:**
- Multi-select mode in DevicePicker (checkboxes)
- "Record All" button when 2+ devices selected
- `ActiveSessions.vue`: shows each session as a row (device name, VU, stop button)
- `createTrackFromRecording()` called per session result, creating aligned tracks

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- multi-session commands
- `src-tauri/src/main.rs` -- register commands
- `src/stores/recording.ts` -- multi-source selection
- `src/components/recording/RecordingPanel.vue` -- multi-select UI
- `src/components/recording/DevicePicker.vue` -- checkbox mode

**Files to create:**
- `src/components/recording/ActiveSessions.vue`

**Tests:**
- Rust: `test_multi_recording_start`, `test_stop_all`, `test_start_offset`, `test_system_and_cpal_simultaneous`
- TS: `test_multi_select`, `test_active_sessions`, `test_aligned_tracks`

---

### Phase 6: Output Device Routing

**Goal:** Route playback to any specific output device.

**Rust Backend:**
- Modify `build_output_stream()` (playback.rs:1070) to accept `device_id: Option<String>`
- If provided, find device in `host.output_devices()` instead of `default_output_device()`
- Add `playback_set_output_device(device_id: Option<String>)`:
  - Pause -> drop old stream -> build new on target device -> seek to saved position -> resume
- Add `playback_get_output_device() -> Option<AudioDevice>`

**Frontend:**
- Add `outputDeviceId: ref<string | null>(null)` to playback store
- Add `setOutputDevice(deviceId)` action
- Create `OutputDeviceSelector.vue` (compact dropdown in bottom bar or settings)

**Files to modify:**
- `src-tauri/src/commands/playback.rs` -- modify build_output_stream, add commands
- `src-tauri/src/main.rs` -- register commands
- `src/stores/playback.ts` -- output device state

**Files to create:**
- `src/components/ui/OutputDeviceSelector.vue`

**Tests:**
- Rust: `test_build_output_default`, `test_build_output_specific`, `test_swap_preserves_position`, `test_fallback_on_missing`
- TS: `test_output_selector_renders`, `test_set_output_device`

---

### Phase 7: Pre-Recording Buffer + Crash Recovery

**Goal:** "Audio is sacred" -- capture audio before record, recover after crashes.

**Pre-Recording Buffer (Rust):**
- `PreRecordBuffer` struct: lock-free circular buffer (configurable, default 10s)
  ```rust
  struct PreRecordBuffer {
      data: Box<[f32]>,
      data_ptr: *mut f32,
      capacity: usize,
      write_head: AtomicUsize,
      channels: u16,
      sample_rate: u32,
  }
  ```
- Wire into monitoring: audio callback also writes to PreRecordBuffer
- On recording start: drain buffer into WAV writer (prepend pre-record audio)
- `RecordingResult` includes `pre_record_seconds: f64`

**Crash Recovery (Rust):**
- `scan_orphaned_recordings(project_dir)` -- find unfinished WAV files on launch
- `recover_recording(path)` -- patch headers of truncated WAV, return metadata
- Header flushing already implemented (RF64: every 2s)

**Frontend:**
- `preRecordSeconds: ref<number>(10)` setting
- On result: adjust track start time by subtracting pre_record_offset
- On launch: call `scan_orphaned_recordings`, show recovery banner if found
- `OrphanRecovery.vue`: notification banner with Recover/Dismiss

**Files to modify:**
- `src-tauri/src/commands/recording.rs` -- PreRecordBuffer, orphan scanning, recovery
- `src-tauri/src/main.rs` -- register commands, orphan scan in setup
- `src/stores/recording.ts` -- pre-record settings, recovery
- `src/stores/settings.ts` -- add preRecordSeconds to settings

**Files to create:**
- `src/components/recording/OrphanRecovery.vue`

**Tests:**
- Rust: `test_pre_record_circular`, `test_pre_record_drain`, `test_orphan_scan`, `test_recover_truncated`
- TS: `test_pre_record_setting`, `test_orphan_banner`

---

## File Reference Map

### Rust Backend (src-tauri/)
| File | Lines | Role | Modified In |
|------|-------|------|-------------|
| `src/commands/recording.rs` | 2417 | Recording engine, device enum, ring buffer | Phases 1-5, 7 |
| `src/commands/playback.rs` | 2639 | Playback engine, mixing, metering | Phase 6 |
| `src/main.rs` | ~110 | Command registration, managed state | Phases 2-7 |
| `Cargo.toml` | 57 | Dependencies | Phase 1 (if adding test deps) |

### Frontend (src/)
| File | Lines | Role | Modified In |
|------|-------|------|-------------|
| `stores/recording.ts` | 584 | Recording state management | Phases 2-5, 7 |
| `stores/playback.ts` | 634 | Playback state management | Phase 6 |
| `stores/settings.ts` | 347 | User settings | Phase 7 |
| `stores/meter.ts` | 178 | Level metering | Reference |
| `stores/audio.ts` | 548 | Audio import pipeline | Reference |
| `stores/tracks.ts` | ~1000 | Track management | Reference |
| `shared/types.ts` | ~400 | Shared TypeScript types | Phase 2 |
| `components/recording/RecordingPanel.vue` | 453 | Main recording UI | Phases 3-5 |
| `components/recording/LevelMeter.vue` | 49 | Level meter component | Reference |
| `components/waveform/LiveWaveform.vue` | 166 | Live recording waveform | Reference |
| `components/ui/FloatingMeter.vue` | - | Detachable meter | Reference |
| `components/ui/Button.vue` | - | Button component | Reference |
| `components/ui/Toggle.vue` | - | Toggle switch | Reference |
| `components/ui/Slider.vue` | - | Range slider | Reference |

### New Files to Create
| File | Created In | Role |
|------|-----------|------|
| `vitest.config.ts` | Phase 1 | Test configuration |
| `src/__tests__/recording-store.test.ts` | Phase 1 | Recording store tests |
| `src/__tests__/level-meter.test.ts` | Phase 1 | Level meter tests |
| `src/components/recording/DevicePicker.vue` | Phase 3 | Device selection UI |
| `src/components/recording/DeviceMeter.vue` | Phase 3 | Per-device VU meter |
| `src/components/recording/ActiveSessions.vue` | Phase 5 | Multi-session display |
| `src/components/ui/OutputDeviceSelector.vue` | Phase 6 | Output device dropdown |
| `src/components/recording/OrphanRecovery.vue` | Phase 7 | Crash recovery banner |

---

## Sources

### cpal Documentation & Issues
- [cpal 0.15.3 docs.rs](https://docs.rs/cpal/0.15.3/cpal/)
- [DeviceTrait docs (0.15.3)](https://docs.rs/cpal/0.15.3/cpal/traits/trait.DeviceTrait.html)
- [HostTrait docs](https://docs.rs/cpal/latest/cpal/traits/trait.HostTrait.html)
- [cpal GitHub Repository](https://github.com/RustAudio/cpal)
- [DeepWiki: RustAudio/cpal](https://deepwiki.com/RustAudio/cpal)
- [WASAPI Loopback Issue #251](https://github.com/RustAudio/cpal/issues/251)
- [WASAPI Loopback Re-enable Issue #476](https://github.com/RustAudio/cpal/issues/476)
- [ALSA Enumeration Issue #357](https://github.com/RustAudio/cpal/issues/357)
- [ALSA Device Open Issue #634](https://github.com/RustAudio/cpal/issues/634)
- [Timestamp API Proposal #363](https://github.com/RustAudio/cpal/issues/363)
- [Stream Send Issue #818](https://github.com/RustAudio/cpal/issues/818)
- [Duplex Stream Issue #349](https://github.com/RustAudio/cpal/issues/349)
- [PulseAudio PR #957](https://github.com/RustAudio/cpal/pull/957)
- [PipeWire PR #938](https://github.com/RustAudio/cpal/pull/938)
- [ScreenCaptureKit Issue #876](https://github.com/RustAudio/cpal/issues/876)
- [ScreenCaptureKit PR #894](https://github.com/RustAudio/cpal/pull/894)
- [ASIO Backend DeepWiki](https://deepwiki.com/RustAudio/cpal/3.2.2-asio-backend)
- [Building cpal DeepWiki](https://deepwiki.com/RustAudio/cpal/4-building-and-using-cpal)

### DAW UI/UX Patterns
- [Audacity Audio Setup Toolbar](https://manual.audacityteam.org/man/audio_setup_toolbar.html)
- [Audacity Crash Recovery](https://manual.audacityteam.org/man/recovery.html)
- [Audacity Device Selection Tutorial](https://manual.audacityteam.org/man/tutorial_selecting_your_recording_device.html)
- [Reaper Record Arm Guide - Pro Mix Academy](https://promixacademy.com/blog/how-to-record-arm-a-track-in-reaper/)
- [Reaper Auto Record Arm - ReaperTips](https://www.reapertips.com/post/automatic-record-arm-when-track-selected)
- [Reaper Routing Critique - Admiral Bumblebee](https://www.admiralbumblebee.com/music/2017/04/18/Reapers-Amazing,-but-Awful,-Almost-Anything-to-Anywhere-Routing.html)
- [Ardour Patchbay Manual](https://manual.ardour.org/signal-routing/Patchbay/)
- [Ardour Signal Routing Manual](https://manual.ardour.org/signal-routing/)
- [OBS Audio Mixer Guide](https://obsproject.com/kb/audio-mixer-guide)
- [Logic Pro Capture Recording](http://logicprogem.com/Logic-Pro-X-Tutorials/Entries/2014/6/13_Capture_Recording__Logic_Pro_is_Always_Listening.html)
- [Pro Tools Metering Options](https://www.soundonsound.com/techniques/pro-tools-metering-options)
- [Pro Tools Record Modes](https://www.protoolsproduction.com/recordmodes/)
- [Cubase Pre-Record Buffer](https://forums.steinberg.net/t/would-like-tips-about-how-to-use-the-audio-pre-record-buffer/962385)
- [Multi-Source Multi-Track Recording - Ypertex](https://blog.ypertex.com/articles/multisource-multitrack-recording-in-your-daw/)
- [Ableton Recording New Clips Manual](https://www.ableton.com/en/manual/recording-new-clips/)
- [Hindenburg Journalist - Trinity College](https://edtech.domains.trincoll.edu/recording-and-editing-with-hindenburg-pro/)

### Design & UX
- [Progressive Disclosure - IxDF](https://www.interaction-design.org/literature/topics/progressive-disclosure)
- [Progressive Disclosure UX - LogRocket](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- [Progressive Disclosure - UXPin](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)
- [Logic Pro vs GarageBand - Pro Mix Academy](https://promixacademy.com/blog/logic-pro-vs-garageband/)
- [MiniMeters](https://minimeters.app/)
- [Matrix Mixer - Wikipedia](https://en.wikipedia.org/wiki/Matrix_mixer)
- [Audient iD48 Routing Matrix](https://support.audient.com/hc/en-us/articles/34617846096788-iD48-How-to-Use-the-Routing-Matrix)
- [PC System Design Guide Color Codes](https://en.wikipedia.org/wiki/PC_System_Design_Guide)

### Audio Engineering
- [SOS Guide to Data Protection for DAWs](https://www.soundonsound.com/techniques/sos-guide-data-protection-daws)
- [Circular Buffer for Audio Processing](https://atastypixel.com/a-simple-fast-circular-buffer-implementation-for-audio-processing/)
- [MediaDevices.enumerateDevices() - MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)
- [Audio Output Devices API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Audio_Output_Devices_API)

### Rust Audio Ecosystem
- [rubato (resampling)](https://docs.rs/rubato/latest/rubato/)
- [hound (WAV I/O)](https://docs.rs/hound/latest/hound/)
- [symphonia (codecs)](https://docs.rs/symphonia/latest/symphonia/)
- [memmap2](https://docs.rs/memmap2/latest/memmap2/)
