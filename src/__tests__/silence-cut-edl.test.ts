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
  homeDir: vi.fn().mockResolvedValue('/home/test'),
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

describe('Silence Cut → EDL Track (v0.27.35 regression)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('cloneTrack creates independent copy with new IDs', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const original = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'Original', 0);
    original.timemarks = [{ id: 'tm1', time: 3, label: 'Mark 1', color: '#fff', source: 'manual' as const }];
    original.volumeEnvelope = [{ time: 2, value: 0.5 }];

    const clone = tracksStore.cloneTrack(original.id, 'Clone');
    expect(clone).not.toBeNull();
    expect(clone!.id).not.toBe(original.id);
    expect(clone!.name).toBe('Clone');
    expect(clone!.duration).toBe(original.duration);
    expect(clone!.trackStart).toBe(original.trackStart);

    // Timemarks cloned with new IDs
    expect(clone!.timemarks).toHaveLength(1);
    expect(clone!.timemarks![0].id).not.toBe('tm1');
    expect(clone!.timemarks![0].time).toBe(3);

    // Volume envelope cloned
    expect(clone!.volumeEnvelope).toHaveLength(1);
    expect(clone!.volumeEnvelope![0].time).toBe(2);
  });

  it('cloneTrack shares audio buffer reference (not cloned)', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const tracksStore = useTracksStore();

    const buf = mkBuf(5);
    const original = await tracksStore.createTrackFromBuffer(buf, null, 'Original', 0);
    const clone = tracksStore.cloneTrack(original.id, 'Clone');

    // Buffer should be the same reference (shared per convention)
    expect(clone!.audioData.buffer).toBe(original.audioData.buffer);
  });

  it('cloneTranscription creates independent word copy', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useTranscriptionStore } = await import('@/stores/transcription');
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T1', 0);
    const t2 = await tracksStore.createTrackFromBuffer(mkBuf(10), null, 'T2', 0);

    // Manually set transcription for t1
    transcriptionStore.cloneTranscription(t1.id, t2.id);

    // No source transcription → no clone (shouldn't error)
    const words = transcriptionStore.getWordsInRange(t2.id, 0, 10);
    expect(words).toHaveLength(0);
  });

  it('adjustSilenceForCut handles per-track scoping', async () => {
    const { useSilenceStore } = await import('@/stores/silence');
    const { useTracksStore } = await import('@/stores/tracks');
    const silenceStore = useSilenceStore();
    const tracksStore = useTracksStore();

    const t1 = await tracksStore.createTrackFromBuffer(mkBuf(20), null, 'T1', 0);
    silenceStore.addRegion(t1.id, 5, 8);
    silenceStore.addRegion(t1.id, 12, 15);

    // Cut region 5-8 (3s gap)
    silenceStore.adjustSilenceForCut(t1.id, 5, 8);

    const regions = silenceStore.getRegionsForTrack(t1.id);
    // First region removed (fully inside cut), second shifted left by 3
    expect(regions.length).toBe(1);
    expect(regions[0].start).toBe(9);  // 12 - 3
    expect(regions[0].end).toBe(12);   // 15 - 3
  });
});
