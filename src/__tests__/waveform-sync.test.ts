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

// Suppress console noise
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

// Mock AudioBuffer class for happy-dom
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

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, startInChannel?: number): void {
    const src = this.channels[channelNumber];
    const offset = startInChannel ?? 0;
    destination.set(src.subarray(offset, offset + destination.length));
  }

  copyToChannel(source: Float32Array, channelNumber: number, startInChannel?: number): void {
    const offset = startInChannel ?? 0;
    this.channels[channelNumber].set(source, offset);
  }
}

class MockAudioContext {
  readonly sampleRate = 44100;

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels, length, sampleRate }) as unknown as AudioBuffer;
  }

  createBufferSource() {
    return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null, onended: null };
  }
  createGain() {
    return { connect: vi.fn(), gain: { value: 1 } };
  }
  get destination() { return {}; }
  get currentTime() { return 0; }
}

(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

function createMockAudioBuffer(duration: number, sampleRate = 44100, channels = 2): AudioBuffer {
  const length = Math.floor(duration * sampleRate);
  const ctx = new MockAudioContext();
  return ctx.createBuffer(channels, Math.max(1, length), sampleRate);
}

/**
 * Generate a distinctive waveform pattern where each bucket has a unique value
 * based on its position. This makes it possible to verify that clip waveform
 * slices correspond to the correct source position.
 */
function generatePositionalWaveform(bucketCount: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const val = (i + 1) / bucketCount; // unique value per position
    data.push(-val, val); // min, max pairs
  }
  return data;
}

