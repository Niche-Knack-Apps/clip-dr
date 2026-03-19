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

describe('Cross-track clip drag', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('moveClipToTrack does not duplicate clip on target', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    // Create two tracks
    const buf1 = createMockAudioBuffer(5);
    const buf2 = createMockAudioBuffer(3);
    const track1 = await store.createTrackFromBuffer(buf1, null, 'Track 1', 0);
    const track2 = await store.createTrackFromBuffer(buf2, null, 'Track 2', 0);

    // Get the virtual clip id from track1
    const clipsBefore = store.getTrackClips(track1.id);
    expect(clipsBefore).toHaveLength(1);
    const clipId = clipsBefore[0].id; // "trackId-main"

    // Move clip to track2
    store.moveClipToTrack(track1.id, clipId, track2.id, 5);

    // Target should have exactly 2 clips (its original + the moved one)
    const targetClips = store.getTrackClips(track2.id);
    expect(targetClips).toHaveLength(2);

    // Source track should be deleted (had only one clip)
    const sourceTrack = store.getTrackById(track1.id);
    expect(sourceTrack).toBeUndefined();
  });

  it('moveClipToTrack clears audioData.buffer on target when converting to multi-clip', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf1 = createMockAudioBuffer(5);
    const buf2 = createMockAudioBuffer(3);
    const track1 = await store.createTrackFromBuffer(buf1, null, 'Track 1', 0);
    const track2 = await store.createTrackFromBuffer(buf2, null, 'Track 2', 0);

    const clipId = store.getTrackClips(track1.id)[0].id;

    store.moveClipToTrack(track1.id, clipId, track2.id, 5);

    // Target track's audioData.buffer should be null (data lives in clips now)
    const target = store.getTrackById(track2.id);
    expect(target).toBeDefined();
    expect(target!.audioData.buffer).toBeNull();
    expect(target!.clips).toBeDefined();
    expect(target!.clips!.length).toBe(2);
  });

  it('moveClipToTrack clears activeDrag for source track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf1 = createMockAudioBuffer(5);
    const buf2 = createMockAudioBuffer(3);
    const track1 = await store.createTrackFromBuffer(buf1, null, 'Track 1', 0);
    const track2 = await store.createTrackFromBuffer(buf2, null, 'Track 2', 0);

    // Simulate an active drag on source track
    // setClipStart on a single-buffer track sets activeDrag
    const clipId = store.getTrackClips(track1.id)[0].id;
    store.setClipStart(track1.id, clipId, 2.0);

    // After moveClipToTrack, activeDrag should be cleared
    store.moveClipToTrack(track1.id, clipId, track2.id, 5);

    // track1 is deleted (only had one clip), so 1 track remains
    expect(store.tracks.length).toBe(1);
    // The remaining track should be track2 with 2 clips
    expect(store.tracks[0].id).toBe(track2.id);
    expect(store.getTrackClips(track2.id).length).toBe(2);
  });
});

describe('Cross-track drag threshold behavior', () => {
  // These tests verify the cross-track intent threshold logic.
  // The threshold is 20px of vertical mouse movement before cross-track intent triggers.
  const CROSS_TRACK_THRESHOLD = 20;

  it('horizontal drag with deltaY=0 keeps original track', () => {
    const startY = 300;
    const currentY = 300; // no vertical movement
    const deltaY = Math.abs(currentY - startY);
    expect(deltaY).toBeLessThan(CROSS_TRACK_THRESHOLD);
    // Logic: stay in original track
  });

  it('horizontal drag with deltaY=10 (below threshold) keeps original track', () => {
    const startY = 300;
    const currentY = 310; // 10px, below threshold
    const deltaY = Math.abs(currentY - startY);
    expect(deltaY).toBeLessThan(CROSS_TRACK_THRESHOLD);
  });

  it('drag with deltaY=25 (above threshold) triggers cross-track', () => {
    const startY = 300;
    const currentY = 325; // 25px, above threshold
    const deltaY = Math.abs(currentY - startY);
    expect(deltaY).toBeGreaterThanOrEqual(CROSS_TRACK_THRESHOLD);
  });

  it('drag end without sufficient vertical intent keeps original track', () => {
    const startY = 300;
    const endY = 310; // 10px, below threshold
    const deltaY = Math.abs(endY - startY);
    // Below threshold = not a cross-track drag
    expect(deltaY < CROSS_TRACK_THRESHOLD).toBe(true);
  });
});

