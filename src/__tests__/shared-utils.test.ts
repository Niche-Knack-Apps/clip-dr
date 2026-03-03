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
