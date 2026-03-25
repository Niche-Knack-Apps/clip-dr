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

// ─── 1. Channel Lane Data Model ─────────────────────────────────────────────

describe('Channel Lane Data Model', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('stereo track has channelMode stereo', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    expect(track.channelMode).toBe('stereo');
  });

  it('mono track has channelMode mono', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 1);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Mono Track', 0);

    expect(track.channelMode).toBe('mono');
  });

  it('toggleChannelLinked toggles between true/false', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Default is linked
    expect(track.channelLinked).toBe(true);

    // Toggle to unlinked
    tracksStore.toggleChannelLinked(track.id);
    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelLinked).toBe(false);

    // Toggle back to linked
    tracksStore.toggleChannelLinked(track.id);
    const restored = tracksStore.getTrackById(track.id)!;
    expect(restored.channelLinked).toBe(true);
  });

  it('materializeChannelLanes creates L/R lanes', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Toggle to unlink — this materializes lanes
    tracksStore.toggleChannelLinked(track.id);
    const updated = tracksStore.getTrackById(track.id)!;

    expect(updated.channelLanes).toBeDefined();
    expect(updated.channelLanes!.length).toBe(2);
    expect(updated.channelLanes![0].channelIndex).toBe(0);
    expect(updated.channelLanes![0].kind).toBe('left');
    expect(updated.channelLanes![1].channelIndex).toBe(1);
    expect(updated.channelLanes![1].kind).toBe('right');
  });

  it('L lane keeps parent clip IDs, R lane gets new IDs', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Promote to explicit clips first to get stable parent clip IDs
    const parentClipId = tracksStore.promoteToExplicitClips(track.id);
    expect(parentClipId).toBeTruthy();

    const parentClips = tracksStore.getTrackClips(track.id);
    const parentIds = parentClips.map(c => c.id);

    // Materialize lanes via toggle
    tracksStore.toggleChannelLinked(track.id);
    const updated = tracksStore.getTrackById(track.id)!;

    // L lane keeps the parent clip IDs
    const lLaneIds = updated.channelLanes![0].clips.map(c => c.id);
    expect(lLaneIds).toEqual(parentIds);

    // R lane gets new IDs (different from parent)
    const rLaneIds = updated.channelLanes![1].clips.map(c => c.id);
    for (const rId of rLaneIds) {
      expect(parentIds).not.toContain(rId);
    }
  });

  it('linkedClipGroupId shared between L/R counterparts', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    tracksStore.toggleChannelLinked(track.id);
    const updated = tracksStore.getTrackById(track.id)!;

    const lLane = updated.channelLanes![0];
    const rLane = updated.channelLanes![1];

    // Each L clip should share linkedClipGroupId with corresponding R clip
    expect(lLane.clips.length).toBe(rLane.clips.length);
    for (let i = 0; i < lLane.clips.length; i++) {
      expect(lLane.clips[i].linkedClipGroupId).toBeTruthy();
      expect(lLane.clips[i].linkedClipGroupId).toBe(rLane.clips[i].linkedClipGroupId);
    }
  });

  it('re-materialization is guarded', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize via toggle
    tracksStore.toggleChannelLinked(track.id);
    const afterFirst = tracksStore.getTrackById(track.id)!;
    const firstLaneIds = afterFirst.channelLanes!.map(l => l.id);
    const firstLClipIds = afterFirst.channelLanes![0].clips.map(c => c.id);

    // Call materializeChannelLanes directly again — should be a no-op
    tracksStore.materializeChannelLanes(track.id);
    const afterSecond = tracksStore.getTrackById(track.id)!;
    const secondLaneIds = afterSecond.channelLanes!.map(l => l.id);
    const secondLClipIds = afterSecond.channelLanes![0].clips.map(c => c.id);

    expect(secondLaneIds).toEqual(firstLaneIds);
    expect(secondLClipIds).toEqual(firstLClipIds);
  });
});

// ─── 2. Lane-Aware Editing ──────────────────────────────────────────────────