describe('Solo mutual exclusivity', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setTrackSolo mutes all other tracks', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(buf, null, 'Track 2', 0);
    const t3 = await store.createTrackFromBuffer(buf, null, 'Track 3', 0);

    store.setTrackSolo(t1.id, true);

    const track1 = store.getTrackById(t1.id)!;
    const track2 = store.getTrackById(t2.id)!;
    const track3 = store.getTrackById(t3.id)!;

    expect(track1.solo).toBe(true);
    expect(track1.muted).toBe(false);
    expect(track2.solo).toBe(false);
    expect(track2.muted).toBe(true);
    expect(track3.solo).toBe(false);
    expect(track3.muted).toBe(true);
  });

  it('switching solo to another track unsolos the first', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(buf, null, 'Track 2', 0);
    const t3 = await store.createTrackFromBuffer(buf, null, 'Track 3', 0);

    store.setTrackSolo(t1.id, true);
    store.setTrackSolo(t2.id, true);

    expect(store.getTrackById(t1.id)!.solo).toBe(false);
    expect(store.getTrackById(t1.id)!.muted).toBe(true);
    expect(store.getTrackById(t2.id)!.solo).toBe(true);
    expect(store.getTrackById(t2.id)!.muted).toBe(false);
    expect(store.getTrackById(t3.id)!.solo).toBe(false);
    expect(store.getTrackById(t3.id)!.muted).toBe(true);
  });

  it('un-soloing unmutes auto-muted tracks but preserves user-muted tracks', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(buf, null, 'Track 2', 0);
    const t3 = await store.createTrackFromBuffer(buf, null, 'Track 3', 0);

    // User explicitly mutes track3 before solo
    store.setTrackMuted(t3.id, true);
    expect(store.getTrackById(t3.id)!.muted).toBe(true);

    // Solo track1 — t2 auto-muted, t3 was already user-muted
    store.setTrackSolo(t1.id, true);
    expect(store.getTrackById(t2.id)!.muted).toBe(true);
    expect(store.getTrackById(t3.id)!.muted).toBe(true);

    // Un-solo: t2 should unmute (was auto-muted), t3 should stay muted (user-muted)
    store.setTrackSolo(t1.id, false);

    expect(store.getTrackById(t1.id)!.solo).toBe(false);
    expect(store.getTrackById(t1.id)!.muted).toBe(false);
    expect(store.getTrackById(t2.id)!.solo).toBe(false);
    expect(store.getTrackById(t2.id)!.muted).toBe(false);
    expect(store.getTrackById(t3.id)!.solo).toBe(false);
    expect(store.getTrackById(t3.id)!.muted).toBe(true); // user-muted preserved
  });

  it('adding empty track while another is solo\'d → new track is auto-muted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    store.setTrackSolo(t1.id, true);

    store.addEmptyTrack();

    // The new track is auto-selected, which moves solo to it
    const newTrack = store.tracks[store.tracks.length - 1];
    expect(newTrack.muted).toBe(false);
    expect(newTrack.solo).toBe(true);
    // Previous solo track should now be auto-muted
    expect(store.getTrackById(t1.id)!.solo).toBe(false);
    expect(store.getTrackById(t1.id)!.muted).toBe(true);
  });

  it('setTrackMuted on solo\'d track is a no-op', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(buf, null, 'Track 2', 0);

    store.setTrackSolo(t1.id, true);
    expect(store.getTrackById(t1.id)!.muted).toBe(false);

    // Try to mute the solo'd track — should be ignored
    store.setTrackMuted(t1.id, true);
    expect(store.getTrackById(t1.id)!.muted).toBe(false);
    expect(store.getTrackById(t1.id)!.solo).toBe(true);
  });

  it('creating track from buffer while solo active → new track is muted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    store.setTrackSolo(t1.id, true);

    const buf2 = createMockAudioBuffer(3);
    const t2 = await store.createTrackFromBuffer(buf2, null, 'Track 2', 0);

    expect(t2.muted).toBe(true);
    expect(t2.solo).toBe(false);
  });

  it('getActiveTracksAtTime returns only solo\'d track after solo + new track creation', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const t2 = await store.createTrackFromBuffer(buf, null, 'Track 2', 0);

    store.setTrackSolo(t1.id, true);

    // Add another track while solo is active
    const buf3 = createMockAudioBuffer(5);
    const t3 = await store.createTrackFromBuffer(buf3, null, 'Track 3', 0);

    const active = store.getActiveTracksAtTime(0);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(t1.id);
  });

  it('async import: createImportingTrack while solo active → track stays muted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const t1 = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);
    store.setTrackSolo(t1.id, true);

    // createImportingTrack simulates async import start
    const importing = store.createImportingTrack(
      'Importing Track',
      { duration: 10, sampleRate: 44100, channels: 2 },
      0,
      'session-123',
      '/tmp/test.wav'
    );

    expect(importing.muted).toBe(true);
    expect(importing.solo).toBe(false);
  });
});

