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

describe('Per-Track Silence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('silence detection stores results under specific trackId', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const trackId = tracksStore.tracks[0].id;

    silenceStore.addRegion(trackId, 1, 3);
    silenceStore.addRegion(trackId, 5, 7);

    expect(silenceStore.getRegionsForTrack(trackId).length).toBe(2);
    expect(silenceStore.hasRegionsForTrack(trackId)).toBe(true);
  });

  it('multiple tracks have independent silence regions', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    silenceStore.addRegion(t1.id, 1, 2);
    silenceStore.addRegion(t2.id, 5, 8);
    silenceStore.addRegion(t2.id, 9, 10);

    expect(silenceStore.getRegionsForTrack(t1.id).length).toBe(1);
    expect(silenceStore.getRegionsForTrack(t2.id).length).toBe(2);
  });

  it('no accidental modification of unselected tracks', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    silenceStore.addRegion(t1.id, 1, 2);
    silenceStore.addRegion(t2.id, 5, 6);

    // Delete region from t1 only
    const t1Region = silenceStore.getRegionsForTrack(t1.id)[0];
    silenceStore.deleteRegion(t1.id, t1Region.id);

    // t1 region should be disabled
    expect(silenceStore.getRegionsForTrack(t1.id)[0].enabled).toBe(false);
    // t2 region should be untouched
    expect(silenceStore.getRegionsForTrack(t2.id)[0].enabled).toBe(true);
  });

  it('isInSilence checks correct track', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    silenceStore.addRegion(t1.id, 1, 3);
    silenceStore.toggleCompression(true);

    // Time 2 is in silence for t1 but not for t2
    expect(silenceStore.isInSilence(t1.id, 2)).not.toBeNull();
    expect(silenceStore.isInSilence(t2.id, 2)).toBeNull();
  });

  it('clear removes all per-track regions', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 1, 2);
    expect(silenceStore.hasRegions).toBe(true);

    silenceStore.clear();
    expect(silenceStore.hasRegions).toBe(false);
    expect(silenceStore.getRegionsForTrack(t1.id).length).toBe(0);
  });

  it('cutSilenceToNewTrack rejects _unassigned trackId', async () => {
    const { useSilenceStore, UNASSIGNED_TRACK_KEY } = await import('@/stores/silence');
    const silenceStore = useSilenceStore();

    const result = await silenceStore.cutSilenceToNewTrack(UNASSIGNED_TRACK_KEY);
    expect(result).toBeNull();
    expect(silenceStore.cutError).toContain('reassignment');
  });

  it('getRegionsInRange scoped to track', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    silenceStore.addRegion(t1.id, 1, 3);
    silenceStore.addRegion(t2.id, 2, 4);

    const t1Visible = silenceStore.getRegionsInRange(t1.id, 0, 5);
    const t2Visible = silenceStore.getRegionsInRange(t2.id, 0, 5);

    expect(t1Visible.length).toBe(1);
    expect(t2Visible.length).toBe(1);
    expect(t1Visible[0].start).toBe(1); // t1's region
    expect(t2Visible[0].start).toBe(2); // t2's region
  });
});

