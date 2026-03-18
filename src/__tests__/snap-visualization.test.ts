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

import type { TrackClip } from '@/shared/types';

describe('Snap Visualization (getSnapTarget)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  async function setupTwoTrackClips() {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const t1 = await store.createTrackFromBuffer(mkBuf(20), null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(mkBuf(20), null, 'Track 2', 0);

    const idx1 = store.tracks.findIndex(t => t.id === t1.id);
    const idx2 = store.tracks.findIndex(t => t.id === t2.id);

    const clips1: TrackClip[] = [
      { id: 'c1a', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
      { id: 'c1b', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 8, duration: 4, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
    ];
    const clips2: TrackClip[] = [
      { id: 'c2a', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 2, duration: 6, sourceFile: '/tmp/b.wav', sourceOffset: 0 },
    ];

    store.tracks[idx1] = { ...store.tracks[idx1], clips: clips1, trackStart: 0, duration: 12 };
    store.tracks[idx2] = { ...store.tracks[idx2], clips: clips2, trackStart: 2, duration: 6 };
    store.tracks = [...store.tracks];

    return { store, t1Id: t1.id, t2Id: t2.id };
  }

  it('finds edge on same track', async () => {
    const { store, t1Id } = await setupTwoTrackClips();

    // Dragging c1b (at 8, dur 4) to start near c1a's end (5)
    const result = store.getSnapTarget(t1Id, 'c1b', 4.95, 4, true);
    expect(result).not.toBeNull();
    expect(result!.time).toBe(5); // c1a ends at 5
  });

  it('finds edge on different track', async () => {
    const { store, t1Id, t2Id } = await setupTwoTrackClips();

    // Dragging c1b (at 8, dur 4) to start near c2a's end (2+6=8)
    const result = store.getSnapTarget(t1Id, 'c1b', 7.95, 4, true);
    expect(result).not.toBeNull();
    expect(result!.time).toBe(8); // c2a ends at 8
  });

  it('returns null when no edges within threshold', async () => {
    const { store, t1Id } = await setupTwoTrackClips();

    // Dragging c1b to position 15 — no clip edge nearby
    const result = store.getSnapTarget(t1Id, 'c1b', 15, 4, true);
    expect(result).toBeNull();
  });

  it('chooses nearest edge when multiple are within threshold', async () => {
    const { store, t1Id } = await setupTwoTrackClips();

    // Dragging c1b to position very close to c1a's end (5)
    // c2a starts at 2, ends at 8 — both are snap edges but c1a end at 5 is closer to desiredStart=5.02
    const result = store.getSnapTarget(t1Id, 'c1b', 5.02, 4, true);
    expect(result).not.toBeNull();
    expect(result!.time).toBe(5); // nearest edge is c1a's end
  });

  it('returns null when snap is disabled', async () => {
    const { store, t1Id } = await setupTwoTrackClips();

    const result = store.getSnapTarget(t1Id, 'c1b', 4.95, 4, false);
    expect(result).toBeNull();
  });

  it('cross-track snapping works in getSnappedClipPosition', async () => {
    const { store, t1Id, t2Id } = await setupTwoTrackClips();

    // c2a is at [2, 8]. If we drag c1b (dur 4) to start near 8 on track 1,
    // it should snap to c2a's end on track 2
    const clips = store.getTrackClips(t1Id);
    const c1b = clips.find(c => c.id === 'c1b')!;

    // Move c1b to start at 7.95 with snap enabled
    store.setClipStart(t1Id, 'c1b', 7.95, true);

    const updated = store.getTrackClips(t1Id).find(c => c.id === 'c1b')!;
    // Should snap to 8 (c2a's end on track 2)
    expect(updated.clipStart).toBe(8);
  });
});
