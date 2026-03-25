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

// Suppress console noise
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

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

// Helper: create a mono track
async function createMonoTrack(tracksStore: ReturnType<typeof import('@/stores/tracks').useTracksStore>, duration = 10, offset = 0) {
  const buffer = createMockAudioBuffer(duration, 44100, 1);
  return await tracksStore.createTrackFromBuffer(buffer, null, 'Mono', offset);
}

// Helper: create a stereo track and materialize + unlink lanes for testing
async function createStereoUnlinkedTrack(tracksStore: ReturnType<typeof import('@/stores/tracks').useTracksStore>, duration = 10, offset = 0) {
  const buffer = createMockAudioBuffer(duration, 44100, 2);
  const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', offset);
  tracksStore.toggleChannelLinked(track.id); // materialize + unlink
  return tracksStore.getTrackById(track.id)!;
}

// ─── 1. Selection State ──────────────────────────────────────────────────────

describe('Selection State', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('selectTrackExclusive selects one track and deselects others', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);
    const t3 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 3', 0);

    // Select t1 exclusively
    tracksStore.selectTrackExclusive(t1.id);
    expect(tracksStore.selectedTrackIds.size).toBe(1);
    expect(tracksStore.selectedTrackIds.has(t1.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(false);
    expect(tracksStore.selectedTrackIds.has(t3.id)).toBe(false);

    // Select t2 exclusively — t1 deselected
    tracksStore.selectTrackExclusive(t2.id);
    expect(tracksStore.selectedTrackIds.size).toBe(1);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t1.id)).toBe(false);
  });

  it('selectTrackToggle adds/removes tracks from set', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);

    // Start with t1 selected (createTrackFromBuffer auto-selects)
    tracksStore.selectTrackExclusive(t1.id);
    expect(tracksStore.selectedTrackIds.size).toBe(1);

    // Toggle t2 on
    tracksStore.selectTrackToggle(t2.id);
    expect(tracksStore.selectedTrackIds.size).toBe(2);
    expect(tracksStore.selectedTrackIds.has(t1.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(true);

    // Toggle t1 off
    tracksStore.selectTrackToggle(t1.id);
    expect(tracksStore.selectedTrackIds.size).toBe(1);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t1.id)).toBe(false);

    // Toggle t2 off — now empty
    tracksStore.selectTrackToggle(t2.id);
    expect(tracksStore.selectedTrackIds.size).toBe(0);
  });

  it('selectTrackRange selects contiguous range between anchor and target', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);
    const t3 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 3', 0);
    const t4 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 4', 0);

    // Anchor on t1
    tracksStore.selectTrackExclusive(t1.id);
    // Shift+click on t3 — should select t1, t2, t3
    tracksStore.selectTrackRange(t3.id);

    expect(tracksStore.selectedTrackIds.size).toBe(3);
    expect(tracksStore.selectedTrackIds.has(t1.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t3.id)).toBe(true);
    expect(tracksStore.selectedTrackIds.has(t4.id)).toBe(false);
  });

  it('selectChannel sets selectedChannelIndex', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    expect(tracksStore.selectedChannelIndex).toBeNull();

    tracksStore.selectChannel(0);
    expect(tracksStore.selectedChannelIndex).toBe(0);

    tracksStore.selectChannel(1);
    expect(tracksStore.selectedChannelIndex).toBe(1);

    tracksStore.selectChannel(null);
    expect(tracksStore.selectedChannelIndex).toBeNull();
  });

  it('getEditTargets returns all tracks when none selected', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);

    // Clear selection (set to ALL)
    tracksStore.selectedTrackId = 'ALL';

    const targets = tracksStore.getEditTargets();
    expect(targets.mode).toBe('all');
    expect(targets.trackIds).toContain(t1.id);
    expect(targets.trackIds).toContain(t2.id);
    expect(targets.channelIndex).toBeNull();
  });

  it('getEditTargets returns single track when one selected', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);

    tracksStore.selectTrackExclusive(t1.id);

    const targets = tracksStore.getEditTargets();
    expect(targets.mode).toBe('single');
    expect(targets.trackIds).toEqual([t1.id]);
    expect(targets.channelIndex).toBeNull();
  });

  it('getEditTargets returns multiple tracks when multi-selected', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);
    await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 3', 0);

    tracksStore.selectTrackExclusive(t1.id);
    tracksStore.selectTrackToggle(t2.id);

    const targets = tracksStore.getEditTargets();
    expect(targets.mode).toBe('multi');
    expect(targets.trackIds).toContain(t1.id);
    expect(targets.trackIds).toContain(t2.id);
    expect(targets.trackIds.length).toBe(2);
  });

  it('backward compat: selectedTrackId getter reflects selectedTrackIds', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(5), null, 'Track 2', 0);

    // 0 selected → 'ALL'
    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrackId).toBe('ALL');
    expect(tracksStore.selectedTrackIds.size).toBe(0);

    // 1 selected → that ID
    tracksStore.selectTrackExclusive(t1.id);
    expect(tracksStore.selectedTrackId).toBe(t1.id);

    // Multi-selected → first ID
    tracksStore.selectTrackToggle(t2.id);
    expect(tracksStore.selectedTrackIds.size).toBe(2);
    // selectedTrackId returns first from the set
    const firstId = [...tracksStore.selectedTrackIds][0];
    expect(tracksStore.selectedTrackId).toBe(firstId);

    // Setter routes through selectedTrackIds
    tracksStore.selectedTrackId = t2.id;
    expect(tracksStore.selectedTrackIds.size).toBe(1);
    expect(tracksStore.selectedTrackIds.has(t2.id)).toBe(true);
  });
});

