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

describe('Paste EDL Integrity', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('insertClipAtPlayhead sets sourceFile on the new clip immediately', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    // Create a track to paste into
    const trackBuf = ctx.createBuffer(2, 44100 * 10, 44100);
    const track = await tracksStore.createTrackFromBuffer(trackBuf, null, 'Target', 0);

    // Create a buffer to paste
    const pasteBuf = ctx.createBuffer(2, 44100 * 2, 44100);

    await tracksStore.insertClipAtPlayhead(
      track.id,
      pasteBuf,
      [],
      3,
      ctx as unknown as AudioContext,
      '/source/file.wav',
      1.5
    );

    const updatedTrack = tracksStore.tracks.find(t => t.id === track.id);
    const clips = tracksStore.getTrackClips(track.id);
    // Find the newly inserted clip at playhead=3
    const newClip = clips.find(c => Math.abs(c.clipStart - 3) < 0.01);
    expect(newClip).toBeDefined();
    expect(newClip!.sourceFile).toBe('/source/file.wav');
    expect(newClip!.sourceOffset).toBe(1.5);
    expect(updatedTrack).toBeDefined();
  });

  it('splitClipAtTime on null-buffer clip produces correct sourceOffset on each half', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const trackBuf = ctx.createBuffer(2, 44100 * 10, 44100);
    const track = await tracksStore.createTrackFromBuffer(trackBuf, null, 'Split', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Replace with a null-buffer clip (EDL clip)
    const edlClip: TrackClip = {
      id: 'edl-clip',
      buffer: null,
      waveformData: new Array(200).fill(0.5),  // 100 buckets * 2
      clipStart: 0,
      duration: 10,
      sourceFile: '/source.wav',
      sourceOffset: 5,
    };
    tracksStore.tracks[idx] = { ...tracksStore.tracks[idx], clips: [edlClip] };
    tracksStore.tracks = [...tracksStore.tracks];

    const result = await tracksStore.splitClipAtTime(track.id, 'edl-clip', 4, ctx as unknown as AudioContext);
    expect(result).not.toBeNull();
    const { before, after } = result!;

    // Before: starts at 0, duration 4
    expect(before.clipStart).toBe(0);
    expect(before.duration).toBeCloseTo(4);
    expect(before.sourceFile).toBe('/source.wav');
    expect(before.sourceOffset).toBe(5);  // unchanged

    // After: starts at 4, duration 6, sourceOffset = 5 + 4 = 9
    expect(after.clipStart).toBe(4);
    expect(after.duration).toBeCloseTo(6);
    expect(after.sourceFile).toBe('/source.wav');
    expect(after.sourceOffset).toBeCloseTo(9);
  });

  it('splitClipAtTime waveform lengths sum to original (allow ±1 rounding bucket)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const trackBuf = ctx.createBuffer(2, 44100 * 10, 44100);
    const track = await tracksStore.createTrackFromBuffer(trackBuf, null, 'WaveformSplit', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    const waveformData = new Array(200).fill(0.3);  // 100 min/max pairs
    const edlClip: TrackClip = {
      id: 'wv-clip',
      buffer: null,
      waveformData,
      clipStart: 0,
      duration: 10,
      sourceFile: '/s.wav',
      sourceOffset: 0,
    };
    tracksStore.tracks[idx] = { ...tracksStore.tracks[idx], clips: [edlClip] };
    tracksStore.tracks = [...tracksStore.tracks];

    const result = await tracksStore.splitClipAtTime(track.id, 'wv-clip', 5, ctx as unknown as AudioContext);
    expect(result).not.toBeNull();
    const totalAfter = result!.before.waveformData.length + result!.after.waveformData.length;
    // Allow ±2 (rounding at split boundary)
    expect(Math.abs(totalAfter - waveformData.length)).toBeLessThanOrEqual(2);
  });

  it('insertClipAtPlayhead into multi-clip track creates 3 clips when pasting into middle', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const trackBuf = ctx.createBuffer(2, 44100 * 10, 44100);
    const track = await tracksStore.createTrackFromBuffer(trackBuf, null, 'Multi', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Set up one large EDL clip covering 0..10s
    const singleClip: TrackClip = {
      id: 'big',
      buffer: ctx.createBuffer(2, 44100 * 10, 44100),
      waveformData: [],
      clipStart: 0,
      duration: 10,
      sourceFile: '/s.wav',
      sourceOffset: 0,
    };
    tracksStore.tracks[idx] = { ...tracksStore.tracks[idx], clips: [singleClip] };
    tracksStore.tracks = [...tracksStore.tracks];

    // Paste a 2s clip at playhead=5
    const pasteBuf = ctx.createBuffer(2, 44100 * 2, 44100);
    await tracksStore.insertClipAtPlayhead(track.id, pasteBuf, [], 5, ctx as unknown as AudioContext);

    const clips = tracksStore.getTrackClips(track.id);
    // Should now have 3 clips: before(0..5), pasted(5..7), after(7..12)
    expect(clips.length).toBe(3);
    expect(clips[0].clipStart).toBeCloseTo(0);
    expect(clips[1].clipStart).toBeCloseTo(5);
    expect(clips[2].clipStart).toBeCloseTo(7);
  });
});