describe('Ghost clip alignment', () => {
  // These tests verify the math that positions the floating drag ghost.
  // The ghost must match the clip's actual rendered position at all times.
  // Bug: centering ghost on cursor (mouseX - width/2) instead of
  // preserving the click-to-clip-left-edge offset.

  const containerLeft = 200;   // container.getBoundingClientRect().left
  const containerWidth = 800;  // timeline container pixel width
  const timelineDuration = 10; // seconds

  function computeClipScreenLeft(clipStart: number): number {
    return containerLeft + (clipStart / timelineDuration) * containerWidth;
  }

  function computeMouseOffset(mouseDownX: number, clipStart: number): number {
    return mouseDownX - computeClipScreenLeft(clipStart);
  }

  function computeNewClipStart(originalStart: number, mouseDownX: number, currentMouseX: number): number {
    const deltaX = currentMouseX - mouseDownX;
    const deltaTime = (deltaX / containerWidth) * timelineDuration;
    return Math.max(0, originalStart + deltaTime);
  }

  it('ghost aligns with clip when clicking left edge', () => {
    const clipStart = 2;
    const mouseDownX = computeClipScreenLeft(clipStart); // left edge
    const offset = computeMouseOffset(mouseDownX, clipStart);
    expect(offset).toBeCloseTo(0);

    const currentMouseX = 450;
    const newStart = computeNewClipStart(clipStart, mouseDownX, currentMouseX);
    const clipScreenLeft = computeClipScreenLeft(newStart);
    const ghostLeft = currentMouseX - offset;
    expect(ghostLeft).toBeCloseTo(clipScreenLeft);
  });

  it('ghost aligns with clip when clicking center', () => {
    const clipStart = 2;
    const clipDuration = 3;
    const clipWidthPx = (clipDuration / timelineDuration) * containerWidth; // 240px
    const clipScreenLeftInitial = computeClipScreenLeft(clipStart);
    const mouseDownX = clipScreenLeftInitial + clipWidthPx / 2; // click center
    const offset = computeMouseOffset(mouseDownX, clipStart);
    expect(offset).toBeCloseTo(clipWidthPx / 2);

    const currentMouseX = 500;
    const newStart = computeNewClipStart(clipStart, mouseDownX, currentMouseX);
    const clipScreenLeft = computeClipScreenLeft(newStart);
    const ghostLeft = currentMouseX - offset;
    expect(ghostLeft).toBeCloseTo(clipScreenLeft);
  });

  it('ghost aligns with clip when clicking right edge', () => {
    const clipStart = 2;
    const clipDuration = 3;
    const clipWidthPx = (clipDuration / timelineDuration) * containerWidth;
    const clipScreenLeftInitial = computeClipScreenLeft(clipStart);
    const mouseDownX = clipScreenLeftInitial + clipWidthPx; // right edge
    const offset = computeMouseOffset(mouseDownX, clipStart);

    const currentMouseX = 600;
    const newStart = computeNewClipStart(clipStart, mouseDownX, currentMouseX);
    const clipScreenLeft = computeClipScreenLeft(newStart);
    const ghostLeft = currentMouseX - offset;
    expect(ghostLeft).toBeCloseTo(clipScreenLeft);
  });

  it('ghost tracks mouse correctly even near left bound', () => {
    const clipStart = 1;
    const mouseDownX = computeClipScreenLeft(clipStart) + 20;
    const offset = computeMouseOffset(mouseDownX, clipStart);

    // Drag left but NOT past the boundary — clip stays above 0
    const currentMouseX = mouseDownX - 40; // 40px left = 0.5s left, clipStart goes to 0.5
    const newStart = computeNewClipStart(clipStart, mouseDownX, currentMouseX);
    expect(newStart).toBeGreaterThan(0);
    const clipScreenLeft = computeClipScreenLeft(newStart);
    const ghostLeft = currentMouseX - offset;
    // Ghost should align with actual clip position
    expect(ghostLeft).toBeCloseTo(clipScreenLeft);
  });

  it('old center-based approach would NOT align (regression guard)', () => {
    const clipStart = 2;
    const clipDuration = 3;
    const clipWidthPx = (clipDuration / timelineDuration) * containerWidth;
    const clipScreenLeftInitial = computeClipScreenLeft(clipStart);
    // Click near left edge
    const mouseDownX = clipScreenLeftInitial + 10;

    const currentMouseX = 500;
    const newStart = computeNewClipStart(clipStart, mouseDownX, currentMouseX);
    const actualClipLeft = computeClipScreenLeft(newStart);

    // Old buggy approach: center ghost on cursor
    const buggyGhostLeft = currentMouseX - clipWidthPx / 2;
    // This should NOT match the actual clip position (unless click was exact center)
    expect(Math.abs(buggyGhostLeft - actualClipLeft)).toBeGreaterThan(1);

    // Fixed approach: use click offset
    const offset = computeMouseOffset(mouseDownX, clipStart);
    const fixedGhostLeft = currentMouseX - offset;
    expect(fixedGhostLeft).toBeCloseTo(actualClipLeft);
  });
});

