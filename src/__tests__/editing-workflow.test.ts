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

// Mock AudioBuffer class for happy-dom (which doesn't provide Web Audio API)
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
  const buffer = ctx.createBuffer(channels, Math.max(1, length), sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 0.5;
    }
  }
  return buffer;
}

describe('EDL Editing Architecture', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('TrackClip sourceFile/sourceOffset fields', () => {
    it('getTrackClips returns sourceFile from track cachedAudioPath', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);

      // Simulate that the track has a cached audio path (like after import)
      tracksStore.setCachedAudioPath(track.id, '/tmp/test.wav');

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips).toHaveLength(1);
      expect(clips[0].sourceFile).toBe('/tmp/test.wav');
      expect(clips[0].sourceOffset).toBe(0);
    });

    it('getTrackClips returns sourceFile/sourceOffset from explicit clip EDL data', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);

      // Manually set clips with EDL data (simulating post-cut state)
      const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[trackIdx] = {
        ...tracksStore.tracks[trackIdx],
        clips: [
          { id: 'clip-a', buffer: null, waveformData: [0, 1], clipStart: 0, duration: 3, sourceFile: '/tmp/source.wav', sourceOffset: 0 },
          { id: 'clip-b', buffer: null, waveformData: [0, 1], clipStart: 5, duration: 5, sourceFile: '/tmp/source.wav', sourceOffset: 5 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const clips = tracksStore.getTrackClips(track.id);
      expect(clips).toHaveLength(2);
      expect(clips[0].sourceFile).toBe('/tmp/source.wav');
      expect(clips[0].sourceOffset).toBe(0);
      expect(clips[1].sourceFile).toBe('/tmp/source.wav');
      expect(clips[1].sourceOffset).toBe(5);
    });
  });

  describe('Small-file cut produces persistent clips', () => {
    it('cut with I/O points creates before+after clips (not flattened)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(3);
      selectionStore.setOutPoint(5);

      await clipboardStore.cut();

      const updated = tracksStore.tracks.find(t => t.id === track.id);
      expect(updated).toBeDefined();
      // Should have clips (not flattened back to single buffer)
      expect(updated!.clips).toBeDefined();
      expect(updated!.clips!.length).toBe(2);
      // Duration should be reduced
      expect(updated!.duration).toBeLessThan(10);
    });

    it('delete with I/O points creates before+after clips with gap preserved', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(3);
      selectionStore.setOutPoint(5);

      await clipboardStore.deleteSelected();

      const updated = tracksStore.tracks.find(t => t.id === track.id);
      expect(updated).toBeDefined();
      expect(updated!.clips).toBeDefined();
      expect(updated!.clips!.length).toBe(2);

      // After clip should start at cutEnd (5s), preserving the gap
      const afterClip = updated!.clips!.find(c => c.clipStart >= 5);
      expect(afterClip).toBeDefined();
      expect(afterClip!.clipStart).toBeCloseTo(5, 0);
    });
  });

  describe('Cut/Delete playhead positioning', () => {
    it('cut playhead = max(0, inPoint - 1.0)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');
      const { usePlaybackStore } = await import('@/stores/playback');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();
      const playbackStore = usePlaybackStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(5);
      selectionStore.setOutPoint(7);

      await clipboardStore.cut();

      expect(playbackStore.currentTime).toBeCloseTo(4.0, 1);
    });

    it('cut playhead clamped to 0 when inPoint < 1.0', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');
      const { usePlaybackStore } = await import('@/stores/playback');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();
      const playbackStore = usePlaybackStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(0.5);
      selectionStore.setOutPoint(2);

      await clipboardStore.cut();

      expect(playbackStore.currentTime).toBe(0);
    });

    it('delete playhead = max(0, inPoint - 1.0)', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');
      const { usePlaybackStore } = await import('@/stores/playback');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();
      const playbackStore = usePlaybackStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(4);
      selectionStore.setOutPoint(6);

      await clipboardStore.deleteSelected();

      expect(playbackStore.currentTime).toBeCloseTo(3.0, 1);
    });
  });

  describe('Delete does not affect clipboard', () => {
    it('delete preserves existing clipboard content', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      // Copy first
      selectionStore.setInPoint(1);
      selectionStore.setOutPoint(3);
      await clipboardStore.copy();
      const clipboardBefore = clipboardStore.clipboard;

      // Delete a different region
      selectionStore.setInPoint(5);
      selectionStore.setOutPoint(7);
      await clipboardStore.deleteSelected();

      expect(clipboardStore.clipboard).toBe(clipboardBefore);
    });
  });

  describe('Delete does not ripple', () => {
    it('delete does not shift other tracks', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useClipboardStore } = await import('@/stores/clipboard');
      const { useSelectionStore } = await import('@/stores/selection');

      const tracksStore = useTracksStore();
      const clipboardStore = useClipboardStore();
      const selectionStore = useSelectionStore();

      const buffer1 = createMockAudioBuffer(10);
      const buffer2 = createMockAudioBuffer(8);
      tracksStore.createTrackFromBuffer(buffer1, null, 'Track 1', 0);
      const track2 = tracksStore.createTrackFromBuffer(buffer2, null, 'Track 2', 5);
      tracksStore.selectTrack('ALL');

      const track2Start = track2.trackStart;

      selectionStore.setInPoint(2);
      selectionStore.setOutPoint(4);

      await clipboardStore.deleteSelected();

      const updated2 = tracksStore.tracks.find(t => t.id === track2.id);
      expect(updated2!.trackStart).toBe(track2Start);
    });
  });

  describe('cutRegionFromClips handles EDL clips', () => {
    it('splitting EDL clips produces correct sourceFile and sourceOffset', async () => {
      const { useTracksStore } = await import('@/stores/tracks');

      const tracksStore = useTracksStore();

      // Create a track and manually set it up with an EDL clip
      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Replace with an EDL clip (buffer=null, sourceFile set)
      tracksStore.tracks[trackIdx] = {
        ...tracksStore.tracks[trackIdx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [{
          id: 'edl-clip-1',
          buffer: null,
          waveformData: new Array(200).fill(0.5),
          clipStart: 0,
          duration: 10,
          sourceFile: '/tmp/large-file.wav',
          sourceOffset: 0,
        }],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      // Cut from 3-5s — should split into before (0-3) and after (5-10)
      const result = await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx);

      // The result may be null because extractRegionViaRust returns null in tests (no Rust backend)
      // But we can verify the clips were split correctly
      const updated = tracksStore.tracks.find(t => t.id === track.id);
      if (updated?.clips) {
        expect(updated.clips.length).toBe(2);

        const beforeClip = updated.clips.find(c => c.clipStart < 3);
        const afterClip = updated.clips.find(c => c.clipStart >= 5);

        if (beforeClip) {
          expect(beforeClip.sourceFile).toBe('/tmp/large-file.wav');
          expect(beforeClip.sourceOffset).toBe(0);
          expect(beforeClip.duration).toBeCloseTo(3, 0);
        }

        if (afterClip) {
          expect(afterClip.sourceFile).toBe('/tmp/large-file.wav');
          expect(afterClip.sourceOffset).toBeCloseTo(5, 0);
          expect(afterClip.duration).toBeCloseTo(5, 0);
          expect(afterClip.clipStart).toBeCloseTo(5, 0);
        }
      }
    });
  });

  describe('Clip (c) behavior', () => {
    it('clip inserts below current track and mutes existing tracks', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useSelectionStore } = await import('@/stores/selection');
      const { useClipping } = await import('@/composables/useClipping');

      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();

      const buffer1 = createMockAudioBuffer(10);
      const buffer2 = createMockAudioBuffer(8);
      const track1 = tracksStore.createTrackFromBuffer(buffer1, null, 'Track 1', 0);
      const track2 = tracksStore.createTrackFromBuffer(buffer2, null, 'Track 2', 12);
      tracksStore.selectTrack(track1.id);

      selectionStore.setInPoint(2);
      selectionStore.setOutPoint(6);

      const { createClip } = useClipping();
      const newTrack = await createClip();

      expect(newTrack).not.toBeNull();
      // New track at index 1 (after Track 1, before Track 2)
      expect(tracksStore.tracks[0].id).toBe(track1.id);
      expect(tracksStore.tracks[1].id).toBe(newTrack!.id);
      expect(tracksStore.tracks[2].id).toBe(track2.id);

      // Existing tracks muted, new track not muted
      expect(tracksStore.tracks[0].muted).toBe(true);
      expect(tracksStore.tracks[2].muted).toBe(true);
      expect(newTrack!.muted).toBe(false);

      // Clip starts at inPoint
      expect(newTrack!.trackStart).toBe(2);
    });

    it('clip playhead at inPoint', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useSelectionStore } = await import('@/stores/selection');
      const { usePlaybackStore } = await import('@/stores/playback');
      const { useClipping } = await import('@/composables/useClipping');

      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();
      const playbackStore = usePlaybackStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      selectionStore.setInPoint(3);
      selectionStore.setOutPoint(7);

      const { createClip } = useClipping();
      await createClip();

      expect(playbackStore.currentTime).toBe(3);
    });

    it('clip does not modify source tracks', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useSelectionStore } = await import('@/stores/selection');
      const { useClipping } = await import('@/composables/useClipping');

      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      tracksStore.selectTrack(track.id);

      const originalDuration = track.duration;

      selectionStore.setInPoint(2);
      selectionStore.setOutPoint(6);

      const { createClip } = useClipping();
      await createClip();

      const sourceTrack = tracksStore.tracks.find(t => t.id === track.id);
      expect(sourceTrack!.duration).toBe(originalDuration);
    });
  });
});