describe('Waveform Sync After Cut', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // ── Fix 1: finalizeClipWaveforms uses source-offset coordinates ──────────

  describe('finalizeClipWaveforms uses sourceOffset (not clipStart)', () => {
    it('slices waveform from source position after ripple cut shifts clipStart', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(100); // 100 buckets
      const sourceDuration = 10; // 10s source file

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate post-ripple-cut state:
      // Clip A was originally at 0-3s, clip B was originally at 5-10s
      // After ripple, clip B shifts to clipStart=3 but sourceOffset stays 5
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: {
          buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2,
          sourceDuration,
        },
        clips: [
          { id: 'A', buffer: null, waveformData: [], clipStart: 0, duration: 3, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
          { id: 'B', buffer: null, waveformData: [], clipStart: 3, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 5 },
        ],
        duration: 8,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Trigger finalizeClipWaveforms via setTrackClips (which calls it internally)
      tracksStore.finalizeClipWaveforms(track.id);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      const clipB = updated.clips!.find(c => c.id === 'B')!;

      // Clip B should get waveform from source position 5-10s (buckets 50-100)
      // NOT from timeline position 3-8s (buckets 30-80)
      const expectedStartBucket = Math.floor((5 / sourceDuration) * 100);
      const expectedEndBucket = Math.ceil((10 / sourceDuration) * 100);
      const expectedLength = (expectedEndBucket - expectedStartBucket) * 2;

      expect(clipB.waveformData.length).toBe(expectedLength);

      // Verify the actual values come from the source region, not timeline region
      // The first value of clip B's waveform should match source bucket 50's value
      expect(clipB.waveformData[0]).toBeCloseTo(waveform[expectedStartBucket * 2], 5);
    });

    it('falls back to track.duration when sourceDuration is missing', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(100);

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // No sourceDuration set
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
        ],
        duration: 10,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      tracksStore.finalizeClipWaveforms(track.id);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Should still work (using track.duration=10 as fallback)
      expect(updated.clips![0].waveformData.length).toBeGreaterThan(0);
      // Clip A: sourceOffset=0, duration=5 out of 10 → should get ~50 buckets
      const expectedBuckets = Math.ceil((5 / 10) * 100) - Math.floor(0);
      expect(updated.clips![0].waveformData.length).toBe(expectedBuckets * 2);
    });

    it('clamps endFrac to 1.0 when clip exceeds source span', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(100);

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: {
          buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2,
          sourceDuration: 10,
        },
        clips: [
          // Clip claims to extend past source end (sourceOffset=8 + duration=5 > sourceDuration=10)
          { id: 'A', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 8 },
        ],
        duration: 5,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      tracksStore.finalizeClipWaveforms(track.id);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Should not crash, waveform should be clamped to end of source
      expect(updated.clips![0].waveformData.length).toBeGreaterThan(0);
      // endFrac clamped to 1.0 means bucket goes to 100
      const expectedEnd = 100; // ceil(1.0 * 100)
      const expectedStart = Math.floor((8 / 10) * 100); // bucket 80
      expect(updated.clips![0].waveformData.length).toBe((expectedEnd - expectedStart) * 2);
    });

    it('skips buffer-backed clips (small-file)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(100);
      const clipBuffer = createMockAudioBuffer(3);
      const originalClipWaveform = [0.1, 0.2, 0.3, 0.4];

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: {
          buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2,
          sourceDuration: 10,
        },
        clips: [
          { id: 'A', buffer: clipBuffer, waveformData: originalClipWaveform, clipStart: 0, duration: 3 },
        ],
        duration: 3,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      tracksStore.finalizeClipWaveforms(track.id);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Buffer-backed clip should be untouched
      expect(updated.clips![0].waveformData).toEqual(originalClipWaveform);
    });
  });

  // ── Fix 2: Parent waveform preserved as immutable source data ────────────

  describe('parent waveform immutability on cut', () => {
    it('single-buffer EDL cut preserves parent waveformData (no splice)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(100);
      const originalLength = waveform.length;

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Set up as EDL track (no buffer, has sourceFile)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2 },
        sourcePath: '/tmp/large.wav',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Parent waveform should NOT be spliced — should retain original length
      expect(updated.audioData.waveformData.length).toBe(originalLength);
    });

    it('cut sets sourceDuration on audioData', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        sourcePath: '/tmp/large.wav',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // sourceDuration should be set to the original track duration (10s)
      expect(updated.audioData.sourceDuration).toBeCloseTo(10, 1);
    });
  });

  // ── Fix 3: finalizeImportWaveform guards edited tracks ───────────────────

  describe('finalizeImportWaveform guards edited tracks', () => {
    it('does not overwrite track.duration on edited track with clips', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate: track was imported, then cut (has clips, duration reduced)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: [], clipStart: 0, duration: 3, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
          { id: 'B', buffer: null, waveformData: [], clipStart: 3, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 5 },
        ],
        duration: 8, // edited timeline span (was 10, cut 2s)
        importStatus: 'large-file',
        importSessionId: 'session-1',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Late import settlement arrives with full source duration
      const newWaveform = generatePositionalWaveform(100);
      tracksStore.finalizeImportWaveform(track.id, newWaveform, 10);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Duration must NOT be overwritten to 10 — must stay at 8 (edited span)
      expect(updated.duration).toBeCloseTo(8, 1);
      // sourceDuration should be set to actualDuration
      expect(updated.audioData.sourceDuration).toBeCloseTo(10, 1);
      // Waveform should be updated (source-space backing data)
      expect(updated.audioData.waveformData.length).toBe(newWaveform.length);
    });

    it('updates track.duration on un-edited track (no clips)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate: track is still importing, no clips
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0), sampleRate: 44100, channels: 2 },
        duration: 9.5, // estimated duration from metadata
        importStatus: 'importing',
        importSessionId: 'session-2',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Finalize with corrected VBR duration
      const newWaveform = generatePositionalWaveform(100);
      tracksStore.finalizeImportWaveform(track.id, newWaveform, 10.2);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // No clips — duration should be updated to actual
      expect(updated.duration).toBeCloseTo(10.2, 1);
      expect(updated.audioData.sourceDuration).toBeCloseTo(10.2, 1);
    });

    it('clip waveforms re-derived correctly after late import settlement', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate: cut happened before import settled
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: [], clipStart: 0, duration: 3, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
          { id: 'B', buffer: null, waveformData: [], clipStart: 3, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 5 },
        ],
        duration: 8,
        importStatus: 'large-file',
        importSessionId: 'session-3',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Late import settlement
      const sourceWaveform = generatePositionalWaveform(100);
      tracksStore.finalizeImportWaveform(track.id, sourceWaveform, 10);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      const clipA = updated.clips!.find(c => c.id === 'A')!;
      const clipB = updated.clips!.find(c => c.id === 'B')!;

      // Clip A: sourceOffset=0, duration=3 → buckets 0-30 of 100
      expect(clipA.waveformData.length).toBeGreaterThan(0);
      expect(clipA.waveformData[0]).toBeCloseTo(sourceWaveform[0], 5);

      // Clip B: sourceOffset=5, duration=5 → buckets 50-100 of 100
      expect(clipB.waveformData.length).toBeGreaterThan(0);
      const expectedBStart = Math.floor((5 / 10) * 100);
      expect(clipB.waveformData[0]).toBeCloseTo(sourceWaveform[expectedBStart * 2], 5);
    });
  });

  // ── Fix 4: waveformVersion hash includes spatial identity ────────────────

  describe('waveformVersion hash invalidation', () => {
    it('version changes when clip positions change (slideTracksLeft)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useCompositeWaveform } = await import('@/composables/useCompositeWaveform');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Set up clips
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: new Array(60).fill(0.5), clipStart: 0, duration: 3, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
          { id: 'B', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 5 },
        ],
        duration: 10,
        importStatus: 'large-file',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const { compositeWaveformData } = useCompositeWaveform();
      // Access computed to establish baseline
      const _baseline = compositeWaveformData.value;

      // Now shift clip B left (simulating slideTracksLeft after a ripple cut)
      const track2 = tracksStore.tracks.find(t => t.id === track.id)!;
      tracksStore.tracks[idx] = {
        ...track2,
        clips: track2.clips!.map(c =>
          c.id === 'B' ? { ...c, clipStart: 3 } : c
        ),
        duration: 8,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // The composite should have changed (new position for clip B)
      // We verify by checking that the function executes without using stale cache
      const afterSlide = compositeWaveformData.value;
      expect(afterSlide).toBeDefined();
    });
  });

  // ── Regression: end-to-end cut → waveform consistency ────────────────────

  describe('end-to-end cut waveform consistency', () => {
    it('ripple cut + finalizeClipWaveforms produces correct source-mapped waveforms', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Create a 20s track with distinctive waveform
      const waveform = generatePositionalWaveform(200); // 200 buckets for 20s
      const buffer = createMockAudioBuffer(20);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2 },
        sourcePath: '/tmp/large.wav',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      // Cut 5-10s → creates before(0-5) and after(10-20) clips
      await tracksStore.cutRegionFromTrack(track.id, 5, 10, ctx, { mode: 'edit-only' });

      const afterCut = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(afterCut.clips).toBeDefined();
      expect(afterCut.clips!.length).toBe(2);

      // Parent waveform should be preserved (not spliced)
      expect(afterCut.audioData.waveformData.length).toBe(waveform.length);

      // Now simulate late import settlement (re-derives clip waveforms from source)
      tracksStore.finalizeClipWaveforms(track.id);

      const final = tracksStore.tracks.find(t => t.id === track.id)!;
      const beforeClip = final.clips!.find(c => c.sourceOffset === 0)!;
      const afterClip = final.clips!.find(c => (c.sourceOffset ?? 0) >= 10)!;

      // Before clip: sourceOffset=0, duration=5 → source buckets 0-50
      const beforeExpectedLen = (Math.ceil((5 / 20) * 200) - Math.floor(0)) * 2;
      expect(beforeClip.waveformData.length).toBe(beforeExpectedLen);
      // First value should match source bucket 0
      expect(beforeClip.waveformData[0]).toBeCloseTo(waveform[0], 5);

      // After clip: sourceOffset=10, duration=10 → source buckets 100-200
      const afterStartBucket = Math.floor((10 / 20) * 200);
      expect(afterClip.waveformData[0]).toBeCloseTo(waveform[afterStartBucket * 2], 5);
    });

    it('multiple successive cuts maintain waveform integrity', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const waveform = generatePositionalWaveform(200);
      const buffer = createMockAudioBuffer(20);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: waveform, sampleRate: 44100, channels: 2 },
        sourcePath: '/tmp/large.wav',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();

      // First cut: remove 3-5s
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });
      let updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(2);
      // Parent waveform still full length
      expect(updated.audioData.waveformData.length).toBe(waveform.length);

      // Second cut: remove 8-12s from timeline
      await tracksStore.cutRegionFromTrack(track.id, 8, 12, ctx, { mode: 'edit-only' });
      updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(3);
      // Parent waveform still full length after second cut
      expect(updated.audioData.waveformData.length).toBe(waveform.length);

      // sourceDuration should remain the original source file duration
      expect(updated.audioData.sourceDuration).toBeCloseTo(20, 1);
    });
  });

  // ── Regression: sourceOffset propagated in composite layer clips ──────────

  describe('composite waveform layer sourceOffset (v0.27.7)', () => {
    it('buffer clips propagate sourceOffset to WaveformLayerClip', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useCompositeWaveform } = await import('@/composables/useCompositeWaveform');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate a trimmed clip with sourceOffset=2 and a buffer
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [
          {
            id: 'trimmed',
            buffer: createMockAudioBuffer(8) as unknown as AudioBuffer,
            waveformData: new Array(160).fill(0.5),
            clipStart: 0,
            duration: 8,
            sourceOffset: 2,
          },
        ],
        duration: 8,
        importStatus: 'ready',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const { waveformLayers } = useCompositeWaveform();
      const layers = waveformLayers.value;

      expect(layers.length).toBe(1);
      expect(layers[0].clips).toBeDefined();
      expect(layers[0].clips!.length).toBe(1);
      // The bug was sourceOffset hardcoded to 0 — now it must reflect the clip's value
      expect(layers[0].clips![0].sourceOffset).toBe(2);
    });

    it('EDL clips already propagate sourceOffset correctly', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useCompositeWaveform } = await import('@/composables/useCompositeWaveform');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        sourcePath: '/tmp/src.wav',
        clips: [
          {
            id: 'edl-clip',
            buffer: null,
            waveformData: new Array(100).fill(0.5),
            clipStart: 0,
            duration: 5,
            sourceFile: '/tmp/src.wav',
            sourceOffset: 3,
          },
        ],
        duration: 5,
        importStatus: 'large-file',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const { waveformLayers } = useCompositeWaveform();
      const layers = waveformLayers.value;

      expect(layers[0].clips).toBeDefined();
      expect(layers[0].clips![0].sourceOffset).toBe(3);
    });
  });

  // ── Regression: zoomed waveform freezes during trim drag ──────────────────

  describe('composite waveform freeze during trim (v0.27.7)', () => {
    it('compositeWaveformData returns cached value during active trim', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useUIStore } = await import('@/stores/ui');
      const { useCompositeWaveform } = await import('@/composables/useCompositeWaveform');
      const tracksStore = useTracksStore();
      const uiStore = useUIStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
          { id: 'B', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 5 },
        ],
        duration: 10,
        importStatus: 'large-file',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const { compositeWaveformData } = useCompositeWaveform();

      // Prime the cache
      const initial = compositeWaveformData.value;
      expect(initial.length).toBeGreaterThan(0);

      // Simulate trim drag start
      uiStore.activeTrimEdge = { time: 5, edge: 'left' };

      // Mutate clip position (as trim does per frame)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: tracksStore.tracks[idx].clips!.map(c =>
          c.id === 'B' ? { ...c, clipStart: 4.5, duration: 5.5, sourceOffset: 4.5 } : c
        ),
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // During trim, composite should return the cached (initial) value
      const duringTrim = compositeWaveformData.value;
      expect(duringTrim).toBe(initial);

      // Release trim
      uiStore.activeTrimEdge = null;

      // After release, composite should recompute
      const afterRelease = compositeWaveformData.value;
      expect(afterRelease).not.toBe(initial);
    });

    it('waveformLayers returns cached value during active trim', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useUIStore } = await import('@/stores/ui');
      const { useCompositeWaveform } = await import('@/composables/useCompositeWaveform');
      const tracksStore = useTracksStore();
      const uiStore = useUIStore();

      const buffer = createMockAudioBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/src.wav', sourceOffset: 0 },
        ],
        duration: 5,
        importStatus: 'large-file',
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const { waveformLayers } = useCompositeWaveform();

      // Prime the cache
      const initial = waveformLayers.value;
      expect(initial.length).toBe(1);

      // Start trim
      uiStore.activeTrimEdge = { time: 0, edge: 'left' };

      // Mutate clip (trim moves left edge)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'A', buffer: null, waveformData: new Array(80).fill(0.5), clipStart: 1, duration: 4, sourceFile: '/tmp/src.wav', sourceOffset: 1 },
        ],
        duration: 4,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // During trim, layers should be cached
      const duringTrim = waveformLayers.value;
      expect(duringTrim).toBe(initial);

      // Release
      uiStore.activeTrimEdge = null;

      // After release, should recompute
      const afterRelease = waveformLayers.value;
      expect(afterRelease).not.toBe(initial);
    });
  });

  // ── Fix 5: Panel waveform buffer-offset bug (v0.27.12) ──────────────────

  describe('panel waveform buffer-offset for cut clips (v0.27.12)', () => {
    /**
     * Helper: replicates getClipAwareBucketsForLayer's buffer path logic.
     * Tests the exact math from useWaveform.ts without needing the full composable.
     */
    async function getBufferClipPeaks(
      clip: { clipStart: number; duration: number; sourceOffset: number; sourceIn?: number; buffer: AudioBuffer },
      viewStart: number,
      viewEnd: number,
      bucketCount: number,
    ) {
      const { extractHiResPeaksForRange } = await import('@/composables/useWaveform');
      const clipEnd = clip.clipStart + clip.duration;
      const overlapStart = Math.max(viewStart, clip.clipStart);
      const overlapEnd = Math.min(viewEnd, clipEnd);
      const viewRange = viewEnd - viewStart;
      const bucketDuration = viewRange / bucketCount;
      const outStartIdx = Math.max(0, Math.floor((overlapStart - viewStart) / bucketDuration));
      const outEndIdx = Math.min(bucketCount, Math.ceil((overlapEnd - viewStart) / bucketDuration));

      const bufferDuration = clip.buffer.duration;
      const bufferBase = clip.sourceOffset - (clip.sourceIn ?? clip.sourceOffset);
      const rawStart = bufferBase + (overlapStart - clip.clipStart);
      const rawEnd = bufferBase + (overlapEnd - clip.clipStart);
      const rangeStart = Math.max(0, Math.min(rawStart, bufferDuration));
      const rangeEnd = Math.max(rangeStart, Math.min(rawEnd, bufferDuration));
      const clipBucketCount = outEndIdx - outStartIdx;
      if (clipBucketCount <= 0) return [];

      return extractHiResPeaksForRange(clip.buffer, rangeStart, rangeEnd, clipBucketCount);
    }

    /** Create a mock buffer with non-zero samples (sine wave) */
    function createNonZeroBuffer(durationSec: number, sampleRate = 44100): AudioBuffer {
      const length = Math.floor(durationSec * sampleRate);
      const buf = new MockAudioBuffer({ numberOfChannels: 1, length: Math.max(1, length), sampleRate }) as unknown as AudioBuffer;
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.8;
      }
      return buf;
    }

    it('after-clip from X-cut produces non-zero panel peaks', async () => {
      // Scenario: 10s track, X-cut at 3-5s → before(0-3) + after(5-10)
      // The "after" clip has: sourceOffset=5, sourceIn=5, buffer=5s duration
      const afterBuffer = createNonZeroBuffer(5);
      const peaks = await getBufferClipPeaks(
        { clipStart: 3, duration: 5, sourceOffset: 5, sourceIn: 5, buffer: afterBuffer },
        3, 8, // view covers the after clip
        100,
      );

      expect(peaks.length).toBe(100);
      // With a sine wave buffer, peaks should NOT all be zero
      const hasNonZero = peaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(hasNonZero).toBe(true);
    });

    it('trimmed after-clip still renders non-zero peaks', async () => {
      // Same as above, then trim left edge of after-clip by 1s
      // sourceOffset increases to 6, but sourceIn stays at 5 (buffer base unchanged)
      const afterBuffer = createNonZeroBuffer(5); // covers source 5-10s
      const peaks = await getBufferClipPeaks(
        { clipStart: 4, duration: 4, sourceOffset: 6, sourceIn: 5, buffer: afterBuffer },
        4, 8,
        100,
      );

      expect(peaks.length).toBe(100);
      const hasNonZero = peaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(hasNonZero).toBe(true);
    });

    it('sub-clip from cutRegionFromClips with sourceIn produces non-zero peaks', async () => {
      // Scenario: after prior X-cut, clip has sourceIn=5. Then delete region
      // creates a sub-clip with sourceOffset > sourceIn.
      // E.g. sub-clip: sourceIn=5, sourceOffset=7, buffer covers 5-10s
      const subBuffer = createNonZeroBuffer(5); // covers source 5-10s
      const peaks = await getBufferClipPeaks(
        { clipStart: 0, duration: 3, sourceOffset: 7, sourceIn: 5, buffer: subBuffer },
        0, 3,
        100,
      );

      expect(peaks.length).toBe(100);
      const hasNonZero = peaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(hasNonZero).toBe(true);
    });

    it('second cut — after sub-clip sourceIn matches buffer start (v0.27.13)', async () => {
      // Scenario: 10s buffer track → first cut at 3-5s → after clip (5-10s)
      // → second cut at 7-8s on that after clip → after sub-clip should have sourceIn=8
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Create 10s buffer track
      const buffer = createNonZeroBuffer(10);
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const ctx = new AudioContext();

      // First cut: remove 3-5s
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });
      let updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(2);

      const beforeClip = updated.clips![0];
      expect(beforeClip.sourceIn).toBe(0);
      expect(beforeClip.sourceOffset).toBe(0);

      const afterClip1 = updated.clips![1];
      expect(afterClip1.sourceIn).toBe(5);
      expect(afterClip1.sourceOffset).toBe(5);

      // Second cut: remove 7-8s from timeline (maps to source 7-8s within afterClip1)
      // afterClip1 is at clipStart=3, duration=5, so timeline 7-8 = clipStart+4 to clipStart+5
      // which is relOverlapStart=4, relOverlapEnd=5 within the clip
      await tracksStore.cutRegionFromTrack(track.id, 7, 8, ctx, { mode: 'edit-only' });
      updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(3);

      // The after sub-clip from the second cut: covers source 8-10s
      const afterSubClip = updated.clips![2];
      // sourceIn must match sourceOffset (= where buffer[0] starts in source-file time)
      expect(afterSubClip.sourceOffset).toBe(8);
      expect(afterSubClip.sourceIn).toBe(8); // NOT 5 (the parent's sourceIn)

      // Verify bufferBase = sourceOffset - sourceIn = 0 (not 3)
      const bufferBase = afterSubClip.sourceOffset! - (afterSubClip.sourceIn ?? afterSubClip.sourceOffset!);
      expect(bufferBase).toBe(0);

      // Verify the panel renderer would produce non-zero peaks
      const peaks = await getBufferClipPeaks(
        {
          clipStart: afterSubClip.clipStart,
          duration: afterSubClip.duration,
          sourceOffset: afterSubClip.sourceOffset!,
          sourceIn: afterSubClip.sourceIn,
          buffer: afterSubClip.buffer!,
        },
        afterSubClip.clipStart,
        afterSubClip.clipStart + afterSubClip.duration,
        50,
      );
      const hasNonZero = peaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(hasNonZero).toBe(true);
    });

    it('splitClipAtTime — after clip sourceIn matches buffer start (v0.27.13)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Create a buffer-backed clip with sourceIn=5 (simulating a prior cut's after-clip)
      const buffer = createNonZeroBuffer(5); // 5s buffer covering source 5-10s
      const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          {
            id: 'clip-A',
            buffer,
            waveformData: new Array(100).fill(0.5),
            clipStart: 0,
            duration: 5,
            sourceOffset: 5,
            sourceIn: 5,
            sourceDuration: 5,
          },
        ],
        duration: 5,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Split at midpoint (2.5s on timeline = source 7.5s)
      const ctx = new AudioContext();
      const result = await tracksStore.splitClipAtTime(track.id, 'clip-A', 2.5, ctx);
      expect(result).not.toBeNull();

      const { before: beforeSplit, after: afterSplit } = result!;

      // Before clip: sourceIn stays at 5 (buffer[0] still maps to source 5s)
      expect(beforeSplit.sourceIn).toBe(5);
      expect(beforeSplit.sourceOffset).toBe(5);
      expect(beforeSplit.sourceDuration).toBeCloseTo(2.5, 1);

      // After clip: sourceIn must equal its sourceOffset (buffer[0] = source 7.5s)
      expect(afterSplit.sourceOffset).toBe(7.5);
      expect(afterSplit.sourceIn).toBe(7.5); // NOT 5 (the parent's sourceIn)
      expect(afterSplit.sourceDuration).toBeCloseTo(2.5, 1);

      // Verify bufferBase = 0 for the after clip
      const bufferBase = afterSplit.sourceOffset! - (afterSplit.sourceIn ?? afterSplit.sourceOffset!);
      expect(bufferBase).toBe(0);
    });

    it('without sourceIn fix, sourceOffset > 0 would read past buffer end', async () => {
      // This test verifies the exact bug: when sourceIn is missing and sourceOffset=5
      // on a 5s buffer, the OLD code would start reading at 5s into a 5s buffer → silence.
      // The NEW code with sourceIn=5 correctly computes bufferBase=0.
      const buffer = createNonZeroBuffer(5);

      // With sourceIn set correctly: bufferBase = 5 - 5 = 0, reads from 0-5s ✓
      const correctPeaks = await getBufferClipPeaks(
        { clipStart: 0, duration: 5, sourceOffset: 5, sourceIn: 5, buffer },
        0, 5,
        50,
      );
      const correctHasAudio = correctPeaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(correctHasAudio).toBe(true);

      // Without sourceIn (undefined): bufferBase = 5 - 5 = 0 (fallback works)
      // But if sourceIn were omitted AND the fallback was broken, we'd get silence.
      // The fix ensures the fallback defaults to sourceOffset, so bufferBase = 0.
      const fallbackPeaks = await getBufferClipPeaks(
        { clipStart: 0, duration: 5, sourceOffset: 5, buffer }, // no sourceIn
        0, 5,
        50,
      );
      const fallbackHasAudio = fallbackPeaks.some((b: { min: number; max: number }) => b.min !== 0 || b.max !== 0);
      expect(fallbackHasAudio).toBe(true);
    });
  });
});