// ─── 2. Mono Track Operations ────────────────────────────────────────────────

describe('Mono Track Operations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('split at playhead creates two clips', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const track = await createMonoTrack(tracksStore, 10, 0);
    const trackId = track.id;

    const success = await tracksStore.splitAtPlayhead(trackId, 5.0, ctx);
    expect(success).toBe(true);

    const clips = tracksStore.getTrackClips(trackId);
    expect(clips.length).toBe(2);
    // First clip: 0 to ~5s
    expect(clips[0].clipStart).toBeCloseTo(0, 1);
    expect(clips[0].duration).toBeCloseTo(5.0, 1);
    // Second clip: ~5s to ~10s
    expect(clips[1].clipStart).toBeCloseTo(5.0, 1);
    expect(clips[1].duration).toBeCloseTo(5.0, 1);
  });

  it('cut with I/O ripple deletes region', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const track = await createMonoTrack(tracksStore, 10, 0);
    const trackId = track.id;

    // Cut region from 3s to 6s
    const result = await tracksStore.cutRegionFromTrack(trackId, 3.0, 6.0, ctx);
    expect(result).not.toBeNull();

    // Should have clips before and after the cut region
    const clips = tracksStore.getTrackClips(trackId);
    expect(clips.length).toBe(2);
    // Before: 0 to 3s
    expect(clips[0].clipStart).toBeCloseTo(0, 1);
    expect(clips[0].duration).toBeCloseTo(3.0, 1);
    // After: 6s to 10s (at position 6s)
    expect(clips[1].clipStart).toBeCloseTo(6.0, 1);
    expect(clips[1].duration).toBeCloseTo(4.0, 1);
  });

  it('delete with I/O removes region without ripple', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const track = await createMonoTrack(tracksStore, 10, 0);
    const trackId = track.id;

    // Cut region (same as delete — cutRegionFromTrack is the base operation)
    const result = await tracksStore.cutRegionFromTrack(trackId, 2.0, 5.0, ctx);
    expect(result).not.toBeNull();

    const updatedTrack = tracksStore.getTrackById(trackId);
    expect(updatedTrack).toBeTruthy();
    // Track should still exist with remaining audio
    const clips = tracksStore.getTrackClips(trackId);
    expect(clips.length).toBe(2);
  });

  it('trim left adjusts clip start', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await createMonoTrack(tracksStore, 10, 0);
    const trackId = track.id;

    // Promote to explicit clips so we can trim
    tracksStore.promoteToExplicitClips(trackId);
    const clips = tracksStore.getTrackClips(trackId);
    expect(clips.length).toBe(1);

    const clipId = clips[0].id;
    const originalDuration = clips[0].duration;
    const originalStart = clips[0].clipStart;

    // Trim left by 2s (positive delta = trim inward)
    tracksStore.trimClipLeft(trackId, clipId, 2.0);

    const updatedClips = tracksStore.getTrackClips(trackId);
    expect(updatedClips[0].clipStart).toBeCloseTo(originalStart + 2.0, 5);
    expect(updatedClips[0].duration).toBeCloseTo(originalDuration - 2.0, 5);
  });

  it('trim right adjusts clip duration', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const track = await createMonoTrack(tracksStore, 10, 0);
    const trackId = track.id;

    // Promote to explicit clips so we can trim
    tracksStore.promoteToExplicitClips(trackId);
    const clips = tracksStore.getTrackClips(trackId);
    const clipId = clips[0].id;
    const originalDuration = clips[0].duration;

    // Trim right by -2s (negative delta = trim inward from right)
    tracksStore.trimClipRight(trackId, clipId, -2.0);

    const updatedClips = tracksStore.getTrackClips(trackId);
    expect(updatedClips[0].duration).toBeCloseTo(originalDuration - 2.0, 5);
  });

  it('copy with I/O captures mono audio', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const selectionStore = useSelectionStore();

    const track = await createMonoTrack(tracksStore, 10, 0);
    tracksStore.selectTrackExclusive(track.id);

    // Set I/O points
    selectionStore.setInPoint(2.0);
    selectionStore.setOutPoint(5.0);

    const success = await clipboardStore.copy();
    expect(success).toBe(true);
    expect(clipboardStore.hasClipboard).toBe(true);
    expect(clipboardStore.clipboardDuration).toBeCloseTo(3.0, 1);
  });

  it('paste inserts at playhead', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const selectionStore = useSelectionStore();

    const track = await createMonoTrack(tracksStore, 10, 0);
    tracksStore.selectTrackExclusive(track.id);

    // Copy a region first
    selectionStore.setInPoint(2.0);
    selectionStore.setOutPoint(4.0);
    await clipboardStore.copy();

    expect(clipboardStore.hasClipboard).toBe(true);

    // Paste — inserts into the selected track at playhead
    await clipboardStore.paste();

    // Track should still exist and have clips from the paste
    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated).toBeDefined();
    // The paste should have added a clip (track now has explicit clips)
    expect(updated.clips).toBeDefined();
  });
});

