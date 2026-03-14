import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri internals (required because fs-utils imports tauri)
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  once: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { Temp: 'Temp' },
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn().mockResolvedValue('/tmp/test'),
  tempDir: vi.fn().mockResolvedValue('/tmp/'),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({ setTitle: vi.fn().mockResolvedValue(undefined) }),
}));

describe('getTrackSourcePath / getClipSourcePath', () => {
  it('getTrackSourcePath returns cachedAudioPath over sourcePath', async () => {
    const { getTrackSourcePath } = await import('@/shared/utils');
    const track = { cachedAudioPath: '/cache/x.wav', sourcePath: '/source/x.wav' };
    expect(getTrackSourcePath(track)).toBe('/cache/x.wav');
  });

  it('getTrackSourcePath returns sourcePath when no cachedAudioPath', async () => {
    const { getTrackSourcePath } = await import('@/shared/utils');
    const track = { cachedAudioPath: undefined, sourcePath: '/source/x.wav' };
    expect(getTrackSourcePath(track)).toBe('/source/x.wav');
  });

  it('getTrackSourcePath returns undefined when neither available', async () => {
    const { getTrackSourcePath } = await import('@/shared/utils');
    expect(getTrackSourcePath({ cachedAudioPath: undefined, sourcePath: undefined })).toBeUndefined();
  });

  it('getClipSourcePath returns sourceFile over cachedAudioPath', async () => {
    const { getClipSourcePath } = await import('@/shared/utils');
    const clip = { sourceFile: '/clip/c.wav' };
    const track = { cachedAudioPath: '/cache/x.wav', sourcePath: '/source/x.wav' };
    expect(getClipSourcePath(clip, track)).toBe('/clip/c.wav');
  });

  it('getClipSourcePath falls back to cachedAudioPath when no sourceFile', async () => {
    const { getClipSourcePath } = await import('@/shared/utils');
    const clip = { sourceFile: undefined };
    const track = { cachedAudioPath: '/cache/x.wav', sourcePath: '/source/x.wav' };
    expect(getClipSourcePath(clip, track)).toBe('/cache/x.wav');
  });
});

describe('isTrackPlayable', () => {
  it('returns true for ready, large-file, caching statuses', async () => {
    const { isTrackPlayable } = await import('@/shared/utils');
    expect(isTrackPlayable('ready')).toBe(true);
    expect(isTrackPlayable('large-file')).toBe(true);
    expect(isTrackPlayable('caching')).toBe(true);
    expect(isTrackPlayable(undefined)).toBe(true);
  });

  it('returns false for importing, error statuses', async () => {
    const { isTrackPlayable } = await import('@/shared/utils');
    expect(isTrackPlayable('importing')).toBe(false);
    expect(isTrackPlayable('error')).toBe(false);
  });
});

describe('writeTempFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns absolute path with correct file name', async () => {
    const { writeTempFile } = await import('@/shared/fs-utils');
    const path = await writeTempFile('test.wav', new Uint8Array([1, 2, 3]));
    expect(path).toBe('/tmp/test.wav');
  });

  it('handles tempDir with trailing slash correctly', async () => {
    const { tempDir } = await import('@tauri-apps/api/path');
    vi.mocked(tempDir).mockResolvedValueOnce('/tmp/');
    const { writeTempFile } = await import('@/shared/fs-utils');
    const path = await writeTempFile('a.wav', new Uint8Array());
    expect(path).toBe('/tmp/a.wav');
  });

  it('handles tempDir without trailing slash correctly', async () => {
    const { tempDir } = await import('@tauri-apps/api/path');
    vi.mocked(tempDir).mockResolvedValueOnce('/tmp');
    const { writeTempFile } = await import('@/shared/fs-utils');
    const path = await writeTempFile('b.wav', new Uint8Array());
    expect(path).toBe('/tmp/b.wav');
  });
});

// Mock AudioBuffer for encodeWavFloat32 tests
class MockAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private channels: Float32Array[];
  constructor(ch: number, len: number, rate: number) {
    this.numberOfChannels = ch;
    this.length = len;
    this.sampleRate = rate;
    this.duration = len / rate;
    this.channels = [];
    for (let i = 0; i < ch; i++) this.channels.push(new Float32Array(len));
  }
  getChannelData(ch: number): Float32Array { return this.channels[ch]; }
}
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

describe('PERF-09: encodeWavFloat32 typed array optimization', () => {
  it('produces valid WAV header and round-trips float samples (mono)', async () => {
    const { encodeWavFloat32 } = await import('@/shared/audio-utils');
    const buf = new MockAudioBuffer(1, 100, 44100) as unknown as AudioBuffer;
    // Write a known pattern
    const ch0 = buf.getChannelData(0);
    for (let i = 0; i < 100; i++) ch0[i] = (i - 50) / 50;

    const wav = encodeWavFloat32(buf);
    // Check RIFF header
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe('RIFF');
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe('WAVE');
    // Check fmt chunk: audioFormat = 3 (IEEE float)
    const dv = new DataView(wav.buffer);
    expect(dv.getUint16(20, true)).toBe(3);
    expect(dv.getUint16(22, true)).toBe(1); // 1 channel
    expect(dv.getUint32(24, true)).toBe(44100);
    // Verify data: read back float samples
    const dataFloat = new Float32Array(wav.buffer, 44);
    expect(dataFloat.length).toBe(100);
    expect(dataFloat[0]).toBeCloseTo(-1.0, 5);
    expect(dataFloat[50]).toBeCloseTo(0.0, 5);
    expect(dataFloat[99]).toBeCloseTo(0.98, 1);
  });

  it('produces correct interleaved stereo output', async () => {
    const { encodeWavFloat32 } = await import('@/shared/audio-utils');
    const buf = new MockAudioBuffer(2, 4, 44100) as unknown as AudioBuffer;
    buf.getChannelData(0).set([0.1, 0.2, 0.3, 0.4]);
    buf.getChannelData(1).set([0.5, 0.6, 0.7, 0.8]);

    const wav = encodeWavFloat32(buf);
    const dv = new DataView(wav.buffer);
    expect(dv.getUint16(22, true)).toBe(2); // 2 channels
    // Data should be interleaved: L0, R0, L1, R1, ...
    const dataFloat = new Float32Array(wav.buffer, 44);
    expect(dataFloat.length).toBe(8); // 4 samples * 2 channels
    expect(dataFloat[0]).toBeCloseTo(0.1); // L0
    expect(dataFloat[1]).toBeCloseTo(0.5); // R0
    expect(dataFloat[2]).toBeCloseTo(0.2); // L1
    expect(dataFloat[3]).toBeCloseTo(0.6); // R1
  });
});
