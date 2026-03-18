import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mock Tauri internals
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  once: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn().mockResolvedValue('/tmp/test'),
  tempDir: vi.fn().mockResolvedValue('/tmp/'),
}));

vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

class MockAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private channels: Float32Array[];
  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = [];
    for (let i = 0; i < options.numberOfChannels; i++) {
      this.channels.push(new Float32Array(options.length));
    }
  }
  getChannelData(ch: number): Float32Array { return this.channels[ch]; }
  copyFromChannel(dest: Float32Array, ch: number, start?: number): void {
    const src = this.channels[ch];
    const offset = start ?? 0;
    dest.set(src.subarray(offset, offset + dest.length));
  }
  copyToChannel(src: Float32Array, ch: number, start?: number): void {
    const offset = start ?? 0;
    this.channels[ch].set(src, offset);
  }
}

class MockAudioContext {
  readonly sampleRate = 44100;
  createBuffer(ch: number, len: number, rate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }) as unknown as AudioBuffer;
  }
  createBufferSource() { return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null, onended: null }; }
  createGain() { return { connect: vi.fn(), gain: { value: 1 } }; }
  get destination() { return {}; }
  get currentTime() { return 0; }
}

(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

function mkBuf(dur: number, rate = 44100, ch = 2): AudioBuffer {
  const ctx = new MockAudioContext();
  return ctx.createBuffer(ch, Math.max(1, Math.floor(dur * rate)), rate);
}

describe('Clean Audio Playback', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('createTrackFromBuffer with sourcePath sets sourcePath on track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(
      buffer, null, 'Cleaned Track', 0, '/tmp/cleaned_output.wav'
    );

    const stored = tracksStore.tracks.find(t => t.id === track.id)!;
    expect(stored.sourcePath).toBe('/tmp/cleaned_output.wav');
  });

  it('track with sourcePath is playable', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { isTrackPlayable } = await import('@/shared/utils');
    const tracksStore = useTracksStore();

    const buffer = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(
      buffer, null, 'Cleaned Track', 0, '/tmp/cleaned_output.wav'
    );

    const stored = tracksStore.tracks.find(t => t.id === track.id)!;
    expect(isTrackPlayable(stored.importStatus)).toBe(true);
  });

  it('muteAllExcept mutes all tracks except the specified one', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);
    const track3 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 3', 0);

    tracksStore.muteAllExcept(track2.id);

    const t1 = tracksStore.tracks.find(t => t.id === track1.id)!;
    const t2 = tracksStore.tracks.find(t => t.id === track2.id)!;
    const t3 = tracksStore.tracks.find(t => t.id === track3.id)!;

    expect(t1.muted).toBe(true);
    expect(t2.muted).toBe(false);
    expect(t3.muted).toBe(true);
  });

  it('selectedTrack auto-resolves to single track when selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Only Track', 0);

    // Default selection is 'ALL'
    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).not.toBeNull();
    expect(tracksStore.selectedTrack!.id).toBe(track.id);
  });

  it('selectedTrack returns null when multiple tracks and selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).toBeNull();
  });

  it('selectedTrack returns null when no tracks and selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).toBeNull();
  });

  it('canClean is true when a clip is selected even without selectedTrack', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    // With multiple tracks and 'ALL' selection, selectedTrack is null
    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).toBeNull();
    expect(cleaningStore.canClean).toBe(false);

    // But selecting a clip should enable cleaning
    const clips = tracksStore.getTrackClips(track1.id);
    if (clips.length > 0) {
      tracksStore.selectClip(track1.id, clips[0].id);
      expect(cleaningStore.canClean).toBe(true);
    }
  });

  it('VAD detectSilence requires selectedTrack (no tracks[0] fallback)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useVadStore } = await import('@/stores/vad');
    const tracksStore = useTracksStore();
    const vadStore = useVadStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    // With multiple tracks and 'ALL' selection, selectedTrack is null
    tracksStore.selectedTrackId = 'ALL';
    await vadStore.detectSilence();
    expect(vadStore.error).toBe('Select a track to detect silence');
  });

  it('silence cutSilenceToNewTrack requires selectedTrack (no tracks[0] fallback)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useSilenceStore } = await import('@/stores/silence');
    const tracksStore = useTracksStore();
    const silenceStore = useSilenceStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    // Add a fake silence region so hasRegions is true
    silenceStore.addRegion(1.0, 2.0);

    tracksStore.selectedTrackId = 'ALL';
    const result = await silenceStore.cutSilenceToNewTrack();
    expect(result).toBeNull();
    expect(silenceStore.cutError).toBe('Select a track to cut silence');
  });

  it('muteAllExcept unmutes the target track if it was muted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    // Pre-mute the target
    tracksStore.setTrackMuted(track2.id, true);
    expect(tracksStore.tracks.find(t => t.id === track2.id)!.muted).toBe(true);

    tracksStore.muteAllExcept(track2.id);

    // Target should now be unmuted
    expect(tracksStore.tracks.find(t => t.id === track2.id)!.muted).toBe(false);
    // Other should be muted
    expect(tracksStore.tracks.find(t => t.id === track1.id)!.muted).toBe(true);
  });
});