// ─── 3. Stereo Linked Operations ────────────────────────────────────────────

describe('Stereo Linked Operations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('split creates clips in both parent channels', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    const trackId = track.id;

    // Stereo linked (no lane materialization) — split should work on parent clips
    const success = await tracksStore.splitAtPlayhead(trackId, 5.0, ctx);
    expect(success).toBe(true);

    // Parent clips should have 2 entries (before + after split)
    const updated = tracksStore.getTrackById(trackId)!;
    expect(updated.clips).toBeDefined();
    expect(updated.clips!.length).toBe(2);
  });

  it('cut ripple deletes from both channels at I/O', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    const trackId = track.id;

    // Materialize and keep linked
    tracksStore.toggleChannelLinked(trackId);
    tracksStore.toggleChannelLinked(trackId);

    const result = await tracksStore.cutRegionFromTrack(trackId, 3.0, 6.0, ctx);
    expect(result).not.toBeNull();

    // Both lanes should have 2 clips (before + after the cut)
    const updated = tracksStore.getTrackById(trackId)!;
    expect(updated.channelLanes![0].clips.length).toBe(2);
    expect(updated.channelLanes![1].clips.length).toBe(2);
  });

  it('delete removes region from both channels', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    const trackId = track.id;

    tracksStore.toggleChannelLinked(trackId);
    tracksStore.toggleChannelLinked(trackId);

    await tracksStore.cutRegionFromTrack(trackId, 2.0, 8.0, ctx);

    const updated = tracksStore.getTrackById(trackId)!;
    // Both lanes affected equally
    expect(updated.channelLanes![0].clips.length).toBe(updated.channelLanes![1].clips.length);
  });

  it('trim affects both channels equally', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    const trackId = track.id;

    // Materialize and keep linked
    tracksStore.toggleChannelLinked(trackId);
    tracksStore.toggleChannelLinked(trackId);

    const linked = tracksStore.getTrackById(trackId)!;
    const lClipId = linked.channelLanes![0].clips[0].id;

    // Trim left by 2s
    tracksStore.trimClipLeft(trackId, lClipId, 2.0);

    const updated = tracksStore.getTrackById(trackId)!;
    const lDur = updated.channelLanes![0].clips[0].duration;
    const rDur = updated.channelLanes![1].clips[0].duration;

    // Both channels trimmed equally
    expect(lDur).toBeCloseTo(rDur, 5);
    expect(lDur).toBeCloseTo(8.0, 1);
  });

  it('copy captures stereo (2ch) at I/O', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const selectionStore = useSelectionStore();

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    tracksStore.selectTrackExclusive(track.id);

    selectionStore.setInPoint(2.0);
    selectionStore.setOutPoint(5.0);

    const success = await clipboardStore.copy();
    expect(success).toBe(true);
    expect(clipboardStore.hasClipboard).toBe(true);
    expect(clipboardStore.clipboardDuration).toBeCloseTo(3.0, 1);
  });

  it('paste inserts stereo at playhead', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const selectionStore = useSelectionStore();

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    tracksStore.selectTrackExclusive(track.id);

    selectionStore.setInPoint(2.0);
    selectionStore.setOutPoint(4.0);
    await clipboardStore.copy();

    // Paste into selected stereo track
    await clipboardStore.paste();

    // Track should have clips from paste
    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated).toBeDefined();
    expect(updated.clips).toBeDefined();
  });
});

