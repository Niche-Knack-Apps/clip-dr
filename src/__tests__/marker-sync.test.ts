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

describe('Marker Sync — UI Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('hoveredTimemarkId defaults to null', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();
    expect(uiStore.hoveredTimemarkId).toBeNull();
  });

  it('setHoveredTimemark sets the id', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();
    uiStore.setHoveredTimemark('mark-123');
    expect(uiStore.hoveredTimemarkId).toBe('mark-123');
  });

  it('clearHoveredTimemark resets to null', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();
    uiStore.setHoveredTimemark('mark-123');
    uiStore.clearHoveredTimemark();
    expect(uiStore.hoveredTimemarkId).toBeNull();
  });
});

describe('Marker Sync — Tracks Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('addTimemark increases track timemarks count', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const track = tracksStore.tracks[0];
    const before = track.timemarks?.length ?? 0;

    tracksStore.addTimemark(track.id, 2.0, 'Test', 'manual');
    expect(track.timemarks!.length).toBe(before + 1);
  });

  it('removeTrackTimemark removes the timemark', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const track = tracksStore.tracks[0];

    tracksStore.addTimemark(track.id, 2.0, 'Test', 'manual');
    const markId = track.timemarks![0].id;

    tracksStore.removeTrackTimemark(track.id, markId);
    expect(track.timemarks!.find(m => m.id === markId)).toBeUndefined();
  });

  it('timemark appears only on correct track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);
    const t1 = tracksStore.tracks[0];
    const t2 = tracksStore.tracks[1];

    tracksStore.addTimemark(t1.id, 3.0, 'OnlyT1', 'manual');
    expect(t1.timemarks!.some(m => m.label === 'OnlyT1')).toBe(true);
    expect(t2.timemarks?.some(m => m.label === 'OnlyT1') ?? false).toBe(false);
  });
});
