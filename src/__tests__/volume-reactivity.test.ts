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

/**
 * Regression tests for volume bar & envelope reactivity.
 *
 * With shallowRef, volume mutations must create new array/object references
 * so that computed() wrappers (e.g. useClipping.ts) detect changes.
 * Previously these used triggerRef() which doesn't propagate through computed().
 */
describe('Volume reactivity: new array identity on mutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setTrackVolume creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;
    const refBefore = tracksStore.tracks;
    const trackBefore = tracksStore.tracks[0];

    tracksStore.setTrackVolume(trackId, 0.5, true);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0]).not.toBe(trackBefore);
    expect(tracksStore.tracks[0].volume).toBe(0.5);
  });

  it('setTrackVolume scales envelope and creates new references', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    // Add envelope points first
    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    tracksStore.addVolumePoint(trackId, 2.0, 0.4);
    const refBefore = tracksStore.tracks;

    // Halve volume — envelope should scale proportionally
    tracksStore.setTrackVolume(trackId, 0.5, true);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volume).toBe(0.5);
    // Envelope points scaled by 0.5/1.0 = 0.5
    expect(tracksStore.tracks[0].volumeEnvelope![0].value).toBeCloseTo(0.4);
    expect(tracksStore.tracks[0].volumeEnvelope![1].value).toBeCloseTo(0.2);
  });

  it('addVolumePoint creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;
    const refBefore = tracksStore.tracks;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volumeEnvelope).toHaveLength(1);
    expect(tracksStore.tracks[0].volumeEnvelope![0].value).toBe(0.8);
  });

  it('updateVolumePoint creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    const pointId = tracksStore.tracks[0].volumeEnvelope![0].id;
    const refBefore = tracksStore.tracks;

    tracksStore.updateVolumePoint(trackId, pointId, 2.0, 0.6);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volumeEnvelope![0].time).toBe(2.0);
    expect(tracksStore.tracks[0].volumeEnvelope![0].value).toBe(0.6);
  });

  it('removeVolumePoint creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    tracksStore.addVolumePoint(trackId, 2.0, 0.5);
    const pointId = tracksStore.tracks[0].volumeEnvelope![0].id;
    const refBefore = tracksStore.tracks;

    tracksStore.removeVolumePoint(trackId, pointId);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volumeEnvelope).toHaveLength(1);
  });

  it('adjustVolumeEnvelopeForCut creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    tracksStore.addVolumePoint(trackId, 3.0, 0.5);
    const refBefore = tracksStore.tracks;

    // Cut from 0.5s to 1.5s — should remove point at 1.0, shift point at 3.0
    tracksStore.adjustVolumeEnvelopeForCut(trackId, 0.5, 1.5);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volumeEnvelope).toHaveLength(1);
  });

  it('adjustVolumeEnvelopeForDelete creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    tracksStore.addVolumePoint(trackId, 3.0, 0.5);
    const refBefore = tracksStore.tracks;

    tracksStore.adjustVolumeEnvelopeForDelete(trackId, 0.5, 1.5);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].volumeEnvelope).toHaveLength(1);
  });

  it('adjustVolumeEnvelopeForInsert creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.addVolumePoint(trackId, 1.0, 0.8);
    const refBefore = tracksStore.tracks;

    tracksStore.adjustVolumeEnvelopeForInsert(trackId, 0.5, 2.0);

    expect(tracksStore.tracks).not.toBe(refBefore);
    // Point at 1.0 should be shifted to 3.0
    expect(tracksStore.tracks[0].volumeEnvelope![0].time).toBe(3.0);
  });
});