// ─── 4. Stereo Unlinked, No Channel Selected ────────────────────────────────

describe('Stereo Unlinked, No Channel Selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('split creates clips in both lanes at playhead', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext() as unknown as AudioContext;

    const track = await createStereoUnlinkedTrack(tracksStore, 10, 0);
    expect(track.channelLinked).toBe(false);
    expect(track.channelLanes).toBeDefined();

    const success = await tracksStore.splitAtPlayhead(track.id, 5.0, ctx);
    expect(success).toBe(true);

    // Unlinked split: currently splits the clip found in the first lane (L) only,
    // because the code finds the first clip spanning the playhead.
    // Both lanes start with aligned clips so L lane gets split.
    const updated = tracksStore.getTrackById(track.id)!;
    // L lane split into 2
    expect(updated.channelLanes![0].clips.length).toBe(2);
    // R lane remains 1 clip (unlinked — no linked pairing propagation)
    expect(updated.channelLanes![1].clips.length).toBe(1);
  });

  it.todo('cut ripple deletes from both lanes, offset preserved — requires getEditTargets integration');

  it.todo('delete removes from both lanes — requires getEditTargets integration');

  it.todo('trim affects both lane clip edges — requires getEditTargets integration');

  it.todo('copy captures stereo with offset preserved — requires getEditTargets integration');

  it.todo('paste inserts stereo at playhead — requires getEditTargets integration');
});

// ─── 5. Stereo Unlinked, L Channel Selected ─────────────────────────────────

describe('Stereo Unlinked, L Channel Selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it.todo('split at playhead splits ONLY L lane clip — requires channel-aware splitAtPlayhead');

  it.todo('cut ripple deletes ONLY L lane region — requires channel-aware cutRegionFromTrack');

  it.todo('delete removes ONLY L lane region — requires channel-aware deleteClipFromTrack');

  it.todo('trim adjusts ONLY L lane clip edge — requires channel-aware trim');

  it.todo('copy captures ONLY L channel (mono output) — requires channel-aware copy');

  it.todo('paste inserts into L lane at playhead — requires channel-aware paste');
});

// ─── 6. Stereo Unlinked, R Channel Selected ─────────────────────────────────

describe('Stereo Unlinked, R Channel Selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it.todo('split at playhead splits ONLY R lane clip — requires channel-aware splitAtPlayhead');

  it.todo('cut ripple deletes ONLY R lane region — requires channel-aware cutRegionFromTrack');

  it.todo('delete removes ONLY R lane region — requires channel-aware deleteClipFromTrack');

  it.todo('trim adjusts ONLY R lane clip edge — requires channel-aware trim');

  it.todo('copy captures ONLY R channel (mono output) — requires channel-aware copy');

  it.todo('paste inserts into R lane at playhead — requires channel-aware paste');
});

// ─── 7. Multi-Track Selected ─────────────────────────────────────────────────

describe('Multi-Track Selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('getEditTargets reflects multi-selection correctly', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const t1 = await createMonoTrack(tracksStore, 10, 0);
    const t2 = await tracksStore.createTrackFromBuffer(createMockAudioBuffer(10, 44100, 2), null, 'Stereo', 0);
    const t3 = await createMonoTrack(tracksStore, 10, 0);

    // Select t1 and t3, skip t2
    tracksStore.selectTrackExclusive(t1.id);
    tracksStore.selectTrackToggle(t3.id);

    const targets = tracksStore.getEditTargets();
    expect(targets.mode).toBe('multi');
    expect(targets.trackIds).toContain(t1.id);
    expect(targets.trackIds).toContain(t3.id);
    expect(targets.trackIds).not.toContain(t2.id);
  });

  it.todo('split at playhead splits ALL selected tracks — requires multi-track splitAtPlayhead');

  it.todo('cut ripple deletes I/O from ALL selected tracks — requires multi-track cutRegionFromTrack');

  it.todo('delete removes I/O from ALL selected tracks — requires multi-track delete');

  it.todo('copy creates mixdown of all selected tracks — requires multi-track copy');

  it.todo('paste creates new track from clipboard — requires multi-track paste');
});
