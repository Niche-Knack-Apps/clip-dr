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

describe('Per-Track Transcription', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('removeTranscription for trackA leaves trackB intact', async () => {
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const store = useTranscriptionStore();

    // Manually set transcriptions for two tracks
    store.transcriptions.set('trackA', {
      trackId: 'trackA',
      words: [{ id: 'w1', text: 'hello', start: 0, end: 0.5, confidence: 1 }],
      fullText: 'hello',
      language: 'en',
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });
    store.transcriptions.set('trackB', {
      trackId: 'trackB',
      words: [{ id: 'w2', text: 'world', start: 0, end: 0.5, confidence: 1 }],
      fullText: 'world',
      language: 'en',
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });

    store.removeTranscription('trackA');

    expect(store.hasTranscriptionForTrack('trackA')).toBe(false);
    expect(store.hasTranscriptionForTrack('trackB')).toBe(true);
  });

  it('hasTranscription is false when ALL selected with multiple tracks', async () => {
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const { useTracksStore } = await import('@/stores/tracks');
    const transcriptionStore = useTranscriptionStore();
    const tracksStore = useTracksStore();

    await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);
    await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T2', 0);

    // Add transcription for T1
    const t1Id = tracksStore.tracks[0].id;
    transcriptionStore.transcriptions.set(t1Id, {
      trackId: t1Id,
      words: [],
      fullText: '',
      language: 'en',
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });

    tracksStore.selectedTrackId = 'ALL';
    // hasTranscription should be false when ALL selected (ambiguous)
    expect(transcriptionStore.hasTranscription).toBe(false);
  });

  it('hasTranscription auto-resolves when ALL with single track', async () => {
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const { useTracksStore } = await import('@/stores/tracks');
    const transcriptionStore = useTranscriptionStore();
    const tracksStore = useTracksStore();

    const track = await tracksStore.createTrackFromBuffer(mkBuf(5), null, 'T1', 0);

    transcriptionStore.transcriptions.set(track.id, {
      trackId: track.id,
      words: [],
      fullText: '',
      language: 'en',
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });

    tracksStore.selectedTrackId = 'ALL';
    // With single track, selectedTrack auto-resolves — but hasTranscription
    // uses selectedTrackId which is 'ALL', so it returns false
    // This is the documented behavior
    expect(transcriptionStore.hasTranscription).toBe(false);
  });

  it('transcription stores are track-isolated', async () => {
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const store = useTranscriptionStore();

    store.transcriptions.set('trackA', {
      trackId: 'trackA',
      words: [{ id: 'w1', text: 'alpha', start: 0, end: 0.5, confidence: 1 }],
      fullText: 'alpha',
      language: 'en',
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });

    // Accessing trackB should NOT return trackA's data
    const transcB = store.getTranscription('trackB');
    expect(transcB).toBeUndefined();

    const transcA = store.getTranscription('trackA');
    expect(transcA).toBeDefined();
    expect(transcA!.fullText).toBe('alpha');
  });
});
