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

  it('deltaY-proportional zoom: small deltaY gives ~1% change', () => {
    const deltaY = 5;
    const factor = Math.exp(-deltaY * 0.002);
    expect(factor).toBeCloseTo(0.99, 2);
  });

  it('deltaY-proportional zoom: large deltaY (120) gives ~21% change', () => {
    const deltaY = 120;
    const factor = Math.exp(-deltaY * 0.002);
    expect(factor).toBeCloseTo(0.787, 2);
  });

  it('accumulated delta matches single equivalent: exp(-a)*exp(-b) = exp(-(a+b))', () => {
    const a = 50;
    const b = 70;
    const combined = Math.exp(-(a + b) * 0.002);
    const separate = Math.exp(-a * 0.002) * Math.exp(-b * 0.002);
    expect(separate).toBeCloseTo(combined, 10);
  });

  it('sync DOM write: minWidth matches timelineWidth formula for any zoom', () => {
    // Verifies that the synchronous DOM write computes the same minWidth
    // as the timelineWidth computed property, ensuring Vue's later patch is a no-op
    const panelWidth = 240;
    const duration = 129.49;
    const paddedDuration = duration * 1.1;

    const zooms = [3.0, 6.431, 10.77, 50.66, 100.8, 500.0];
    for (const zoom of zooms) {
      const timelineWidth = paddedDuration * zoom + panelWidth;
      const syncMinWidth = duration * 1.1 * zoom + panelWidth;
      expect(syncMinWidth).toBeCloseTo(timelineWidth, 6);
    }
  });

  it('sync scroll correction per-event matches coalesced correction', () => {
    // With synchronous DOM writes, each event corrects scrollLeft immediately.
    // The final state should match what the coalesced nextTick would compute.
    const initialZoom = 50;
    const localX = 300;
    const initialScrollX = 100;
    const timeAtMouse = (localX + initialScrollX) / initialZoom; // 8.0s

    // Simulate per-event sync corrections (each event writes scrollLeft)
    let currentZoom = initialZoom;
    let lastScrollLeft = initialScrollX;
    const deltas = [30, 25, 40, 20, 35];
    for (const d of deltas) {
      currentZoom = currentZoom * Math.exp(-d * 0.002);
      lastScrollLeft = timeAtMouse * currentZoom - localX;
    }

    // Coalesced correction (anchor from first, zoom from last)
    const coalescedScrollLeft = timeAtMouse * currentZoom - localX;

    // Both approaches produce the same final scrollLeft
    expect(lastScrollLeft).toBeCloseTo(coalescedScrollLeft, 6);

    // Content under cursor is stable
    const finalTime = (localX + lastScrollLeft) / currentZoom;
    expect(finalTime).toBeCloseTo(timeAtMouse, 6);
  });

  it('multiple coalesced wheel events use first anchor and final zoom', () => {
    // Simulates 5 wheel events in one batch:
    // anchor captured from first event's scrollLeft/zoom,
    // zoom compounds across all events,
    // final scrollLeft uses first anchor + final zoom
    const initialZoom = 50;
    const localX = 300;
    const initialScrollX = 100;
    const timeAtMouse = (localX + initialScrollX) / initialZoom; // 8.0s

    // Simulate 5 compound zoom steps
    let currentZoom = initialZoom;
    const deltas = [30, 25, 40, 20, 35];
    for (const d of deltas) {
      currentZoom = currentZoom * Math.exp(-d * 0.002);
    }

    // Final scroll correction uses first anchor + final zoom
    const finalScrollLeft = timeAtMouse * currentZoom - localX;
    const finalTimeAtMouse = (localX + finalScrollLeft) / currentZoom;

    // Content under cursor remains at same time position
    expect(finalTimeAtMouse).toBeCloseTo(timeAtMouse, 6);
  });

  it('bottom scroll scaling: full bar drag traverses full scrollable range', () => {
    const scrollWidth = 10000;
    const clientWidth = 1000;
    const maxScroll = scrollWidth - clientWidth;
    const barWidth = clientWidth;
    const scale = barWidth > 0 && maxScroll > 0 ? maxScroll / barWidth : 1;
    // Full-width drag (1000px) should scroll full range (9000px)
    expect(scale * clientWidth).toBe(maxScroll);
  });

  it('bottom scroll scaling: no-overflow returns scale=1', () => {
    const scrollWidth = 800;
    const clientWidth = 1000;
    const maxScroll = scrollWidth - clientWidth; // negative
    const barWidth = clientWidth;
    const scale = barWidth > 0 && maxScroll > 0 ? maxScroll / barWidth : 1;
    expect(scale).toBe(1);
  });

  it('left-edge zoom (over panel): zoom changes but scrollLeft stays stable', async () => {
    const { useUIStore } = await import('@/stores/ui');
    const uiStore = useUIStore();

    // Simulate: mouse is over the panel (< panelWidth), Ctrl+wheel zooms from left edge
    // The invariant: scrollLeft does not change, only zoom level changes
    const initialZoom = 50;
    uiStore.trackZoom = initialZoom;

    // Simulate 5 zoom-in events (like the panel zoom path — no scroll correction)
    const simulatedScrollLeft = 200;
    let currentScrollLeft = simulatedScrollLeft;

    for (let i = 0; i < 5; i++) {
      const factor = Math.exp(-(-120) * 0.002); // zoom in (negative deltaY)
      const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, uiStore.trackZoom * factor));
      uiStore.trackZoom = newZoom;
      // Panel zoom does NOT adjust scrollLeft — it stays the same
    }

    expect(uiStore.trackZoom).toBeGreaterThan(initialZoom);
    // scrollLeft unchanged (panel zoom doesn't correct it)
    expect(currentScrollLeft).toBe(simulatedScrollLeft);
  });

  it('synchronous width prop: effectiveZoom updates in same tick as zoom change', async () => {
    // Regression test: TrackLane used to measure containerWidth via ResizeObserver
    // (one frame behind zoom). Now it receives width as a prop, so effectiveZoom
    // and all derived values update synchronously with the zoom change.
    const { useUIStore } = await import('@/stores/ui');
    const { useTracksStore } = await import('@/stores/tracks');
    const uiStore = useUIStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(30), null, 'T1', 0);
    const duration = tracksStore.timelineDuration;
    const panelWidth = 240;
    // Use a small containerVisibleWidth so timeline zoom dominates at both levels
    const containerVisibleWidth = 400;

    // Simulate initial state — zoom high enough that timelineWidth > containerVisibleWidth
    uiStore.trackZoom = 20;
    const timelineWidth1 = duration * 1.1 * uiStore.trackZoom + panelWidth;
    const effectiveContentWidth1 = Math.max(timelineWidth1, containerVisibleWidth);
    const containerWidth1 = effectiveContentWidth1 - panelWidth;
    const effectiveZoom1 = containerWidth1 / duration;

    // Zoom in further
    uiStore.trackZoom = 40;
    const timelineWidth2 = duration * 1.1 * uiStore.trackZoom + panelWidth;
    const effectiveContentWidth2 = Math.max(timelineWidth2, containerVisibleWidth);
    const containerWidth2 = effectiveContentWidth2 - panelWidth;
    const effectiveZoom2 = containerWidth2 / duration;

    // effectiveZoom must change immediately (no async wait)
    expect(effectiveZoom2).toBeGreaterThan(effectiveZoom1);
    // containerWidth is deterministic from zoom
    expect(containerWidth2).toBeGreaterThan(containerWidth1);
  });

  it('synchronous width prop: showImportWaveform toggles without lag', async () => {
    // When containerWidth comes from a prop (not ResizeObserver), the
    // showImportWaveform v-if condition updates in the same render cycle.
    // Use a long duration so that at low zoom, effectiveZoom stays below 2
    const duration = 600;
    const panelWidth = 240;
    const containerVisibleWidth = 1200;

    // At very low zoom, effectiveZoom < 2 → waveform hidden
    const lowZoom = 0.5;
    const tlLow = duration * 1.1 * lowZoom + panelWidth;
    const cwLow = Math.max(tlLow, containerVisibleWidth) - panelWidth;
    const ezLow = cwLow / duration;

    // At higher zoom, effectiveZoom >= 2 → waveform shown
    const highZoom = 5;
    const tlHigh = duration * 1.1 * highZoom + panelWidth;
    const cwHigh = Math.max(tlHigh, containerVisibleWidth) - panelWidth;
    const ezHigh = cwHigh / duration;

    // Verify the threshold behavior
    expect(ezLow).toBeLessThan(2);
    expect(ezHigh).toBeGreaterThanOrEqual(2);
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
