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

describe('CON-H4: Export re-entrancy guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('exportWithProfile blocks when export already in progress', async () => {
    const { useExportStore } = await import('@/stores/export');
    const exportStore = useExportStore();

    // Simulate loading state (export in progress)
    exportStore.loading = true;

    const result = await exportStore.exportWithProfile({
      id: 'test',
      name: 'Test',
      format: 'wav',
      mp3Bitrate: 192,
    });

    expect(result).toBeNull();
    exportStore.loading = false;
  });

  it('exportTrackWithProfile blocks when export already in progress', async () => {
    const { useExportStore } = await import('@/stores/export');
    const { useTracksStore } = await import('@/stores/tracks');
    const exportStore = useExportStore();
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    exportStore.loading = true;

    const result = await exportStore.exportTrackWithProfile(
      tracksStore.tracks[0],
      { id: 'test', name: 'Test', format: 'wav', mp3Bitrate: 192 }
    );

    expect(result).toBeNull();
    exportStore.loading = false;
  });

  it('exportWithSilenceRemoval blocks when export already in progress', async () => {
    const { useExportStore } = await import('@/stores/export');
    const exportStore = useExportStore();

    exportStore.loading = true;

    const result = await exportStore.exportWithSilenceRemoval('wav');

    expect(result).toBeNull();
    exportStore.loading = false;
  });
});

describe('CON-H3: Transcription job cancellation on track delete', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('cancelJobsForTrack removes queued jobs for the given track', async () => {
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const transcriptionStore = useTranscriptionStore();

    // Manually add some jobs to the queue
    transcriptionStore.jobQueue = [
      { id: 'j1', trackId: 'track-A', priority: 'normal', status: 'queued', progress: 0 },
      { id: 'j2', trackId: 'track-B', priority: 'normal', status: 'queued', progress: 0 },
      { id: 'j3', trackId: 'track-A', priority: 'high', status: 'running', progress: 50 },
    ];

    transcriptionStore.cancelJobsForTrack('track-A');

    // Should remove queued job for track-A but NOT the running one
    expect(transcriptionStore.jobQueue.length).toBe(2);
    expect(transcriptionStore.jobQueue.find(j => j.id === 'j1')).toBeUndefined();
    expect(transcriptionStore.jobQueue.find(j => j.id === 'j2')).toBeDefined();
    expect(transcriptionStore.jobQueue.find(j => j.id === 'j3')).toBeDefined(); // running, kept
  });

  it('deleteTrack calls cancelJobsForTrack', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    // Add a queued job for this track
    transcriptionStore.jobQueue = [
      { id: 'j1', trackId: track.id, priority: 'normal', status: 'queued', progress: 0 },
    ];

    tracksStore.deleteTrack(track.id);

    // Job should have been cancelled
    expect(transcriptionStore.jobQueue.length).toBe(0);
    // Track should be gone
    expect(tracksStore.tracks.length).toBe(0);
  });
});

describe('CON-M2: Seek suppresses poll overwrites', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('seek() sets currentTime immediately, even during playback', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { usePlaybackStore } = await import('@/stores/playback');
    const tracksStore = useTracksStore();
    const playbackStore = usePlaybackStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 10, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 0;
      return [];
    });

    await playbackStore.play();

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'playback_get_position') return 0; // poll would return old position
      return [];
    });

    await playbackStore.seek(7.5);

    // currentTime should be 7.5, not reverted by a poll cycle
    expect(playbackStore.currentTime).toBe(7.5);

    playbackStore.pause();
  });
});

describe('CON-M6: Cleaning concurrent guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it('cleanSelectedTrack blocks when cleaning already in progress', async () => {
    const { useCleaningStore } = await import('@/stores/cleaning');
    const { useTracksStore } = await import('@/stores/tracks');
    const cleaningStore = useCleaningStore();
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    await tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    tracksStore.selectTrack(tracksStore.tracks[0].id);

    // Simulate cleaning in progress
    cleaningStore.loading = true;

    const result = await cleaningStore.cleanSelectedTrack();
    expect(result).toBeNull();

    cleaningStore.loading = false;
  });
});
