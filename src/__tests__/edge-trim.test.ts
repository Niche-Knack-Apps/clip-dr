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

/** Helper: set up a track with two explicit clips and sourceIn/sourceDuration */
async function setupClippedTrack() {
  const { useTracksStore } = await import('@/stores/tracks');
  const tracksStore = useTracksStore();

  // Create a 20s source file track
  const track = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
  const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

  // Simulate an EDL track with two clips from a 20s source
  const clips: TrackClip[] = [
    {
      id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5),
      clipStart: 0, duration: 8,
      sourceFile: '/tmp/src.wav', sourceOffset: 2,
      sourceIn: 0, sourceDuration: 20,
    },
    {
      id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5),
      clipStart: 10, duration: 5,
      sourceFile: '/tmp/src.wav', sourceOffset: 12,
      sourceIn: 0, sourceDuration: 20,
    },
  ];

  tracksStore.tracks[idx] = {
    ...tracksStore.tracks[idx],
    clips,
    trackStart: 0,
    duration: 15,
  };
  tracksStore.tracks = [...tracksStore.tracks];

  return { tracksStore, trackId: track.id };
}

describe('Recoverable Edge Trim', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('trimClipLeft', () => {
    it('increases sourceOffset, decreases duration, advances clipStart', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      tracksStore.trimClipLeft(trackId, 'c1', 2); // trim 2s from left

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.sourceOffset).toBe(4);   // was 2, +2
      expect(clip.clipStart).toBe(2);      // was 0, +2
      expect(clip.duration).toBe(6);       // was 8, -2
    });

    it('expands outward with negative delta (recover hidden audio)', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // Trim in first, then recover
      tracksStore.trimClipLeft(trackId, 'c1', 3); // trim 3s
      tracksStore.trimClipLeft(trackId, 'c1', -2); // recover 2s

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.sourceOffset).toBe(3);   // 2+3-2 = 3
      expect(clip.clipStart).toBe(1);      // 0+3-2 = 1
      expect(clip.duration).toBe(7);       // 8-3+2 = 7
    });

    it('is clamped by sourceIn (cannot trim left past original start)', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // c1 has sourceOffset=2, sourceIn=0 — can recover 2s to the left
      tracksStore.trimClipLeft(trackId, 'c1', -5); // try to expand 5s left

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      // Should be clamped: sourceOffset cannot go below sourceIn (0)
      expect(clip.sourceOffset).toBe(0);
      expect(clip.clipStart).toBe(-2); // expanded 2s to the left
      expect(clip.duration).toBe(10);  // 8 + 2 recovered
    });
  });

  describe('trimClipRight', () => {
    it('decreases duration with negative delta (trim inward)', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      tracksStore.trimClipRight(trackId, 'c1', -3); // trim 3s from right

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBe(5);       // was 8, -3
      expect(clip.clipStart).toBe(0);      // unchanged
      expect(clip.sourceOffset).toBe(2);   // unchanged
    });

    it('increases duration with positive delta (recover hidden audio)', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // Trim right first, then recover
      tracksStore.trimClipRight(trackId, 'c1', -3); // trim 3s
      tracksStore.trimClipRight(trackId, 'c1', 2);  // recover 2s

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBe(7); // 8 - 3 + 2
    });

    it('is clamped by sourceIn + sourceDuration', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // c1: sourceOffset=2, duration=8, sourceIn=0, sourceDuration=20
      // Max duration from sourceOffset=2 to end of source = 20-2 = 18
      tracksStore.trimClipRight(trackId, 'c1', 100); // try huge expand

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBe(18); // 20 - 2
    });
  });

  describe('trim recovery round-trip', () => {
    it('after trim inward, can expand back to full original extent', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      const originalClip = { ...tracksStore.tracks.find(t => t.id === trackId)!.clips![0] };

      // Trim both sides inward
      tracksStore.trimClipLeft(trackId, 'c1', 2);
      tracksStore.trimClipRight(trackId, 'c1', -3);

      // Verify it's trimmed
      let clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBe(3); // 8 - 2 - 3

      // Recover fully
      tracksStore.trimClipLeft(trackId, 'c1', -2);
      tracksStore.trimClipRight(trackId, 'c1', 3);

      clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.sourceOffset).toBe(originalClip.sourceOffset);
      expect(clip.clipStart).toBe(originalClip.clipStart);
      expect(clip.duration).toBe(originalClip.duration);
    });
  });

  describe('syncEpoch', () => {
    it('increments on edge trim', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      const before = tracksStore.syncEpoch;
      tracksStore.trimClipLeft(trackId, 'c1', 1);
      expect(tracksStore.syncEpoch).toBeGreaterThan(before);

      const before2 = tracksStore.syncEpoch;
      tracksStore.trimClipRight(trackId, 'c1', -1);
      expect(tracksStore.syncEpoch).toBeGreaterThan(before2);
    });
  });

  describe('finalizeEdgeTrim', () => {
    it('recomputes track bounds correctly', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // Trim c1 from the left
      tracksStore.trimClipLeft(trackId, 'c1', 2);

      tracksStore.finalizeEdgeTrim(trackId);

      const track = tracksStore.tracks.find(t => t.id === trackId)!;
      // c1 now at clipStart=2, dur=6, c2 at clipStart=10, dur=5
      expect(track.trackStart).toBe(2);
      expect(track.duration).toBe(13); // 15-2
    });

    it('does not mutate unrelated clips', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      const c2Before = { ...tracksStore.tracks.find(t => t.id === trackId)!.clips![1] };

      tracksStore.trimClipLeft(trackId, 'c1', 2);
      tracksStore.finalizeEdgeTrim(trackId);

      const c2After = tracksStore.tracks.find(t => t.id === trackId)!.clips![1];
      expect(c2After.clipStart).toBe(c2Before.clipStart);
      expect(c2After.duration).toBe(c2Before.duration);
      expect(c2After.sourceOffset).toBe(c2Before.sourceOffset);
      expect(c2After.sourceIn).toBe(c2Before.sourceIn);
      expect(c2After.sourceDuration).toBe(c2Before.sourceDuration);
    });
  });

  describe('clip creation from split preserves sourceIn/sourceDuration', () => {
    it('splitClipAtTime propagates parent sourceIn/sourceDuration', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [{
          id: 'c1', buffer: null, waveformData: new Array(200).fill(0.5),
          clipStart: 0, duration: 10,
          sourceFile: '/tmp/src.wav', sourceOffset: 5,
          sourceIn: 0, sourceDuration: 30,
        }],
        duration: 10,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      const result = await tracksStore.splitClipAtTime(track.id, 'c1', 4, ctx);

      expect(result).not.toBeNull();
      // Both halves should inherit parent's full recovery range
      expect(result!.before.sourceIn).toBe(0);
      expect(result!.before.sourceDuration).toBe(30);
      expect(result!.after.sourceIn).toBe(0);
      expect(result!.after.sourceDuration).toBe(30);
    });
  });

  describe('sourceDuration uses source metadata', () => {
    it('getTrackClips synthetic clip uses audioData.sourceDuration', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Simulate source duration metadata from import (longer than visible duration)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: {
          ...tracksStore.tracks[idx].audioData,
          sourceDuration: 15, // actual source file is 15s
        },
        duration: 10, // but visible duration is 10s (e.g., trimmed)
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips[0].sourceDuration).toBe(15); // uses source metadata, not visible duration
    });

    it('getTrackClips synthetic clip falls back to track.duration', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // No sourceDuration set on audioData
      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips[0].sourceDuration).toBeCloseTo(10, 0); // falls back to track.duration
    });
  });

  describe('minimum clip duration', () => {
    it('trimClipLeft does not shrink clip below MIN_CLIP_DURATION', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // c1 has duration 8; try to trim 7.999s (leaving 0.001s, below min)
      tracksStore.trimClipLeft(trackId, 'c1', 7.999);

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBeGreaterThanOrEqual(0.01);
    });

    it('trimClipRight does not shrink clip below MIN_CLIP_DURATION', async () => {
      const { tracksStore, trackId } = await setupClippedTrack();

      // c1 has duration 8; try to trim 7.999s inward
      tracksStore.trimClipRight(trackId, 'c1', -7.999);

      const clip = tracksStore.tracks.find(t => t.id === trackId)!.clips![0];
      expect(clip.duration).toBeGreaterThanOrEqual(0.01);
    });
  });
});