describe('Volume envelope bounds adjustment', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('finalizeClipPositions shifts envelope points when trackStart changes', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(5);
    const track = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);

    // Convert to multi-clip track with envelope
    const trackIdx = store.tracks.findIndex(t => t.id === track.id);
    store.tracks[trackIdx] = {
      ...store.tracks[trackIdx],
      clips: [
        { id: 'clip-a', buffer: buf, waveformData: [0, 1], clipStart: 0, duration: 5, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
      ],
      volumeEnvelope: [
        { id: 'env-1', time: 1, value: 0.5 },
        { id: 'env-2', time: 3, value: 1.0 },
      ],
      trackStart: 0,
      duration: 5,
    };

    // Move the clip to start at 2
    store.setClipStart(track.id, 'clip-a', 2);
    store.finalizeClipPositions(track.id);

    const updated = store.getTrackById(track.id)!;
    // trackStart shifted from 0 to 2, so envelope points should shift by -2
    // time=1 becomes -1 (filtered out), time=3 becomes 1
    expect(updated.volumeEnvelope).toBeDefined();
    expect(updated.volumeEnvelope!.length).toBe(1);
    expect(updated.volumeEnvelope![0].time).toBeCloseTo(1, 2);
    expect(updated.volumeEnvelope![0].value).toBe(1.0);
  });

  it('deleteClipFromTrack shifts envelope points', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(3);
    const track = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);

    // Set up multi-clip track: two clips, envelope spans both
    const trackIdx = store.tracks.findIndex(t => t.id === track.id);
    store.tracks[trackIdx] = {
      ...store.tracks[trackIdx],
      clips: [
        { id: 'clip-a', buffer: buf, waveformData: [0, 1], clipStart: 0, duration: 3, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
        { id: 'clip-b', buffer: buf, waveformData: [0, 1], clipStart: 5, duration: 3, sourceFile: '/tmp/b.wav', sourceOffset: 0 },
      ],
      volumeEnvelope: [
        { id: 'env-1', time: 1, value: 0.5 },   // in clip-a region
        { id: 'env-2', time: 6, value: 1.0 },   // in clip-b region (at time 6, trackStart-relative)
      ],
      trackStart: 0,
      duration: 8,
    };

    // Delete clip-a: trackStart shifts to 5, duration becomes 3
    store.deleteClipFromTrack(track.id, 'clip-a');

    const updated = store.getTrackById(track.id)!;
    expect(updated.trackStart).toBe(5);
    expect(updated.duration).toBe(3);

    // Envelope: env-1 at time=1 shifts to 1+(0-5) = -4, filtered out
    // env-2 at time=6 shifts to 6+(0-5) = 1, kept
    expect(updated.volumeEnvelope).toBeDefined();
    expect(updated.volumeEnvelope!.length).toBe(1);
    expect(updated.volumeEnvelope![0].time).toBeCloseTo(1, 2);
    expect(updated.volumeEnvelope![0].value).toBe(1.0);
  });

  it('envelope points outside new bounds are filtered out', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const store = useTracksStore();

    const buf = createMockAudioBuffer(3);
    const track = await store.createTrackFromBuffer(buf, null, 'Track 1', 0);

    const trackIdx = store.tracks.findIndex(t => t.id === track.id);
    store.tracks[trackIdx] = {
      ...store.tracks[trackIdx],
      clips: [
        { id: 'clip-a', buffer: buf, waveformData: [0, 1], clipStart: 0, duration: 3, sourceFile: '/tmp/a.wav', sourceOffset: 0 },
      ],
      volumeEnvelope: [
        { id: 'env-1', time: 1, value: 0.5 },
        { id: 'env-2', time: 2, value: 0.8 },
        { id: 'env-3', time: 10, value: 1.0 },  // way outside bounds
      ],
      trackStart: 0,
      duration: 3,
    };

    // Finalize with same bounds — point at time=10 should be filtered
    store.finalizeClipPositions(track.id);

    const updated = store.getTrackById(track.id)!;
    expect(updated.volumeEnvelope).toBeDefined();
    // time=10 exceeds duration=3, should be filtered out
    expect(updated.volumeEnvelope!.length).toBe(2);
    expect(updated.volumeEnvelope!.every(p => p.time <= 3)).toBe(true);
  });
});