describe('Lane-Aware Editing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('linked setClipStart moves both lanes together', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize lanes but keep linked (toggle unlink then re-link)
    tracksStore.toggleChannelLinked(track.id); // unlink + materialize
    tracksStore.toggleChannelLinked(track.id); // re-link (lanes stay)

    const linked = tracksStore.getTrackById(track.id)!;
    expect(linked.channelLinked).toBe(true);
    expect(linked.channelLanes).toBeDefined();

    const lClipId = linked.channelLanes![0].clips[0].id;
    const rClipBefore = linked.channelLanes![1].clips[0].clipStart;

    // Move L clip to position 2.0 (snap disabled)
    tracksStore.setClipStart(track.id, lClipId, 2.0, false);

    const updated = tracksStore.getTrackById(track.id)!;
    const lClipAfter = updated.channelLanes![0].clips[0].clipStart;
    const rClipAfter = updated.channelLanes![1].clips[0].clipStart;

    // Both lanes should have moved by the same delta
    expect(lClipAfter).toBe(2.0);
    const delta = lClipAfter - 0; // original was at 0
    expect(rClipAfter).toBe(rClipBefore + delta);
  });

  it('unlinked setClipStart moves only targeted lane', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink (materializes lanes and stays unlinked)
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;
    expect(unlinked.channelLinked).toBe(false);

    const lClipId = unlinked.channelLanes![0].clips[0].id;
    const rClipBefore = unlinked.channelLanes![1].clips[0].clipStart;

    // Move L clip
    tracksStore.setClipStart(track.id, lClipId, 2.0, false);

    const updated = tracksStore.getTrackById(track.id)!;
    const lClipAfter = updated.channelLanes![0].clips[0].clipStart;
    const rClipAfter = updated.channelLanes![1].clips[0].clipStart;

    // Only L moved
    expect(lClipAfter).toBe(2.0);
    expect(rClipAfter).toBe(rClipBefore);
  });

  it('linked trimClipLeft trims both lanes', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize and keep linked
    tracksStore.toggleChannelLinked(track.id);
    tracksStore.toggleChannelLinked(track.id);

    const linked = tracksStore.getTrackById(track.id)!;
    const lClipId = linked.channelLanes![0].clips[0].id;
    const lDurBefore = linked.channelLanes![0].clips[0].duration;
    const rDurBefore = linked.channelLanes![1].clips[0].duration;

    // Trim left edge inward by 1 second
    tracksStore.trimClipLeft(track.id, lClipId, 1.0);

    const updated = tracksStore.getTrackById(track.id)!;
    const lDurAfter = updated.channelLanes![0].clips[0].duration;
    const rDurAfter = updated.channelLanes![1].clips[0].duration;

    // Both should be trimmed by the same amount
    expect(lDurAfter).toBeCloseTo(lDurBefore - 1.0, 5);
    expect(rDurAfter).toBeCloseTo(rDurBefore - 1.0, 5);
  });

  it('unlinked trimClipLeft trims only targeted lane', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;

    const lClipId = unlinked.channelLanes![0].clips[0].id;
    const rDurBefore = unlinked.channelLanes![1].clips[0].duration;

    // Trim left edge inward by 1 second on L only
    tracksStore.trimClipLeft(track.id, lClipId, 1.0);

    const updated = tracksStore.getTrackById(track.id)!;
    const lDurAfter = updated.channelLanes![0].clips[0].duration;
    const rDurAfter = updated.channelLanes![1].clips[0].duration;

    // L trimmed, R unchanged
    expect(lDurAfter).toBeCloseTo(5 - 1.0, 5);
    expect(rDurAfter).toBeCloseTo(rDurBefore, 5);
  });

  it('deleteClipFromTrack removes from lane and paired clip when linked', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize and keep linked
    tracksStore.toggleChannelLinked(track.id);
    tracksStore.toggleChannelLinked(track.id);

    const linked = tracksStore.getTrackById(track.id)!;
    expect(linked.channelLinked).toBe(true);
    const lClipId = linked.channelLanes![0].clips[0].id;

    // Delete L clip — since linked, R clip should also be removed
    tracksStore.deleteClipFromTrack(track.id, lClipId);

    // Track should be deleted (no clips left) — getTrackById returns undefined
    const deleted = tracksStore.getTrackById(track.id);
    expect(deleted).toBeUndefined();
  });

  it('deleteClipFromTrack removes only from lane when unlinked', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;

    const lClipId = unlinked.channelLanes![0].clips[0].id;
    const rClipId = unlinked.channelLanes![1].clips[0].id;

    // Delete L clip — unlinked, so R should remain
    tracksStore.deleteClipFromTrack(track.id, lClipId);

    const updated = tracksStore.getTrackById(track.id);
    expect(updated).toBeDefined();

    // R lane clip should still exist
    const rLane = updated!.channelLanes![1];
    expect(rLane.clips.length).toBe(1);
    expect(rLane.clips[0].id).toBe(rClipId);

    // L lane should be empty
    const lLane = updated!.channelLanes![0];
    expect(lLane.clips.length).toBe(0);
  });

  it('finalizeClipPositions uses all lane clips for bounds', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink to allow independent movement
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;

    const lClipId = unlinked.channelLanes![0].clips[0].id;

    // Move L clip to position 3.0
    tracksStore.setClipStart(track.id, lClipId, 3.0, false);

    // Finalize — track bounds should encompass both L (3.0–8.0) and R (0.0–5.0)
    tracksStore.finalizeClipPositions(track.id);

    const finalized = tracksStore.getTrackById(track.id)!;
    expect(finalized.trackStart).toBe(0); // R clip starts at 0
    expect(finalized.duration).toBeCloseTo(8.0, 5); // L clip ends at 3+5=8
  });
});

