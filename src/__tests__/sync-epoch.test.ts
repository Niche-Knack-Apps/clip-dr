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

describe('Sync Epoch', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts at 0', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    expect(tracksStore.syncEpoch).toBe(0);
  });

  it('increments on createTrackFromBuffer', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const before = tracksStore.syncEpoch;
    await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    expect(tracksStore.syncEpoch).toBe(before + 1);
  });

  it('increments on deleteTrack', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    const before = tracksStore.syncEpoch;
    tracksStore.deleteTrack(track.id);
    expect(tracksStore.syncEpoch).toBe(before + 1);
  });

  it('increments on clearTracks', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    const before = tracksStore.syncEpoch;
    tracksStore.clearTracks();
    expect(tracksStore.syncEpoch).toBe(before + 1);
  });

  it('increments on cutRegionFromTrack (in-memory buffer)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    // Use a track with an in-memory buffer (small file path) — the standard cut path
    const buf = mkBuf(10);
    await tracksStore.createTrackFromBuffer(buf, null, 'T1', 0);

    const before = tracksStore.syncEpoch;
    const ctx = new AudioContext();
    const trackId = tracksStore.tracks[0].id;
    await tracksStore.cutRegionFromTrack(trackId, 3, 5, ctx, { mode: 'edit-only' });
    expect(tracksStore.syncEpoch).toBeGreaterThan(before);
  });

  it('increments on insertClipAtPlayhead', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    const clipBuf = mkBuf(2);
    const wf = new Array(100).fill(0.5);
    const ctx = new AudioContext();
    await tracksStore.insertClipAtPlayhead(track.id, clipBuf, wf, 2.5, ctx);
    expect(tracksStore.syncEpoch).toBeGreaterThan(before);
  });

  it('increments on setTrackClips', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    tracksStore.setTrackClips(track.id, [
      { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
    ]);
    expect(tracksStore.syncEpoch).toBeGreaterThan(before);
  });

  it('does NOT increment on mute/solo toggle', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    tracksStore.setTrackMuted(track.id, true);
    expect(tracksStore.syncEpoch).toBe(before);

    tracksStore.setTrackSolo(track.id, true);
    expect(tracksStore.syncEpoch).toBe(before);
  });

  it('does NOT increment on volume change', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    tracksStore.setTrackVolume(track.id, 0.5);
    expect(tracksStore.syncEpoch).toBe(before);
  });

  it('does NOT increment on renameTrack', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    tracksStore.renameTrack(track.id, 'New Name');
    expect(tracksStore.syncEpoch).toBe(before);
  });

  it('does NOT increment during drag moves (setClipStart)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Set up multi-clip track
    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      clips: [
        { id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
        { id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    const before = tracksStore.syncEpoch;

    // Simulate drag move — should NOT bump epoch
    tracksStore.setClipStart(track.id, 'c2', 6);
    expect(tracksStore.syncEpoch).toBe(before);

    // But finalizeClipPositions (commit) SHOULD bump
    tracksStore.finalizeClipPositions(track.id);
    expect(tracksStore.syncEpoch).toBeGreaterThan(before);
  });

  it('increments on finalizeImportWaveform', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const before = tracksStore.syncEpoch;

    const wf = new Array(200).fill(0.5);
    tracksStore.finalizeImportWaveform(track.id, wf, 10);
    expect(tracksStore.syncEpoch).toBeGreaterThan(before);
  });
});
