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
  copyFromChannel(dest: Float32Array, ch: number, start?: number) {
    dest.set(this.channels[ch].subarray(start ?? 0, (start ?? 0) + dest.length));
  }
  copyToChannel(src: Float32Array, ch: number, start?: number) {
    this.channels[ch].set(src, start ?? 0);
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

describe('History Batch Safety', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('deleteClipFromTrack creates exactly 1 undo entry', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useHistoryStore } = await import('@/stores/history');

    const tracksStore = useTracksStore();
    const historyStore = useHistoryStore();

    // Clear history so we start fresh
    historyStore.clear();

    const buffer = mkBuf(10);
    const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
    const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Set up two clips
    tracksStore.tracks[trackIdx] = {
      ...tracksStore.tracks[trackIdx],
      clips: [
        { id: 'clip-a', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
        { id: 'clip-b', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    // Clear after setup so only our operation counts
    historyStore.clear();
    expect(historyStore.canUndo).toBe(false);

    tracksStore.deleteClipFromTrack(track.id, 'clip-a');

    // Should now have exactly 1 undo entry
    expect(historyStore.canUndo).toBe(true);
    historyStore.undo();
    // After one undo, no more entries
    expect(historyStore.canUndo).toBe(false);
    expect(historyStore.canRedo).toBe(true);
  });

  it('rippleDeleteRegion without a batch wrapper creates exactly 1 undo entry', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useHistoryStore } = await import('@/stores/history');

    const tracksStore = useTracksStore();
    const historyStore = useHistoryStore();

    const buffer = mkBuf(10);
    tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);

    // Clear after setup
    historyStore.clear();
    expect(historyStore.canUndo).toBe(false);

    const ctx = new AudioContext();
    await tracksStore.rippleDeleteRegion(3, 5, ctx);

    expect(historyStore.canUndo).toBe(true);
    historyStore.undo();
    expect(historyStore.canUndo).toBe(false);
    expect(historyStore.canRedo).toBe(true);
  });

  it('undo after rippleDeleteRegion restores all affected tracks', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useHistoryStore } = await import('@/stores/history');

    const tracksStore = useTracksStore();
    const historyStore = useHistoryStore();

    const buf1 = mkBuf(10);
    const buf2 = mkBuf(8);
    tracksStore.createTrackFromBuffer(buf1, null, 'Track 1', 0);
    tracksStore.createTrackFromBuffer(buf2, null, 'Track 2', 2);

    const dursBefore = tracksStore.tracks.map(t => t.duration);

    historyStore.clear();

    const ctx = new AudioContext();
    await tracksStore.rippleDeleteRegion(3, 5, ctx);

    historyStore.undo();

    const dursAfter = tracksStore.tracks.map(t => t.duration);
    for (let i = 0; i < dursBefore.length; i++) {
      expect(dursAfter[i]).toBeCloseTo(dursBefore[i], 1);
    }
  });

  it('cloneClip preserves a newly-added field via spread (regression guard)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useHistoryStore } = await import('@/stores/history');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const historyStore = useHistoryStore();

    const buffer = mkBuf(10);
    const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
    const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Add a clip with a custom extra field to test that spread preserves it
    const clipWithExtra = {
      id: 'spread-test',
      buffer: null,
      waveformData: [],
      clipStart: 0,
      duration: 5,
      sourceFile: '/tmp/src.wav',
      sourceOffset: 0,
      _testField: 'preserved',
    } as TrackClip & { _testField: string };

    tracksStore.tracks[trackIdx] = {
      ...tracksStore.tracks[trackIdx],
      clips: [clipWithExtra as unknown as TrackClip],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    historyStore.clear();
    historyStore.pushState('Test');
    historyStore.undo();

    const restored = tracksStore.tracks.find(t => t.id === track.id);
    const restoredClip = restored?.clips?.[0] as unknown as Record<string, unknown> | undefined;
    expect(restoredClip?.['_testField']).toBe('preserved');
  });
});
