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

describe('Clean Audio Playback', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('createTrackFromBuffer with sourcePath sets sourcePath on track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buffer = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(
      buffer, null, 'Cleaned Track', 0, '/tmp/cleaned_output.wav'
    );

    const stored = tracksStore.tracks.find(t => t.id === track.id)!;
    expect(stored.sourcePath).toBe('/tmp/cleaned_output.wav');
  });

  it('track with sourcePath is playable', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { isTrackPlayable } = await import('@/shared/utils');
    const tracksStore = useTracksStore();

    const buffer = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(
      buffer, null, 'Cleaned Track', 0, '/tmp/cleaned_output.wav'
    );

    const stored = tracksStore.tracks.find(t => t.id === track.id)!;
    expect(isTrackPlayable(stored.importStatus)).toBe(true);
  });

  it('muteAllExcept mutes all tracks except the specified one', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);
    const track3 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 3', 0);

    tracksStore.muteAllExcept(track2.id);

    const t1 = tracksStore.tracks.find(t => t.id === track1.id)!;
    const t2 = tracksStore.tracks.find(t => t.id === track2.id)!;
    const t3 = tracksStore.tracks.find(t => t.id === track3.id)!;

    expect(t1.muted).toBe(true);
    expect(t2.muted).toBe(false);
    expect(t3.muted).toBe(true);
  });

  it('selectedTrack auto-resolves to single track when selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Only Track', 0);

    // Default selection is 'ALL'
    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).not.toBeNull();
    expect(tracksStore.selectedTrack!.id).toBe(track.id);
  });

  it('selectedTrack returns null when multiple tracks and selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).toBeNull();
  });

  it('selectedTrack returns null when no tracks and selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    tracksStore.selectedTrackId = 'ALL';
    expect(tracksStore.selectedTrack).toBeNull();
  });

  it('muteAllExcept unmutes the target track if it was muted', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const track1 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buf, null, 'Track 2', 0);

    // Pre-mute the target
    tracksStore.setTrackMuted(track2.id, true);
    expect(tracksStore.tracks.find(t => t.id === track2.id)!.muted).toBe(true);

    tracksStore.muteAllExcept(track2.id);

    // Target should now be unmuted
    expect(tracksStore.tracks.find(t => t.id === track2.id)!.muted).toBe(false);
    // Other should be muted
    expect(tracksStore.tracks.find(t => t.id === track1.id)!.muted).toBe(true);
  });
});
