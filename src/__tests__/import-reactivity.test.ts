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

/**
 * Regression tests for import status reactivity.
 *
 * With shallowRef, import status transitions must create new array references
 * so that watchers (e.g. EditorView's import progress modal) detect the change.
 * Previously these used triggerRef() which doesn't propagate through computed()
 * wrappers in Pinia stores.
 */
describe('Import status reactivity: new array identity on transitions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setImportCaching creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    // Create a track in importing state
    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    // Transition to large-file first
    tracksStore.setImportLargeFile(trackId);
    const refBeforeCaching = tracksStore.tracks;

    // Transition to caching — must produce new array reference
    tracksStore.setImportCaching(trackId);

    expect(tracksStore.tracks).not.toBe(refBeforeCaching);
    expect(tracksStore.tracks[0].importStatus).toBe('caching');
  });

  it('setImportLargeFile creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;
    const refBefore = tracksStore.tracks;

    tracksStore.setImportLargeFile(trackId);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].importStatus).toBe('large-file');
  });

  it('setImportBuffer creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    // Set to caching first (realistic flow)
    tracksStore.setImportLargeFile(trackId);
    tracksStore.setImportCaching(trackId);
    const refBefore = tracksStore.tracks;

    // setImportBuffer completes the import
    const newBuf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.setImportBuffer(trackId, newBuf as unknown as AudioBuffer);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].importStatus).toBe('ready');
  });

  it('setCachedAudioPath creates new array ref but does NOT change importStatus', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.setImportLargeFile(trackId);
    tracksStore.setImportCaching(trackId);
    const refBefore = tracksStore.tracks;

    tracksStore.setCachedAudioPath(trackId, '/tmp/cached.wav');

    expect(tracksStore.tracks).not.toBe(refBefore);
    // importStatus stays 'caching' — only setImportReady transitions to 'ready'
    expect(tracksStore.tracks[0].importStatus).toBe('caching');
    expect(tracksStore.tracks[0].cachedAudioPath).toBe('/tmp/cached.wav');
  });

  it('setImportReady transitions status to ready', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    tracksStore.setImportCaching(trackId);
    const refBefore = tracksStore.tracks;

    tracksStore.setImportReady(trackId);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].importStatus).toBe('ready');
    expect(tracksStore.tracks[0].importDecodeProgress).toBeUndefined();
  });

  it('finalizeImportWaveform creates a new tracks array reference', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;
    const refBefore = tracksStore.tracks;

    const waveform = Array(200).fill(0);
    tracksStore.finalizeImportWaveform(trackId, waveform, 5.0);

    expect(tracksStore.tracks).not.toBe(refBefore);
    expect(tracksStore.tracks[0].audioData.waveformData).toBe(waveform);
  });

  it('full large-file import lifecycle produces new reference at each step', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'LargeFile', 0);
    const trackId = tracksStore.tracks[0].id;

    // Collect array references at each transition
    const refs: unknown[] = [tracksStore.tracks];

    tracksStore.setImportLargeFile(trackId);
    refs.push(tracksStore.tracks);

    tracksStore.setImportCaching(trackId);
    refs.push(tracksStore.tracks);

    tracksStore.setCachedAudioPath(trackId, '/tmp/cached.wav');
    refs.push(tracksStore.tracks);

    // Status stays 'caching' until explicit setImportReady
    expect(tracksStore.tracks[0].importStatus).toBe('caching');

    tracksStore.setImportReady(trackId);
    refs.push(tracksStore.tracks);

    // Every transition must produce a unique array reference
    for (let i = 1; i < refs.length; i++) {
      expect(refs[i]).not.toBe(refs[i - 1]);
    }

    // Final state
    expect(tracksStore.tracks[0].importStatus).toBe('ready');
    expect(tracksStore.tracks[0].cachedAudioPath).toBe('/tmp/cached.wav');
  });

  it('track object identity changes on each import status transition', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();
    const ctx = new MockAudioContext();

    const buf = ctx.createBuffer(1, 44100 * 5, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Test', 0);
    const trackId = tracksStore.tracks[0].id;

    const trackBefore = tracksStore.tracks[0];
    tracksStore.setImportCaching(trackId);
    const trackAfter = tracksStore.tracks[0];

    // Track object itself must be a new object (spread)
    expect(trackAfter).not.toBe(trackBefore);
    // But ID is preserved
    expect(trackAfter.id).toBe(trackBefore.id);
  });
});