// ─── 3. Snap System with Lanes ──────────────────────────────────────────────

describe('Snap System with Lanes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setClipStart with snap considers lane clips for alignment', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    // Create a stereo track at position 0 (duration 5s, so lane clips end at 5.0)
    const buffer1 = createMockAudioBuffer(5, 44100, 2);
    const track1 = await tracksStore.createTrackFromBuffer(buffer1, null, 'Track 1', 0);

    // Create a second track at position 10 (far away, duration 3s)
    const buffer2 = createMockAudioBuffer(3, 44100, 2);
    const track2 = await tracksStore.createTrackFromBuffer(buffer2, null, 'Track 2', 10);
    // Promote track2 to explicit clips so setClipStart works on it
    tracksStore.promoteToExplicitClips(track2.id);

    // Materialize lanes on track1 (creates lane clips at 0–5)
    tracksStore.toggleChannelLinked(track1.id);

    // Get track2's clip ID
    const clips2 = tracksStore.getTrackClips(track2.id);
    const clip2Id = clips2[0].id;

    // Move track2 clip to 4.99 with snap enabled — should snap to 5.0 (end of track1's lane clip)
    tracksStore.setClipStart(track2.id, clip2Id, 4.99, true);

    const updated2 = tracksStore.getTrackById(track2.id)!;
    const movedClip = updated2.clips!.find(c => c.id === clip2Id)!;

    // Should have snapped to 5.0 (aligning start with end of track1's lane clips)
    expect(movedClip.clipStart).toBeCloseTo(5.0, 2);
  });
});

// ─── 4. Per-Lane Volume ─────────────────────────────────────────────────────

describe('Per-Lane Volume', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setChannelLaneVolume sets independently when unlinked', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink and materialize
    tracksStore.toggleChannelLinked(track.id);

    // Set L volume to 0.5
    tracksStore.setChannelLaneVolume(track.id, 0, 0.5);

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelLanes![0].volume).toBe(0.5);
    // R should remain at its initial value (track.volume = 1.0)
    expect(updated.channelLanes![1].volume).toBe(1.0);
  });

  it('setChannelLaneVolume sets all lanes when linked', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize lanes and keep linked
    tracksStore.toggleChannelLinked(track.id);
    tracksStore.toggleChannelLinked(track.id);

    const linked = tracksStore.getTrackById(track.id)!;
    expect(linked.channelLinked).toBe(true);

    // Set L volume — should propagate to both lanes
    tracksStore.setChannelLaneVolume(track.id, 0, 0.7);

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelLanes![0].volume).toBe(0.7);
    expect(updated.channelLanes![1].volume).toBe(0.7);
    expect(updated.volume).toBe(0.7);
  });

  it('addChannelLaneVolumePoint creates new array ref', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize lanes
    tracksStore.toggleChannelLinked(track.id);

    const before = tracksStore.getTrackById(track.id)!;
    const envBefore = before.channelLanes![0].volumeEnvelope;

    // Add a volume automation point
    tracksStore.addChannelLaneVolumePoint(track.id, 0, 1.0, 0.8);

    const after = tracksStore.getTrackById(track.id)!;
    const envAfter = after.channelLanes![0].volumeEnvelope;

    // Should have a new array reference (not the same as before)
    expect(envAfter).not.toBe(envBefore);
    expect(envAfter).toBeDefined();
    expect(envAfter!.length).toBe(1);
    expect(envAfter![0].time).toBe(1.0);
    expect(envAfter![0].value).toBe(0.8);
  });
});

