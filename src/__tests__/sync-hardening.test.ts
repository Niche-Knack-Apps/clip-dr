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

describe('Sync Hardening (INV-1 through INV-5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // INV-5: setImportBuffer must not overwrite edited clip/timeline geometry
  describe('setImportBuffer guard', () => {
    it('does not overwrite duration when track has clips', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Create a track with 10s of audio
      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);

      // Simulate editing: add clips to the track
      const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[trackIdx] = {
        ...tracksStore.tracks[trackIdx],
        clips: [
          { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 3, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: [], clipStart: 5, duration: 4, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
        trackStart: 0,
        duration: 9, // clips span 0-9
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Simulate late import completion with different duration
      const importBuffer = mkBuf(12); // 12s buffer from import
      tracksStore.setImportBuffer(track.id, importBuffer);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Duration should remain 9 (from clips), NOT 12 (from buffer)
      expect(updated.duration).toBe(9);
      // But buffer should be set
      expect(updated.audioData.buffer).toBe(importBuffer);
      // And sourceDuration should reflect the actual file duration
      expect(updated.audioData.sourceDuration).toBe(importBuffer.duration);
      expect(updated.importStatus).toBe('ready');
    });

    it('does overwrite duration when track has NO clips', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);

      // Import a buffer with different duration (VBR correction)
      const importBuffer = mkBuf(12);
      tracksStore.setImportBuffer(track.id, importBuffer);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Duration should be updated to actual import duration
      expect(updated.duration).toBeCloseTo(12, 0);
    });
  });

  // INV-4: syncEpoch monotonically increases on every rendering-relevant mutation
  describe('syncEpoch on editing operations', () => {
    it('increments on clip move (via finalizeClipPositions)', async () => {
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
      tracksStore.setClipStart(track.id, 'c2', 7);
      // setClipStart should NOT bump (drag in progress)
      expect(tracksStore.syncEpoch).toBe(before);

      // finalizeClipPositions commits the drag — should bump
      tracksStore.finalizeClipPositions(track.id);
      expect(tracksStore.syncEpoch).toBeGreaterThan(before);
    });

    it('increments on deleteClipFromTrack', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const before = tracksStore.syncEpoch;
      tracksStore.deleteClipFromTrack(track.id, 'c1');
      expect(tracksStore.syncEpoch).toBeGreaterThan(before);
    });

    it('increments on insertClipAtPlayhead', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
      const before = tracksStore.syncEpoch;

      const clipBuf = mkBuf(2);
      const wf = new Array(100).fill(0.5);
      const ctx = new AudioContext();
      await tracksStore.insertClipAtPlayhead(track.id, clipBuf, wf, 2.5, ctx);
      expect(tracksStore.syncEpoch).toBeGreaterThan(before);
    });

    it('increments on moveClipToTrack', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const trackA = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T-A', 0);
      const trackB = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T-B', 0);

      // Give trackA explicit clips
      const idxA = tracksStore.tracks.findIndex(t => t.id === trackA.id);
      tracksStore.tracks[idxA] = {
        ...tracksStore.tracks[idxA],
        clips: [
          { id: 'cA1', buffer: mkBuf(5), waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'cA2', buffer: mkBuf(5), waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const before = tracksStore.syncEpoch;
      tracksStore.moveClipToTrack(trackA.id, 'cA1', trackB.id, 0);
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
  });

  // INV-1: clipEnd = clipStart + duration (always)
  describe('clip geometry invariants', () => {
    it('moving clip right beyond current extent updates timeline', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
        duration: 10,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Move clip c2 beyond current extent (10 -> starts at 15)
      tracksStore.setClipStart(track.id, 'c2', 15);
      tracksStore.finalizeClipPositions(track.id);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Track duration should now span 0 to 20 (c2 at 15 + 5s)
      expect(updated.trackStart + updated.duration).toBe(20);
    });

    it('cut/delete preserves remaining clip positions', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(15), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
          { id: 'c3', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 10, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 10 },
        ],
        duration: 15,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Delete the middle clip
      tracksStore.deleteClipFromTrack(track.id, 'c2');

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(2);
      // First clip stays at 0
      expect(updated.clips![0].clipStart).toBe(0);
      // Third clip keeps its original position (no ripple — just clip removal)
      expect(updated.clips![1].clipStart).toBe(10);
    });
  });

  // INV-3: clip geometry changes are reflected through getTrackClips (used by playback hash)
  describe('clip geometry visible through getTrackClips', () => {
    it('reflects clip position changes after edit', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0, '/tmp/test.wav');
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/test.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/tmp/test.wav', sourceOffset: 5 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const clipsBefore = tracksStore.getTrackClips(track.id).map(c => c.clipStart);

      // Move c2
      tracksStore.setClipStart(track.id, 'c2', 8);
      tracksStore.finalizeClipPositions(track.id);

      const clipsAfter = tracksStore.getTrackClips(track.id).map(c => c.clipStart);
      expect(clipsAfter).not.toEqual(clipsBefore);
      expect(clipsAfter[1]).toBe(8);
    });
  });

  // INV-5: save/load + late import completion + clip move — import does not overwrite edited geometry
  describe('combined: late import + edit', () => {
    it('import buffer arriving after clip edit does not revert clip geometry', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Create a track (simulating import in-progress)
      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);

      // User edits the track: splits into clips and moves one
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 8, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
        trackStart: 0,
        duration: 13,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Late import completes with the original full buffer
      const importBuffer = mkBuf(10);
      tracksStore.setImportBuffer(track.id, importBuffer);

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Duration should still be 13 (from edited clips), not 10 (from import)
      expect(updated.duration).toBe(13);
      // Clips should be intact
      expect(updated.clips!.length).toBe(2);
      expect(updated.clips![0].clipStart).toBe(0);
      expect(updated.clips![1].clipStart).toBe(8);
    });
  });

  // INV-2: timeline placement independent of source offset
  describe('timeline vs source independence', () => {
    it('clip clipStart is independent of sourceOffset', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Clip starts at timeline position 3, but reads from source at offset 7
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: [], clipStart: 3, duration: 2, sourceFile: '/tmp/a.wav', sourceOffset: 7 },
        ],
        trackStart: 3,
        duration: 2,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips.length).toBe(1);
      expect(clips[0].clipStart).toBe(3);
      expect(clips[0].sourceOffset).toBe(7);
      // They are independent values
      expect(clips[0].clipStart).not.toBe(clips[0].sourceOffset);
    });
  });

  // Test: getTrackClips synthetic clip from single-buffer track
  describe('getTrackClips canonical adapter', () => {
    it('returns synthetic clip for single-buffer track', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 2);

      const track = tracksStore.tracks[0];
      const clips = tracksStore.getTrackClips(track.id);
      expect(clips.length).toBe(1);
      expect(clips[0].clipStart).toBe(2); // trackStart
      expect(clips[0].duration).toBeCloseTo(5, 0);
      expect(clips[0].sourceOffset).toBe(0);
    });

    it('returns actual clips when track has clips array', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: [], clipStart: 6, duration: 4, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips.length).toBe(2);
      expect(clips[0].id).toBe('c1');
      expect(clips[1].id).toBe('c2');
    });
  });

  // Timeline extent update when clip moves beyond boundary during playback
  describe('timeline extent during playback scenario', () => {
    it('clip move beyond previous timeline extent updates timelineDuration via minTimelineDuration', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const track = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        clips: [
          { id: 'c1', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
          { id: 'c2', buffer: null, waveformData: new Array(100).fill(0.5), clipStart: 5, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 5 },
        ],
        duration: 10,
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const durationBefore = tracksStore.timelineDuration;
      expect(durationBefore).toBe(10);

      // Drag c2 to position 20 (extends timeline)
      tracksStore.setClipStart(track.id, 'c2', 20);
      // During drag, minTimelineDuration should have expanded
      expect(tracksStore.timelineDuration).toBeGreaterThanOrEqual(25); // 20 + 5

      // After finalize, timeline should reflect new clip positions
      tracksStore.finalizeClipPositions(track.id);
      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.trackStart + updated.duration).toBe(25);
    });
  });
});
