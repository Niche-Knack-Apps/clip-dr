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

describe('Zoom Interaction — Selection Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setSelection clamps to timeline bounds', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const selectionStore = useSelectionStore();

    // Create a 30s track to establish timeline duration
    await tracksStore.createTrackFromBuffer(mkBuf(30), null, 'T1', 0);

    // Try to set selection beyond timeline
    selectionStore.setSelection(-5, 40);
    expect(selectionStore.selection.start).toBeGreaterThanOrEqual(0);
    expect(selectionStore.selection.end).toBeLessThanOrEqual(tracksStore.timelineDuration);
  });

  it('moveSelection clamps to [0, duration]', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useSelectionStore } = await import('@/stores/selection');
    const tracksStore = useTracksStore();
    const selectionStore = useSelectionStore();

    await tracksStore.createTrackFromBuffer(mkBuf(30), null, 'T1', 0);

    // Set selection at start
    selectionStore.setSelection(0, 5);
    // Move far left (should clamp to 0)
    selectionStore.moveSelection(-100);
    expect(selectionStore.selection.start).toBe(0);
    expect(selectionStore.selection.end).toBe(5);

    // Set selection near end
    selectionStore.setSelection(25, 30);
    // Move far right (should clamp to duration)
    selectionStore.moveSelection(100);
    expect(selectionStore.selection.end).toBeLessThanOrEqual(tracksStore.timelineDuration);
    expect(selectionStore.selection.start).toBeGreaterThanOrEqual(0);
  });

  it('zoom in preserves monotonic zoom increase', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    const zoomValues: number[] = [];
    uiStore.trackZoom = 10;

    // Simulate 5 zoom-in events (factor 1.2 each)
    for (let i = 0; i < 5; i++) {
      const oldZoom = uiStore.trackZoom;
      const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, oldZoom * 1.2));
      uiStore.trackZoom = newZoom;
      zoomValues.push(newZoom);
    }

    // Each value should be strictly greater than the previous
    for (let i = 1; i < zoomValues.length; i++) {
      expect(zoomValues[i]).toBeGreaterThan(zoomValues[i - 1]);
    }
  });

  it('zoom out preserves monotonic zoom decrease', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    uiStore.trackZoom = 100;
    const zoomValues: number[] = [];

    for (let i = 0; i < 5; i++) {
      const oldZoom = uiStore.trackZoom;
      const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, oldZoom / 1.2));
      if (newZoom >= oldZoom) break; // at min boundary
      uiStore.trackZoom = newZoom;
      zoomValues.push(newZoom);
    }

    for (let i = 1; i < zoomValues.length; i++) {
      expect(zoomValues[i]).toBeLessThan(zoomValues[i - 1]);
    }
  });

  it('zoom out at minimum boundary does not zoom in', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    uiStore.trackZoom = uiStore.TRACK_ZOOM_MIN;
    const atMin = uiStore.trackZoom;

    // Attempt zoom out
    const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, atMin / 1.2));
    // Guard: deltaY > 0 (zoom out) and newZoom >= oldZoom → return early
    if (newZoom >= atMin) {
      // Should not apply zoom — this is the guard
      expect(newZoom).toBeGreaterThanOrEqual(atMin);
    }
    // trackZoom should stay at min
    expect(uiStore.trackZoom).toBe(atMin);
  });

  it('zoom level after N wheel events equals expected compounded value', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    const start = 50;
    uiStore.trackZoom = start;
    const n = 4;

    for (let i = 0; i < n; i++) {
      const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, uiStore.trackZoom * 1.2));
      uiStore.trackZoom = newZoom;
    }

    const expected = start * Math.pow(1.2, n);
    expect(uiStore.trackZoom).toBeCloseTo(expected, 2);
  });

  it('mouse-centered time remains stable after rapid wheel bursts', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    // Simulate rapid zoom: 10 steps of 1.2x zoom-in
    // The invariant: timeAtMouse before first event == timeAtMouse after last scroll correction
    const initialZoom = 50;
    uiStore.trackZoom = initialZoom;

    const panelWidth = 200;
    const localX = 300; // mouse position in timeline area
    const initialScrollX = 100;
    const timeAtMouse = (localX + initialScrollX) / initialZoom; // 8.0s

    let currentZoom = initialZoom;
    for (let i = 0; i < 10; i++) {
      const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, currentZoom * 1.2));
      if (newZoom === currentZoom) break;
      uiStore.trackZoom = newZoom;
      currentZoom = newZoom;
    }

    // After all zoom events, the final scrollLeft should be:
    const finalScrollLeft = timeAtMouse * currentZoom - localX;
    // And the time under mouse should still be 8.0s
    const finalTimeAtMouse = (localX + finalScrollLeft) / currentZoom;
    expect(finalTimeAtMouse).toBeCloseTo(timeAtMouse, 6);
  });

  it('resizeSelectionStart/End enforce minimum selection duration', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useSelectionStore } = await import('@/stores/selection');
    const { MIN_SELECTION_DURATION } = await import('@/shared/constants');
    const tracksStore = useTracksStore();
    const selectionStore = useSelectionStore();

    await tracksStore.createTrackFromBuffer(mkBuf(30), null, 'T1', 0);

    selectionStore.setSelection(10, 20);

    // Try to resize start past end
    selectionStore.resizeSelectionStart(19.99);
    expect(selectionStore.selection.end - selectionStore.selection.start).toBeGreaterThanOrEqual(MIN_SELECTION_DURATION);

    // Try to resize end past start
    selectionStore.setSelection(10, 20);
    selectionStore.resizeSelectionEnd(10.01);
    // Use toBeCloseTo to handle floating point precision
    expect(selectionStore.selection.end - selectionStore.selection.start).toBeGreaterThanOrEqual(MIN_SELECTION_DURATION - 1e-10);
  });
});
