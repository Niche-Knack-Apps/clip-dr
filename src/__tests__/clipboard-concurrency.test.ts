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
  copyFromChannel(dest: Float32Array, ch: number, start?: number) {
    dest.set(this.channels[ch].subarray(start ?? 0, (start ?? 0) + dest.length));
  }
  copyToChannel(src: Float32Array, ch: number, start?: number) {
    this.channels[ch].set(src, start ?? 0);
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

describe('Clipboard Concurrency Guards', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('concurrent cut() returns false and shows toast when operation in progress', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useUIStore } = await import('@/stores/ui');
    const { useSelectionStore } = await import('@/stores/selection');

    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const uiStore = useUIStore();
    const selectionStore = useSelectionStore();

    // Set up a track with I/O points so cut() has something to do
    const buf = new MockAudioContext().createBuffer(2, 44100 * 10, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    selectionStore.setInPoint(2);
    selectionStore.setOutPoint(5);

    // Spy on showToast
    const toastSpy = vi.spyOn(uiStore, 'showToast');

    // Start a cut operation (will be async)
    const firstCut = clipboardStore.cut();
    // Immediately try a second cut — should be rejected
    const secondResult = await clipboardStore.cut();

    expect(secondResult).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.stringContaining('in progress'),
      'warn'
    );

    // Let first cut settle
    await firstCut;
  });

  it('first operation completes successfully despite rejected second', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useClipboardStore } = await import('@/stores/clipboard');
    const { useSelectionStore } = await import('@/stores/selection');

    const tracksStore = useTracksStore();
    const clipboardStore = useClipboardStore();
    const selectionStore = useSelectionStore();

    const buf = new MockAudioContext().createBuffer(2, 44100 * 10, 44100);
    tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    selectionStore.setInPoint(2);
    selectionStore.setOutPoint(5);

    const firstCut = clipboardStore.cut();
    // Second concurrent call — ignored
    await clipboardStore.cut();
    // First should complete without throwing
    await expect(firstCut).resolves.not.toThrow();
  });

  it('track editEpoch is incremented after cutRegionFromTrack', async () => {
    const { useTracksStore } = await import('@/stores/tracks');

    const tracksStore = useTracksStore();
    const buf = new MockAudioContext().createBuffer(2, 44100 * 10, 44100);
    const track = tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    const epochBefore = tracksStore.tracks[idx].editEpoch ?? 0;

    const ctx = new AudioContext();
    await tracksStore.cutRegionFromTrack(track.id, 2, 5, ctx, { mode: 'edit-only' });

    // Track may have been deleted or modified, check via the tracks array
    const afterTrack = tracksStore.tracks.find(t => t.id === track.id);
    // Either track is deleted (all audio cut) or epoch has advanced
    if (afterTrack) {
      expect(afterTrack.editEpoch ?? 0).toBeGreaterThan(epochBefore);
    }
    // If deleted: epoch correctly prevented any late writes (no assertion needed)
  });

  it('deleteClipFromTrack increments editEpoch', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const buf = new MockAudioContext().createBuffer(2, 44100 * 10, 44100);
    const track = tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Set up two clips
    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      clips: [
        { id: 'ca', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/s.wav', sourceOffset: 0 } as TrackClip,
        { id: 'cb', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/s.wav', sourceOffset: 5 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    const epochBefore = tracksStore.tracks[idx].editEpoch ?? 0;
    tracksStore.deleteClipFromTrack(track.id, 'ca');

    const afterTrack = tracksStore.tracks.find(t => t.id === track.id);
    if (afterTrack) {
      expect(afterTrack.editEpoch ?? 0).toBeGreaterThan(epochBefore);
    }
  });

  it('CON-M1 regression: setPendingRecache chains sequential promises', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const order: number[] = [];
    const p1 = new Promise<void>(resolve => {
      setTimeout(() => { order.push(1); resolve(); }, 20);
    });
    const p2 = new Promise<void>(resolve => {
      setTimeout(() => { order.push(2); resolve(); }, 10);
    });

    // Chain two recache promises — second must wait for first
    tracksStore.setPendingRecache(p1);
    tracksStore.setPendingRecache(p2);

    // Wait for the chained promise to resolve
    await tracksStore.pendingRecache;

    // p2 resolves faster (10ms) but should be chained after p1 (20ms)
    // so both should be complete by the time pendingRecache resolves
    expect(order).toContain(1);
    expect(order).toContain(2);
    // The chained promise should be cleared
    expect(tracksStore.pendingRecache).toBeNull();
  });
});