describe('Silence Region Clip Movement (v0.27.21 regression)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shiftRegionsForTrack moves all regions by delta', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 2, 4);
    silenceStore.addRegion(t1.id, 6, 8);

    silenceStore.shiftRegionsForTrack(t1.id, 5);

    const regions = silenceStore.getRegionsForTrack(t1.id);
    expect(regions[0].start).toBe(7);
    expect(regions[0].end).toBe(9);
    expect(regions[1].start).toBe(11);
    expect(regions[1].end).toBe(13);
  });

  it('shiftRegionsForTrack drops regions shifted before 0', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 1, 2);
    silenceStore.addRegion(t1.id, 5, 7);

    silenceStore.shiftRegionsForTrack(t1.id, -3);

    const regions = silenceStore.getRegionsForTrack(t1.id);
    expect(regions.length).toBe(1);
    expect(regions[0].start).toBe(2);
    expect(regions[0].end).toBe(4);
  });

  it('adjustSilenceForCut removes, truncates, and shifts', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 1, 3);   // before cut → unchanged
    silenceStore.addRegion(t1.id, 4, 6);   // fully inside cut → removed
    silenceStore.addRegion(t1.id, 8, 12);  // after cut → shifted left by 4

    silenceStore.adjustSilenceForCut(t1.id, 3, 7);

    const regions = silenceStore.getRegionsForTrack(t1.id);
    expect(regions.length).toBe(2);
    expect(regions[0].start).toBe(1);
    expect(regions[0].end).toBe(3);
    expect(regions[1].start).toBe(4);  // 8 - 4
    expect(regions[1].end).toBe(8);    // 12 - 4
  });

  it('adjustSilenceForDelete removes and truncates without shifting', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 2, 5);   // overlaps delete start → truncate end
    silenceStore.addRegion(t1.id, 4, 6);   // fully inside → removed
    silenceStore.addRegion(t1.id, 8, 10);  // after delete → unchanged

    silenceStore.adjustSilenceForDelete(t1.id, 4, 7);

    const regions = silenceStore.getRegionsForTrack(t1.id);
    expect(regions.length).toBe(2);
    expect(regions[0].start).toBe(2);
    expect(regions[0].end).toBe(4);   // truncated
    expect(regions[1].start).toBe(8);  // NOT shifted
    expect(regions[1].end).toBe(10);
  });

  it('transferRegionsToTrack moves overlapping regions', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T2', 0);

    silenceStore.addRegion(t1.id, 2, 4);   // inside clip range → transfers
    silenceStore.addRegion(t1.id, 8, 10);  // outside clip range → stays

    silenceStore.transferRegionsToTrack(t1.id, t2.id, 1, 6, 10);

    const t1Regions = silenceStore.getRegionsForTrack(t1.id);
    const t2Regions = silenceStore.getRegionsForTrack(t2.id);

    expect(t1Regions.length).toBe(1);
    expect(t1Regions[0].start).toBe(8);
    expect(t2Regions.length).toBe(1);
    expect(t2Regions[0].start).toBe(12);  // 2 + 10
    expect(t2Regions[0].end).toBe(14);    // 4 + 10
  });
});

describe('Silence Project Load Remapping (v0.27.19 regression)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setPerTrackSilenceRegions restores regions by trackId', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const silenceStore = useSilenceStore();

    const perTrack: Record<string, { id: string; start: number; end: number; enabled: boolean }[]> = {
      'track-abc': [
        { id: 's1', start: 1, end: 3, enabled: true },
        { id: 's2', start: 5, end: 7, enabled: true },
      ],
      'track-def': [
        { id: 's3', start: 2, end: 4, enabled: false },
      ],
    };

    silenceStore.setPerTrackSilenceRegions(perTrack);

    expect(silenceStore.getRegionsForTrack('track-abc').length).toBe(2);
    expect(silenceStore.getRegionsForTrack('track-def').length).toBe(1);
    expect(silenceStore.getRegionsForTrack('track-def')[0].enabled).toBe(false);
    expect(silenceStore.getRegionsForTrack('track-xyz').length).toBe(0);
  });

  it('remapped IDs work correctly (simulating project load)', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const silenceStore = useSilenceStore();

    const savedSilence: Record<string, { id: string; start: number; end: number; enabled: boolean }[]> = {
      'old-id-1': [{ id: 's1', start: 1, end: 3, enabled: true }],
      'old-id-2': [{ id: 's2', start: 5, end: 7, enabled: true }],
    };

    const idMap = new Map([['old-id-1', 'new-id-1'], ['old-id-2', 'new-id-2']]);
    const remapped: Record<string, typeof savedSilence[string]> = {};
    for (const [savedId, regions] of Object.entries(savedSilence)) {
      const newId = idMap.get(savedId);
      if (newId) remapped[newId] = regions;
    }

    silenceStore.setPerTrackSilenceRegions(remapped);

    expect(silenceStore.getRegionsForTrack('new-id-1').length).toBe(1);
    expect(silenceStore.getRegionsForTrack('new-id-2').length).toBe(1);
    expect(silenceStore.getRegionsForTrack('old-id-1').length).toBe(0);
  });
});