// ─── 5. Extract Region with Lanes ───────────────────────────────────────────

describe('Extract Region with Lanes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('extractRegionFromAllTracks uses lane clips when materialized', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Unlink and move L clip independently
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;
    const lClipId = unlinked.channelLanes![0].clips[0].id;

    // Move L clip to position 2.0
    tracksStore.setClipStart(track.id, lClipId, 2.0, false);
    tracksStore.finalizeClipPositions(track.id);

    const audioContext = new MockAudioContext() as unknown as AudioContext;

    // Extract region 0–3 — should include R clip (0–5) and partial L clip (2–7 overlaps at 2–3)
    const result = await tracksStore.extractRegionFromAllTracks(0, 3, audioContext);

    // Should return a buffer (contributions found from lane clips)
    expect(result).not.toBeNull();
    expect(result!.buffer).not.toBeNull();
  });
});

// ─── 6. Cut Region with Lanes ───────────────────────────────────────────────

describe('Cut Region with Lanes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('cutRegionFromTrack trims lane clips', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 0);

    // Materialize lanes
    tracksStore.toggleChannelLinked(track.id);

    const audioContext = new MockAudioContext() as unknown as AudioContext;

    // Cut region 1–3 from the track (overlaps both lane clips which span 0–5)
    const result = await tracksStore.cutRegionFromTrack(track.id, 1, 3, audioContext);

    expect(result).not.toBeNull();

    // Verify lane clips were trimmed: each lane should now have 2 clips (before and after the cut)
    const updated = tracksStore.getTrackById(track.id)!;
    for (const lane of updated.channelLanes!) {
      // Each lane had a single clip 0–5; cutting 1–3 should produce:
      // clip 1: 0–1 and clip 2: 3–5
      expect(lane.clips.length).toBe(2);
      expect(lane.clips[0].clipStart).toBeCloseTo(0, 5);
      expect(lane.clips[0].duration).toBeCloseTo(1.0, 5);
      expect(lane.clips[1].clipStart).toBeCloseTo(3.0, 5);
      expect(lane.clips[1].duration).toBeCloseTo(2.0, 5);
    }
  });

  it('slideTracksLeft shifts lane clips', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo Track', 2);

    // Materialize lanes
    tracksStore.toggleChannelLinked(track.id);

    const before = tracksStore.getTrackById(track.id)!;
    const lClipStartBefore = before.channelLanes![0].clips[0].clipStart;
    const rClipStartBefore = before.channelLanes![1].clips[0].clipStart;

    // Slide tracks left by 1 second starting at gap position 0
    tracksStore.slideTracksLeft(0, 1);

    const after = tracksStore.getTrackById(track.id)!;
    const lClipStartAfter = after.channelLanes![0].clips[0].clipStart;
    const rClipStartAfter = after.channelLanes![1].clips[0].clipStart;

    // Both lane clips should have shifted left by 1 second
    expect(lClipStartAfter).toBeCloseTo(lClipStartBefore - 1, 5);
    expect(rClipStartAfter).toBeCloseTo(rClipStartBefore - 1, 5);
  });
});

// ─── 7. Channel Conversion (placeholder) ────────────────────────────────────

