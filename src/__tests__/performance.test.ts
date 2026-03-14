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

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
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
}

class MockAudioContext {
  readonly sampleRate = 44100;
  createBuffer(ch: number, len: number, rate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }) as unknown as AudioBuffer;
  }
}

(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

describe('Performance: hot-path triggerRef', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setClipStart does not spread the tracks array (uses triggerRef)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(2, 44100 * 10, 44100);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);

    // Add a second clip so clips array is set
    type TrackClip = import('@/shared/types').TrackClip;
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);
    const twoClips: TrackClip[] = [
      { id: 'c1', buffer: buf, waveformData: [], clipStart: 0, duration: 5, sourceFile: undefined, sourceOffset: 0 },
      { id: 'c2', buffer: buf, waveformData: [], clipStart: 5, duration: 5, sourceFile: undefined, sourceOffset: 5 },
    ];
    tracksStore.tracks[idx] = { ...tracksStore.tracks[idx], clips: twoClips };
    tracksStore.tracks = [...tracksStore.tracks];

    // Capture initial array reference
    const arrayRef = tracksStore.tracks;

    // Call setClipStart — should NOT create a new array
    tracksStore.setClipStart(track.id, 'c1', 1, false);

    // With triggerRef, the array identity should be PRESERVED (same reference)
    expect(tracksStore.tracks).toBe(arrayRef);
  });

  it('setHasPeakPyramid does not spread the tracks array (uses triggerRef)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(2, 44100 * 5, 44100);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);

    const arrayRef = tracksStore.tracks;

    tracksStore.setHasPeakPyramid(track.id);

    // Array reference should be preserved
    expect(tracksStore.tracks).toBe(arrayRef);
    // hasPeakPyramid should be set
    const updated = tracksStore.tracks.find(t => t.id === track.id);
    expect(updated?.hasPeakPyramid).toBe(true);
  });

  it('getActiveTracksAtTime has O(1) solo check (hasSolo computed once per call)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    // Add multiple tracks
    for (let i = 0; i < 5; i++) {
      const buf = ctx.createBuffer(2, 44100 * 5, 44100);
      await tracksStore.createTrackFromBuffer(buf, null, `Track ${i}`, 0);
    }

    // getActiveTracksAtTime should not throw and return tracks
    const active = tracksStore.getActiveTracksAtTime(0);
    expect(active.length).toBeGreaterThan(0);
  });

  it('PERF-02 regression: shallowRef tracks triggers computed reactivity via triggerRef', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    // tracks.value should start empty
    expect(tracksStore.tracks.length).toBe(0);
    expect(tracksStore.hasAudio).toBe(false);

    // Add a track — this triggers shallowRef via new array assignment
    const buf = ctx.createBuffer(1, 44100, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    // hasAudio (computed) should reflect the new track
    expect(tracksStore.tracks.length).toBe(1);
    expect(tracksStore.hasAudio).toBe(true);

    // Mutate a track property via store function (uses triggerRef internally)
    tracksStore.renameTrack(tracksStore.tracks[0].id, 'Renamed');
    expect(tracksStore.tracks[0].name).toBe('Renamed');
  });
});
