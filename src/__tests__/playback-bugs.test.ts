import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

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
}

class MockAudioContext {
  readonly sampleRate = 44100;
  createBuffer(ch: number, len: number, rate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }) as unknown as AudioBuffer;
  }
}

(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

const mockInvoke = vi.mocked(invoke);

describe('Bug #1 regression: play() always syncs mute/solo state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('play() calls playback_set_muted_batch even when track hash is unchanged (unmute-after-clip scenario)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { usePlaybackStore } = await import('@/stores/playback');
    const tracksStore = useTracksStore();
    const playbackStore = usePlaybackStore();
    const ctx = new MockAudioContext();

    // Add two tracks: one will be muted (simulating clip source), one unmuted
    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Source', 0);
    tracksStore.createTrackFromBuffer(buf, null, 'Clip', 0);
    tracksStore.tracks[0].cachedAudioPath = '/tmp/source.wav';
    tracksStore.tracks[1].cachedAudioPath = '/tmp/clip.wav';

    // Mute the source track (as clipping does)
    tracksStore.setTrackMuted(tracksStore.tracks[0].id, true);

    // First play — loads tracks, syncs mute state to Rust
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 0;
      return [];
    });
    await playbackStore.play();
    playbackStore.pause();

    // Now unmute the source track (user clicks unmute after clip)
    tracksStore.setTrackMuted(tracksStore.tracks[0].id, false);

    // Clear mocks to isolate second play
    mockInvoke.mockClear();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 0;
      return [];
    });

    // Second play — track hash unchanged (same files/positions), but mute state differs
    await playbackStore.play();

    // Must have called playback_set_muted_batch to sync unmuted state
    const muteBatchCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'playback_set_muted_batch'
    );
    expect(muteBatchCalls.length).toBeGreaterThanOrEqual(1);

    // Both tracks should be unmuted in the batch
    const lastMuteCall = muteBatchCalls[muteBatchCalls.length - 1];
    const updates = (lastMuteCall[1] as Record<string, unknown>).updates as Array<{ track_id: string; muted: boolean }>;
    expect(updates.every(u => u.muted === false)).toBe(true);

    playbackStore.pause();
  });
});

describe('Bug #2 regression: seek() during playback sends hot-seek to Rust', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('seek() while playing calls playback_seek without pause/play cycle', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { usePlaybackStore } = await import('@/stores/playback');
    const tracksStore = useTracksStore();
    const playbackStore = usePlaybackStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 10, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 0;
      return [];
    });

    // Start playback
    await playbackStore.play();

    // Clear mocks to isolate the seek call
    mockInvoke.mockClear();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 5;
      return [];
    });

    // Seek while playing
    await playbackStore.seek(5.0);

    // Should have sent playback_seek directly
    const seekCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'playback_seek');
    expect(seekCalls.length).toBe(1);
    expect((seekCalls[0][1] as Record<string, unknown>).position).toBe(5.0);

    // Should NOT have called playback_pause or playback_play (no teardown)
    const pauseCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'playback_pause');
    const playCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'playback_play');
    expect(pauseCalls.length).toBe(0);
    expect(playCalls.length).toBe(0);

    // currentTime should reflect new position
    expect(playbackStore.currentTime).toBe(5.0);

    playbackStore.pause();
  });

  it('seek() while stopped does NOT call playback_seek but updates currentTime', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { usePlaybackStore } = await import('@/stores/playback');
    const tracksStore = useTracksStore();
    const playbackStore = usePlaybackStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 10, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue([] as never);

    // Seek while stopped
    await playbackStore.seek(3.0);

    // Should NOT have called playback_seek (no active engine)
    const seekCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'playback_seek');
    expect(seekCalls.length).toBe(0);

    // currentTime should still update
    expect(playbackStore.currentTime).toBe(3.0);
  });
});