describe('Cleaned Track Timeline Alignment', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('cleaned track inherits trackStart from source track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    // Create a track starting at 5s on the timeline
    const buf = mkBuf(3);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Source', 5.0);
    const stored = tracksStore.tracks.find(t => t.id === track.id)!;
    expect(stored.trackStart).toBe(5.0);

    // Simulate what cleaning does: createTrackFromBuffer with sourceTrack.trackStart
    const cleanedBuf = mkBuf(3);
    const cleanedTrack = await tracksStore.createTrackFromBuffer(
      cleanedBuf, null, 'Cleaned Source', stored.trackStart, '/tmp/cleaned.wav'
    );

    const cleanedStored = tracksStore.tracks.find(t => t.id === cleanedTrack.id)!;
    expect(cleanedStored.trackStart).toBe(5.0);
  });
});

describe('EDL Clip Track Cleaning Regression', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('mixClipsForTrack returns null for track with EDL clips (null buffers)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useAudioStore } = await import('@/stores/audio');
    const tracksStore = useTracksStore();

    // Simulate a clip track created by extraction: has audioData.buffer
    // but clips[] array with null buffers (EDL references)
    const buf = mkBuf(10);
    const track: import('@/shared/types').Track = {
      id: 'edl-track-1',
      name: 'Clip 2',
      audioData: {
        buffer: buf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 5.0,
      duration: 10.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      sourcePath: '/home/user/original.wav',
      clips: [
        {
          id: 'edl-clip-1',
          buffer: null,
          waveformData: new Array(200).fill(0),
          clipStart: 5.0,
          duration: 10.0,
          sourceFile: '/home/user/original.wav',
          sourceOffset: 50.0,
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);

    // mixClipsForTrack should return null because clips have null buffers
    const ctx = new MockAudioContext() as unknown as AudioContext;
    const mixed = tracksStore.mixClipsForTrack('edl-track-1', ctx);
    expect(mixed).toBeNull();
  });

  it('getTrackClips returns EDL clips array when present (not synthetic clip)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(10);
    const track: import('@/shared/types').Track = {
      id: 'edl-track-2',
      name: 'Clip With EDL',
      audioData: {
        buffer: buf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 3.0,
      duration: 10.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: 'clip-a',
          buffer: null,
          waveformData: [],
          clipStart: 3.0,
          duration: 5.0,
          sourceFile: '/tmp/source.wav',
          sourceOffset: 10.0,
        },
        {
          id: 'clip-b',
          buffer: null,
          waveformData: [],
          clipStart: 8.0,
          duration: 5.0,
          sourceFile: '/tmp/source.wav',
          sourceOffset: 20.0,
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);

    // getTrackClips should return the EDL clips, not a synthetic single clip
    const clips = tracksStore.getTrackClips('edl-track-2');
    expect(clips.length).toBe(2);
    expect(clips[0].id).toBe('clip-a');
    expect(clips[1].id).toBe('clip-b');
    expect(clips[0].buffer).toBeNull();
  });

  it('cleanSelectedTrack falls back to audioData.buffer when mixClipsForTrack returns null', async () => {
    // This is THE regression test for the silent failure bug:
    // A clip track (created by extraction) has audioData.buffer but clips[] with null buffers.
    // mixClipsForTrack returns null, but cleaning should fall back to audioData.buffer
    // rather than silently returning null.
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(5);
    const track: import('@/shared/types').Track = {
      id: 'edl-fallback-track',
      name: 'Clip 2',
      audioData: {
        buffer: buf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 5.0,
      duration: 5.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      sourcePath: '/home/user/original.wav',
      clips: [
        {
          id: 'edl-clip-fb',
          buffer: null,
          waveformData: [],
          clipStart: 5.0,
          duration: 5.0,
          sourceFile: '/home/user/original.wav',
          sourceOffset: 50.0,
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);
    tracksStore.selectTrack('edl-fallback-track');

    // Verify preconditions: mixClipsForTrack returns null for this track
    const ctx = new MockAudioContext() as unknown as AudioContext;
    expect(tracksStore.mixClipsForTrack('edl-fallback-track', ctx)).toBeNull();
    // But track has audioData.buffer
    expect(tracksStore.getTrackById('edl-fallback-track')!.audioData.buffer).not.toBeNull();

    // cleanSelectedTrack will call invoke() which we mock — it will reject since
    // the mock isn't set up for clean_audio. The key test is that it REACHES the
    // invoke (i.e. doesn't silently return null due to mixClipsForTrack returning null).
    // We detect this by checking that loading becomes true and the error is from the
    // invoke call, not "no audio clips available".
    const result = await cleaningStore.cleanSelectedTrack();
    // The invoke mock resolves to [], which isn't a valid CleanResult.
    // The important thing is the error is NOT "no audio data available"
    expect(cleaningStore.error).not.toBe('Cannot clean: no audio data available');
  });

  it('cleanSelectedTrack shows error when track truly has no audio', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    // Track with no buffer and no clips — truly empty
    const track: import('@/shared/types').Track = {
      id: 'empty-track',
      name: 'Empty Track',
      audioData: {
        buffer: null,
        waveformData: [],
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 0,
      duration: 5.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      sourcePath: undefined,
      importStatus: 'ready',
    };

    tracksStore.insertTrackAtIndex(track, 0);
    tracksStore.selectTrack('empty-track');

    const result = await cleaningStore.cleanSelectedTrack();
    expect(result).toBeNull();
    expect(cleaningStore.error).toBe('Cannot clean: no audio data available');
  });
});

describe('Single Track VAD/Silence Auto-Resolve', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('VAD detectSilence works with single track and ALL selection (auto-resolve)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useVadStore } = await import('@/stores/vad');
    const tracksStore = useTracksStore();
    const vadStore = useVadStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Only Track', 0);

    // 'ALL' selection with single track → selectedTrack auto-resolves
    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).not.toBeNull();

    // detectSilence should NOT return the "Select a track" error
    await vadStore.detectSilence();
    // It will fail at mixClipsForTrack or invoke, but NOT with the track selection error
    expect(vadStore.error).not.toBe('Select a track to detect silence');
  });

  it('silence cutSilenceToNewTrack works with single track and ALL selection', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useSilenceStore } = await import('@/stores/silence');
    const tracksStore = useTracksStore();
    const silenceStore = useSilenceStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Only Track', 0);

    // Add silence region
    silenceStore.addRegion(1.0, 2.0);

    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).not.toBeNull();

    // Should NOT get "Select a track" error
    await silenceStore.cutSilenceToNewTrack();
    expect(silenceStore.cutError).not.toBe('Select a track to cut silence');
  });
});

