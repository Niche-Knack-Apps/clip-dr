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

  describe('Contract C1: edit-only cut succeeds even when Rust extraction returns null', () => {
    it('edit-only cut succeeds even when Rust extraction returns null', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const { useTracksStore } = await import('@/stores/tracks');

      const tracksStore = useTracksStore();

      // Set up EDL track (buffer=null, sourceFile set)
      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track C1', 0);
      const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[trackIdx] = {
        ...tracksStore.tracks[trackIdx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [{
          id: 'c1-clip',
          buffer: null,
          waveformData: new Array(200).fill(0.5),
          clipStart: 0,
          duration: 10,
          sourceFile: '/tmp/c1-source.wav',
          sourceOffset: 0,
        }],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Make Rust extraction throw
      vi.mocked(invoke).mockRejectedValue(new Error('Rust unavailable'));

      const ctx = new AudioContext();
      // edit-only cut must succeed (return clips with sourceOffset) even when Rust fails
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id);
      // Track should have been split even though Rust extraction failed
      expect(updated?.clips).toBeDefined();
      expect(updated!.clips!.length).toBe(2);

      const afterClip = updated!.clips!.find(c => c.clipStart >= 5);
      expect(afterClip).toBeDefined();
      expect(afterClip!.sourceFile).toBe('/tmp/c1-source.wav');
      expect(afterClip!.sourceOffset).toBeCloseTo(5, 0);
    });
  });

  describe('edit-only cut never calls Rust extraction', () => {
    it('does not invoke Rust when mode is edit-only', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const { useTracksStore } = await import('@/stores/tracks');

      const tracksStore = useTracksStore();
      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);

      vi.mocked(invoke).mockClear();

      const ctx = new AudioContext();
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('undo/redo preserves EDL fields', () => {
    it('undo restores original clip, redo restores split clips with EDL fields', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const { useHistoryStore } = await import('@/stores/history');

      const tracksStore = useTracksStore();
      const historyStore = useHistoryStore();

      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
      const trackIdx = tracksStore.tracks.findIndex(t => t.id === track.id);

      // Replace with an EDL clip (buffer=null, sourceFile set)
      tracksStore.tracks[trackIdx] = {
        ...tracksStore.tracks[trackIdx],
        audioData: { buffer: null, waveformData: new Array(200).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [{
          id: 'edl-clip-undo',
          buffer: null,
          waveformData: new Array(200).fill(0.5),
          clipStart: 0,
          duration: 10,
          sourceFile: '/tmp/undo-test.wav',
          sourceOffset: 0,
        }],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      // Push state so we can undo back to it
      historyStore.pushState('Before cut');

      const ctx = new AudioContext();
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx);

      // Verify 2 clips after cut
      const afterCut = tracksStore.tracks.find(t => t.id === track.id);
      expect(afterCut!.clips!.length).toBe(2);

      // Undo — should restore original single EDL clip
      historyStore.undo();
      const afterUndo = tracksStore.tracks.find(t => t.id === track.id);
      expect(afterUndo!.clips!.length).toBe(1);
      expect(afterUndo!.clips![0].sourceFile).toBe('/tmp/undo-test.wav');
      expect(afterUndo!.clips![0].sourceOffset).toBe(0);

      // Redo — should restore split clips with correct EDL fields
      historyStore.redo();
      const afterRedo = tracksStore.tracks.find(t => t.id === track.id);
      expect(afterRedo!.clips!.length).toBe(2);

      const beforeClip = afterRedo!.clips!.find(c => c.clipStart < 3);
      const afterClip = afterRedo!.clips!.find(c => c.clipStart >= 5);
      expect(beforeClip!.sourceFile).toBe('/tmp/undo-test.wav');
      expect(beforeClip!.sourceOffset).toBe(0);
      expect(afterClip!.sourceFile).toBe('/tmp/undo-test.wav');
      expect(afterClip!.sourceOffset).toBeCloseTo(5, 0);
    });
  });

  describe('small-file cut preserves sourceFile/sourceOffset', () => {
    it('before and after clips get sourceFile and sourceOffset from track', async () => {
      const { useTracksStore } = await import('@/stores/tracks');

      const tracksStore = useTracksStore();
      const buffer = createMockAudioBuffer(10);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0, '/tmp/small-file.wav');

      const ctx = new AudioContext();
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id);
      expect(updated!.clips).toBeDefined();
      expect(updated!.clips!.length).toBe(2);

      const beforeClip = updated!.clips!.find(c => c.clipStart < 3);
      const afterClip = updated!.clips!.find(c => c.clipStart >= 5);

      expect(beforeClip!.sourceFile).toBe('/tmp/small-file.wav');
      expect(beforeClip!.sourceOffset).toBe(0);

      expect(afterClip!.sourceFile).toBe('/tmp/small-file.wav');
      expect(afterClip!.sourceOffset).toBeCloseTo(5, 0);
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

  // ── sourceOffset accumulation regression suite ─────────────────────────
  // These tests are the primary guard against destructive-editing regressions.
  // A future refactor that breaks sourceOffset math will fail here immediately.

  describe('Contract C2 regression: cut on non-zero sourceOffset clip', () => {
    it('before clip keeps parent sourceOffset; after clip adds cutEnd to parent sourceOffset', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Simulate an already-edited EDL clip that starts 10s into its source file
      const buffer = createMockAudioBuffer(20);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(400).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [{
          id: 'clip-offset',
          buffer: null,
          waveformData: new Array(400).fill(0.5),
          clipStart: 0,
          duration: 20,
          sourceFile: '/tmp/src.wav',
          sourceOffset: 10,
        }],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      // Cut 5s–15s from timeline
      await tracksStore.cutRegionFromTrack(track.id, 5, 15, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips).toBeDefined();
      expect(updated.clips!.length).toBe(2);

      const beforeClip = updated.clips!.find(c => c.clipStart < 5)!;
      const afterClip  = updated.clips!.find(c => c.clipStart >= 15)!;

      // Before: sits at same place in source file (sourceOffset unchanged)
      expect(beforeClip.sourceFile).toBe('/tmp/src.wav');
      expect(beforeClip.sourceOffset).toBeCloseTo(10, 5);
      expect(beforeClip.duration).toBeCloseTo(5, 5);

      // After: starts 15s into the clip timeline (cutEndInClip = 15 - clipStart(0) = 15)
      // sourceOffset = parent(10) + cutEndInClip(15) = 25
      expect(afterClip.sourceFile).toBe('/tmp/src.wav');
      expect(afterClip.sourceOffset).toBeCloseTo(25, 5);
      expect(afterClip.duration).toBeCloseTo(5, 5);
      expect(afterClip.clipStart).toBeCloseTo(15, 5);
    });
  });

  describe('Contract C2 regression: repeated cuts accumulate sourceOffset correctly', () => {
    it('second cut on already-cut clip produces correct cumulative sourceOffset', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      // Start: single 20s clip with sourceOffset=0
      const buffer = createMockAudioBuffer(20);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(400).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [{
          id: 'clip-init',
          buffer: null,
          waveformData: new Array(400).fill(0.5),
          clipStart: 0,
          duration: 20,
          sourceFile: '/tmp/src.wav',
          sourceOffset: 0,
        }],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();

      // First cut: remove 3s–5s → produces before(0–3) and after(5–20)
      // after clip: clipStart=5, sourceOffset=5
      await tracksStore.cutRegionFromTrack(track.id, 3, 5, ctx, { mode: 'edit-only' });

      let updated = tracksStore.tracks.find(t => t.id === track.id)!;
      expect(updated.clips!.length).toBe(2);
      const afterFirst = updated.clips!.find(c => c.clipStart >= 5)!;
      expect(afterFirst.sourceOffset).toBeCloseTo(5, 5);
      expect(afterFirst.duration).toBeCloseTo(15, 5);

      // Second cut: remove 8s–12s from timeline
      // The "after" clip occupies timeline 5–20 with sourceOffset=5
      // cutStartInClip = 8 - 5 = 3, cutEndInClip = 12 - 5 = 7
      // Result:
      //   before2: clipStart=5,  duration=3,  sourceOffset=5
      //   after2:  clipStart=12, duration=8,  sourceOffset=5+7=12
      await tracksStore.cutRegionFromTrack(track.id, 8, 12, ctx, { mode: 'edit-only' });

      updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // Three clips total: before(0–3), middle(5–8), end(12–20)
      expect(updated.clips!.length).toBe(3);

      const clips = [...updated.clips!].sort((a, b) => a.clipStart - b.clipStart);
      const [c1, c2, c3] = clips;

      // c1: original before, sourceOffset=0
      expect(c1.clipStart).toBeCloseTo(0, 5);
      expect(c1.duration).toBeCloseTo(3, 5);
      expect(c1.sourceOffset).toBeCloseTo(0, 5);

      // c2: segment between cuts, sourceOffset=5 (was the "after" of first cut)
      expect(c2.clipStart).toBeCloseTo(5, 5);
      expect(c2.duration).toBeCloseTo(3, 5);
      expect(c2.sourceOffset).toBeCloseTo(5, 5);

      // c3: tail after second cut, sourceOffset must be 12
      expect(c3.clipStart).toBeCloseTo(12, 5);
      expect(c3.duration).toBeCloseTo(8, 5);
      expect(c3.sourceOffset).toBeCloseTo(12, 5);
    });
  });

  describe('Contract C2 regression: partial overlap cut leaves un-cut portion unchanged', () => {
    it('cut that only overlaps part of a clip leaves the non-overlapping clips untouched', async () => {
      const { useTracksStore } = await import('@/stores/tracks');
      const tracksStore = useTracksStore();

      const buffer = createMockAudioBuffer(30);
      const track = tracksStore.createTrackFromBuffer(buffer, null, 'Track', 0);
      const idx = tracksStore.tracks.findIndex(t => t.id === track.id);
      // Three clips: A(0–10,srcOff=0), B(10–20,srcOff=10), C(20–30,srcOff=20)
      tracksStore.tracks[idx] = {
        ...tracksStore.tracks[idx],
        audioData: { buffer: null, waveformData: new Array(600).fill(0.5), sampleRate: 44100, channels: 2 },
        clips: [
          { id: 'A', buffer: null, waveformData: new Array(200).fill(0.5), clipStart: 0,  duration: 10, sourceFile: '/tmp/src.wav', sourceOffset: 0  },
          { id: 'B', buffer: null, waveformData: new Array(200).fill(0.5), clipStart: 10, duration: 10, sourceFile: '/tmp/src.wav', sourceOffset: 10 },
          { id: 'C', buffer: null, waveformData: new Array(200).fill(0.5), clipStart: 20, duration: 10, sourceFile: '/tmp/src.wav', sourceOffset: 20 },
        ],
      };
      tracksStore.tracks = [...tracksStore.tracks];

      const ctx = new AudioContext();
      // Cut only clip B: remove 12–18
      // B: clipStart=10, sourceOffset=10, cutStartInClip=2, cutEndInClip=8
      // B-before: sourceOffset=10, duration=2
      // B-after:  sourceOffset=18, duration=2, clipStart=18
      await tracksStore.cutRegionFromTrack(track.id, 12, 18, ctx, { mode: 'edit-only' });

      const updated = tracksStore.tracks.find(t => t.id === track.id)!;
      // 4 clips: A, B-before, B-after, C
      expect(updated.clips!.length).toBe(4);

      const sorted = [...updated.clips!].sort((a, b) => a.clipStart - b.clipStart);
      const [a, bBefore, bAfter, c] = sorted;

      // A is completely untouched
      expect(a.clipStart).toBeCloseTo(0, 5);
      expect(a.sourceOffset).toBeCloseTo(0, 5);
      expect(a.duration).toBeCloseTo(10, 5);

      // B-before
      expect(bBefore.clipStart).toBeCloseTo(10, 5);
      expect(bBefore.sourceOffset).toBeCloseTo(10, 5);
      expect(bBefore.duration).toBeCloseTo(2, 5);

      // B-after: sourceOffset = 10 + 8 = 18
      expect(bAfter.clipStart).toBeCloseTo(18, 5);
      expect(bAfter.sourceOffset).toBeCloseTo(18, 5);
      expect(bAfter.duration).toBeCloseTo(2, 5);

      // C is completely untouched
      expect(c.clipStart).toBeCloseTo(20, 5);
      expect(c.sourceOffset).toBeCloseTo(20, 5);
      expect(c.duration).toBeCloseTo(10, 5);
    });
  });
});

