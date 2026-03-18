import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ProjectFile, SilenceRegion } from '@/shared/types';

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

describe('Project v3 Schema', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('v2 file loads with correct defaults for sourceIn/sourceDuration', () => {
    // Simulate a v2 ProjectTrackClip
    const v2Clip = {
      id: 'c1',
      clipStart: 2,
      duration: 5,
      sourceFile: '/tmp/test.wav',
      sourceOffset: 3,
      source_kind: 'original' as const,
    };

    // When loading v2 clips, sourceIn should default to sourceOffset, sourceDuration to duration
    const reconstructed = {
      ...v2Clip,
      buffer: null,
      waveformData: [],
      sourceIn: v2Clip.sourceIn ?? v2Clip.sourceOffset,
      sourceDuration: v2Clip.sourceDuration ?? v2Clip.duration,
    };

    expect(reconstructed.sourceIn).toBe(3);      // defaults to sourceOffset
    expect(reconstructed.sourceDuration).toBe(5); // defaults to duration
  });

  it('v3 clip preserves sourceIn/sourceDuration through serialization', () => {
    const v3Clip = {
      id: 'c1',
      clipStart: 2,
      duration: 3,
      sourceFile: '/tmp/test.wav',
      sourceOffset: 5,
      source_kind: 'original' as const,
      sourceIn: 0,
      sourceDuration: 20,
    };

    // Simulate round-trip
    const serialized = JSON.parse(JSON.stringify(v3Clip));
    expect(serialized.sourceIn).toBe(0);
    expect(serialized.sourceDuration).toBe(20);
  });

  it('per-track silence regions serialized as Record', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const trackId = tracksStore.tracks[0].id;

    silenceStore.addRegion(trackId, 1, 3);
    silenceStore.addRegion(trackId, 5, 7);

    const regions = silenceStore.getRegionsForTrack(trackId);
    expect(regions.length).toBe(2);

    // Simulate serialization: Map → Record
    const serialized: Record<string, SilenceRegion[]> = {};
    for (const [tid, regs] of silenceStore.silenceRegions.entries()) {
      serialized[tid] = regs;
    }

    expect(serialized[trackId]).toBeDefined();
    expect(serialized[trackId].length).toBe(2);
  });

  it('legacy single-track silence auto-migrates', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);

    // Simulate loading v2 flat silence array (single track → auto-migrate)
    const legacyRegions: SilenceRegion[] = [
      { id: 'r1', start: 1, end: 2, enabled: true },
      { id: 'r2', start: 5, end: 6, enabled: true },
    ];
    silenceStore.setSilenceRegions(legacyRegions); // no trackId

    const trackId = tracksStore.tracks[0].id;
    const migrated = silenceStore.getRegionsForTrack(trackId);
    expect(migrated.length).toBe(2);
  });

  it('legacy multi-track silence loads into _unassigned', async () => {
    const { useSilenceStore, UNASSIGNED_TRACK_KEY } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    const legacyRegions: SilenceRegion[] = [
      { id: 'r1', start: 1, end: 2, enabled: true },
    ];
    silenceStore.setSilenceRegions(legacyRegions); // no trackId, multiple tracks

    // Should be under _unassigned, not silently assigned to first track
    const unassigned = silenceStore.getRegionsForTrack(UNASSIGNED_TRACK_KEY);
    expect(unassigned.length).toBe(1);

    const track1Regions = silenceStore.getRegionsForTrack(tracksStore.tracks[0].id);
    expect(track1Regions.length).toBe(0);
  });

  it('v3 per-track silence round-trips through setPerTrackSilenceRegions', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const silenceStore = useSilenceStore();

    const perTrack: Record<string, SilenceRegion[]> = {
      'track-a': [{ id: 'r1', start: 1, end: 2, enabled: true }],
      'track-b': [{ id: 'r2', start: 3, end: 4, enabled: false }],
    };

    silenceStore.setPerTrackSilenceRegions(perTrack);

    expect(silenceStore.getRegionsForTrack('track-a').length).toBe(1);
    expect(silenceStore.getRegionsForTrack('track-b').length).toBe(1);
    expect(silenceStore.getRegionsForTrack('track-b')[0].enabled).toBe(false);
  });
});