describe('Clip-Level Cleaning', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('canClean is false with multiple tracks, ALL selection, and no clip selected', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    tracksStore.selectedTrackId = 'ALL';
    tracksStore.clearClipSelection();

    expect(cleaningStore.canClean).toBe(false);
  });

  it('canClean becomes true when clip is selected with multiple tracks', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    tracksStore.selectedTrackId = 'ALL';
    expect(cleaningStore.canClean).toBe(false);

    // Select a clip in track 1
    const clips = tracksStore.getTrackClips(track1.id);
    expect(clips.length).toBeGreaterThan(0);
    tracksStore.selectClip(track1.id, clips[0].id);

    expect(cleaningStore.canClean).toBe(true);
  });

  it('cleanSelectedTrack returns error when no track and no clip selected', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    tracksStore.selectedTrackId = 'ALL';
    tracksStore.clearClipSelection();

    const result = await cleaningStore.cleanSelectedTrack();
    expect(result).toBeNull();
    expect(cleaningStore.error).toBe('No track selected');
  });

  it('cleanSelectedTrack with clip selected uses clip sourceFile for Rust call', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const { invoke } = await import('@tauri-apps/api/core');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(10);
    const track: import('@/shared/types').Track = {
      id: 'clip-clean-track',
      name: 'Source Track',
      audioData: {
        buffer: buf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 0,
      duration: 10.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      sourcePath: '/home/user/original.wav',
      clips: [
        {
          id: 'target-clip',
          buffer: null,
          waveformData: [],
          clipStart: 5.0,
          duration: 3.0,
          sourceFile: '/tmp/source.wav',
          sourceOffset: 20.0,
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);
    tracksStore.selectClip('clip-clean-track', 'target-clip');

    // Mock invoke to capture the clean_audio call args
    const mockInvoke = vi.mocked(invoke);
    let cleanAudioArgs: Record<string, unknown> | null = null;
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'clean_audio') {
        cleanAudioArgs = (args as Record<string, unknown>) ?? null;
        // Return a fake CleanResult
        return { outputPath: '/tmp/cleaned_test.wav', duration: 3.0 };
      }
      if (cmd === 'get_temp_audio_path') {
        return '/tmp/cleaned_test.wav';
      }
      return [];
    });

    await cleaningStore.cleanSelectedTrack();

    // Verify clean_audio was called with clip's sourceFile and sourceOffset
    expect(cleanAudioArgs).not.toBeNull();
    expect(cleanAudioArgs!.sourcePath).toBe('/tmp/source.wav');
    expect(cleanAudioArgs!.startTime).toBe(20.0);
    expect(cleanAudioArgs!.endTime).toBe(23.0); // sourceOffset + duration
  });

  it('cleanSelectedTrack with buffer-backed clip encodes to temp WAV', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const clipBuf = mkBuf(3);
    const trackBuf = mkBuf(10);
    const track: import('@/shared/types').Track = {
      id: 'buf-clip-track',
      name: 'Source Track',
      audioData: {
        buffer: trackBuf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 0,
      duration: 10.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: 'buf-clip',
          buffer: clipBuf,
          waveformData: [],
          clipStart: 2.0,
          duration: 3.0,
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);
    tracksStore.selectClip('buf-clip-track', 'buf-clip');

    // The clean will fail at the invoke stage, but it should attempt to encode the buffer
    // (not the whole track). We can verify this through the error not being
    // about track selection or no audio data.
    const result = await cleaningStore.cleanSelectedTrack();
    expect(cleaningStore.error).not.toBe('No track selected');
    expect(cleaningStore.error).not.toBe('Cannot clean: clip has no audio data');
  });

  it('cleanSelectedTrack errors when clip has no buffer and no sourceFile', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useCleaningStore } = await import('@/stores/cleaning');
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();

    const buf = mkBuf(10);
    const track: import('@/shared/types').Track = {
      id: 'no-data-clip-track',
      name: 'Source Track',
      audioData: {
        buffer: buf,
        waveformData: new Array(200).fill(0),
        sampleRate: 44100,
        channels: 2,
      },
      trackStart: 0,
      duration: 10.0,
      color: '#00d4ff',
      muted: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: 'empty-clip',
          buffer: null,
          waveformData: [],
          clipStart: 2.0,
          duration: 3.0,
          // No sourceFile, no buffer
        },
      ],
    };

    tracksStore.insertTrackAtIndex(track, 0);
    tracksStore.selectClip('no-data-clip-track', 'empty-clip');

    const result = await cleaningStore.cleanSelectedTrack();
    expect(result).toBeNull();
    expect(cleaningStore.error).toBe('Cannot clean: clip has no audio data');
  });
});