describe('Channel Conversion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('replaceWithChannel keeps L channel on both', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(2, 44100, 2);
    // Put distinct data on each channel
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < lData.length; i++) { lData[i] = 0.5; rData[i] = -0.5; }

    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    expect(track.audioData.channels).toBe(2);

    tracksStore.replaceWithChannel(track.id, 0); // keep L

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.audioData.buffer!.numberOfChannels).toBe(2);
    // Both channels should now have L's data (0.5)
    const ch0 = updated.audioData.buffer!.getChannelData(0);
    const ch1 = updated.audioData.buffer!.getChannelData(1);
    expect(ch0[0]).toBeCloseTo(0.5);
    expect(ch1[0]).toBeCloseTo(0.5);
    // Lanes should be cleared
    expect(updated.channelLanes).toBeUndefined();
    expect(updated.channelLinked).toBe(true);
  });

  it('replaceWithChannel keeps R channel on both', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(2, 44100, 2);
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < lData.length; i++) { lData[i] = 0.5; rData[i] = -0.5; }

    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    tracksStore.replaceWithChannel(track.id, 1); // keep R

    const updated = tracksStore.getTrackById(track.id)!;
    const ch0 = updated.audioData.buffer!.getChannelData(0);
    const ch1 = updated.audioData.buffer!.getChannelData(1);
    expect(ch0[0]).toBeCloseTo(-0.5);
    expect(ch1[0]).toBeCloseTo(-0.5);
  });

  it('convertToStereo doubles mono to both channels', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(2, 44100, 1); // mono
    const monoData = buffer.getChannelData(0);
    for (let i = 0; i < monoData.length; i++) { monoData[i] = 0.75; }

    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Mono', 0);
    expect(track.channelMode).toBe('mono');
    expect(track.audioData.channels).toBe(1);

    tracksStore.convertToStereo(track.id);

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelMode).toBe('stereo');
    expect(updated.audioData.channels).toBe(2);
    expect(updated.audioData.buffer!.numberOfChannels).toBe(2);
    const ch0 = updated.audioData.buffer!.getChannelData(0);
    const ch1 = updated.audioData.buffer!.getChannelData(1);
    expect(ch0[0]).toBeCloseTo(0.75);
    expect(ch1[0]).toBeCloseTo(0.75);
  });

  it('replaceWithChannel adopts kept lane clip positions', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(5, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);

    // Materialize and unlink lanes
    tracksStore.toggleChannelLinked(track.id);
    const unlinked = tracksStore.getTrackById(track.id)!;

    // Move L clip to position 3.0
    const lClipId = unlinked.channelLanes![0].clips[0].id;
    tracksStore.setClipStart(track.id, lClipId, 3.0, false);

    // Replace with L channel — should adopt L lane's clip positions
    tracksStore.replaceWithChannel(track.id, 0);

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelLanes).toBeUndefined();
    // The parent clips should have the L lane's position (3.0)
    expect(updated.clips).toBeDefined();
    expect(updated.clips![0].clipStart).toBeCloseTo(3.0, 1);
  });

  it('convertToMono downmixes L+R to single channel', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(2, 44100, 2);
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < lData.length; i++) { lData[i] = 0.8; rData[i] = 0.2; }

    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);
    expect(track.channelMode).toBe('stereo');

    tracksStore.convertToMono(track.id);

    const updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelMode).toBe('mono');
    expect(updated.audioData.channels).toBe(1);
    expect(updated.audioData.buffer!.numberOfChannels).toBe(1);
    // Downmix: (0.8 + 0.2) * 0.5 = 0.5
    const monoData = updated.audioData.buffer!.getChannelData(0);
    expect(monoData[0]).toBeCloseTo(0.5);
    expect(updated.channelLanes).toBeUndefined();
  });

  it('mono→stereo→mono round-trip preserves audio', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(1, 44100, 1);
    const monoData = buffer.getChannelData(0);
    for (let i = 0; i < monoData.length; i++) { monoData[i] = 0.6; }

    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Mono', 0);

    // Mono → Stereo
    tracksStore.convertToStereo(track.id);
    let updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelMode).toBe('stereo');
    expect(updated.audioData.channels).toBe(2);

    // Stereo → Mono (downmix)
    tracksStore.convertToMono(track.id);
    updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelMode).toBe('mono');
    expect(updated.audioData.channels).toBe(1);
    // Both channels were 0.6, so downmix = (0.6 + 0.6) * 0.5 = 0.6
    const resultData = updated.audioData.buffer!.getChannelData(0);
    expect(resultData[0]).toBeCloseTo(0.6, 2);
  });

  it('cut with I/O points does not delete entire track after conversion', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = createMockAudioBuffer(10, 44100, 2);
    const track = await tracksStore.createTrackFromBuffer(buffer, null, 'Stereo', 0);

    // Convert to mono then back to stereo
    tracksStore.convertToMono(track.id);
    tracksStore.convertToStereo(track.id);

    let updated = tracksStore.getTrackById(track.id)!;
    expect(updated.channelMode).toBe('stereo');
    expect(updated.duration).toBeCloseTo(10, 0);

    // Simulate I/O cut on middle 2 seconds (2-4)
    const audioContext = new MockAudioContext() as unknown as AudioContext;
    await tracksStore.cutRegionFromTrack(track.id, 2, 4, audioContext, { keepTrack: true });

    // Track should still exist, not be deleted
    updated = tracksStore.getTrackById(track.id)!;
    expect(updated).toBeDefined();
    // Should have clips (before and/or after segments) from the cut
    expect(updated.clips).toBeDefined();
    expect(updated.clips!.length).toBeGreaterThanOrEqual(1);
  });
});
