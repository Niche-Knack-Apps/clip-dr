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

describe('promoteToExplicitClips', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('promotes a single-buffer track to explicit clips', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(5), null, 'Test', 0);
    expect(track.clips).toBeUndefined();

    const clipId = store.promoteToExplicitClips(track.id);
    expect(clipId).not.toBeNull();

    const updated = store.tracks.find(t => t.id === track.id)!;
    expect(updated.clips).toHaveLength(1);
    expect(updated.clips![0].id).toBe(clipId);
    expect(updated.clips![0].clipStart).toBe(0);
    expect(updated.clips![0].duration).toBeCloseTo(5, 0);
    expect(updated.clips![0].sourceIn).toBe(0);
    expect(updated.clips![0].sourceDuration).toBeCloseTo(5, 0);
    expect(updated.clips![0].sourceOffset).toBe(0);
  });

  it('returns existing clip ID if already promoted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(3), null, 'Test', 0);

    const firstId = store.promoteToExplicitClips(track.id);
    const secondId = store.promoteToExplicitClips(track.id);
    expect(secondId).toBe(firstId);

    // Still only one clip
    const updated = store.tracks.find(t => t.id === track.id)!;
    expect(updated.clips).toHaveLength(1);
  });

  it('returns null for nonexistent track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    expect(store.promoteToExplicitClips('nonexistent')).toBeNull();
  });

  it('promoted clip preserves track position', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(4), null, 'Offset', 0);
    // Manually set trackStart to simulate a non-zero position
    const idx = store.tracks.findIndex(t => t.id === track.id);
    store.tracks[idx] = { ...store.tracks[idx], trackStart: 2.5 };
    store.tracks = [...store.tracks];

    store.promoteToExplicitClips(track.id);

    const updated = store.tracks.find(t => t.id === track.id)!;
    expect(updated.clips![0].clipStart).toBe(2.5);
  });
});

describe('Edge trim after promoteToExplicitClips', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('trimClipLeft works on a freshly promoted single-buffer track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(10), null, 'TrimMe', 0);
    const clipId = store.promoteToExplicitClips(track.id)!;

    // Trim 2s from left
    store.trimClipLeft(track.id, clipId, 2);

    const clip = store.tracks.find(t => t.id === track.id)!.clips![0];
    expect(clip.sourceOffset).toBe(2);
    expect(clip.clipStart).toBe(2);
    expect(clip.duration).toBeCloseTo(8, 0);
  });

  it('trimClipRight works on a freshly promoted single-buffer track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(10), null, 'TrimMe', 0);
    const clipId = store.promoteToExplicitClips(track.id)!;

    // Trim 3s from right (negative delta = shrink)
    store.trimClipRight(track.id, clipId, -3);

    const clip = store.tracks.find(t => t.id === track.id)!.clips![0];
    expect(clip.sourceOffset).toBe(0);
    expect(clip.clipStart).toBe(0);
    expect(clip.duration).toBeCloseTo(7, 0);
  });

  it('trimClipLeft on promoted clip can recover hidden audio', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(10), null, 'Recover', 0);
    const clipId = store.promoteToExplicitClips(track.id)!;

    // Trim 4s from left, then recover 2s
    store.trimClipLeft(track.id, clipId, 4);
    store.trimClipLeft(track.id, clipId, -2);

    const clip = store.tracks.find(t => t.id === track.id)!.clips![0];
    expect(clip.sourceOffset).toBe(2); // 0+4-2
    expect(clip.clipStart).toBe(2);    // 0+4-2
    expect(clip.duration).toBeCloseTo(8, 0); // 10-4+2
  });

  it('finalizeEdgeTrim updates track bounds after trim on promoted clip', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const track = await store.createTrackFromBuffer(mkBuf(10), null, 'Finalize', 0);
    const clipId = store.promoteToExplicitClips(track.id)!;

    store.trimClipLeft(track.id, clipId, 3);
    store.finalizeEdgeTrim(track.id);

    const updated = store.tracks.find(t => t.id === track.id)!;
    expect(updated.trackStart).toBe(3);
    expect(updated.duration).toBeCloseTo(7, 0);
  });
});

describe('Recording placement — zero mode contract', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('default placement is zero', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();
    expect(store.placement).toBe('zero');
  });

  it('setPlacement cycles correctly between all modes', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.setPlacement('append');
    expect(store.placement).toBe('append');
    store.setPlacement('playhead');
    expect(store.placement).toBe('playhead');
    store.setPlacement('zero');
    expect(store.placement).toBe('zero');
  });
});
