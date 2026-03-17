import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { computed } from 'vue';

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

/**
 * Replicate the selectedTrackId computed logic from WordTimeline.vue
 * so we can unit-test the auto-resolve behavior without mounting the component.
 */
function createSelectedTrackId(
  tracksStore: { selectedTrackId: string | null; tracks: Array<{ id: string }> },
  transcriptionStore: { hasTranscriptionForTrack: (id: string) => boolean }
) {
  return computed(() => {
    const sel = tracksStore.selectedTrackId;
    if (sel && sel !== 'ALL') return sel;
    const transcribed = tracksStore.tracks.filter(
      t => transcriptionStore.hasTranscriptionForTrack(t.id)
    );
    if (transcribed.length === 1) return transcribed[0].id;
    return null;
  });
}

/** Add a mock transcription entry to the store's internal Map */
function addMockTranscription(transcriptionStore: ReturnType<typeof import('@/stores/transcription').useTranscriptionStore>, trackId: string) {
  transcriptionStore.transcriptions.set(trackId, {
    trackId,
    words: [{ id: 'w1', text: 'hello', start: 0, end: 0.5, confidence: 1.0 }],
    fullText: 'hello',
    language: 'en',
    processedAt: Date.now(),
    wordOffsets: new Map(),
    enableFalloff: true,
  });
}

describe('Transcription Slider — selectedTrackId auto-resolve', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('resolves to the single transcribed track when selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();

    const buffer = createMockAudioBuffer(5);
    const track1 = await tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
    await tracksStore.createTrackFromBuffer(buffer, null, 'Track 2', 0);

    // Add transcription only to track1
    addMockTranscription(transcriptionStore, track1.id);

    // Selection is 'ALL' (default)
    tracksStore.selectedTrackId = 'ALL';

    const selectedTrackId = createSelectedTrackId(tracksStore, transcriptionStore);
    expect(selectedTrackId.value).toBe(track1.id);
  });

  it('returns null when multiple tracks have transcriptions and selection is ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();

    const buffer = createMockAudioBuffer(5);
    const track1 = await tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buffer, null, 'Track 2', 0);

    addMockTranscription(transcriptionStore, track1.id);
    addMockTranscription(transcriptionStore, track2.id);

    tracksStore.selectedTrackId = 'ALL';

    const selectedTrackId = createSelectedTrackId(tracksStore, transcriptionStore);
    expect(selectedTrackId.value).toBeNull();
  });

  it('uses explicit track selection when not ALL', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();

    const buffer = createMockAudioBuffer(5);
    const track1 = await tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);
    const track2 = await tracksStore.createTrackFromBuffer(buffer, null, 'Track 2', 0);

    addMockTranscription(transcriptionStore, track1.id);
    addMockTranscription(transcriptionStore, track2.id);

    tracksStore.selectedTrackId = track2.id;

    const selectedTrackId = createSelectedTrackId(tracksStore, transcriptionStore);
    expect(selectedTrackId.value).toBe(track2.id);
  });

  it('returns null when no tracks have transcriptions', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();

    const buffer = createMockAudioBuffer(5);
    await tracksStore.createTrackFromBuffer(buffer, null, 'Track 1', 0);

    tracksStore.selectedTrackId = 'ALL';

    const selectedTrackId = createSelectedTrackId(tracksStore, transcriptionStore);
    expect(selectedTrackId.value).toBeNull();
  });
});
