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

describe('Recording Error Surfacing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('sets error.value when write_error_count > 0', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useRecordingStore } = await import('@/stores/recording');

    const store = useRecordingStore();

    // Force isRecording to true so stopRecording doesn't bail out early
    (store as unknown as Record<string, unknown>).isRecording = true;

    const mockResult = {
      path: '/tmp/rec.wav',
      duration: 5.0,
      sample_rate: 44100,
      channels: 2,
      extra_segments: [],
      pre_record_seconds: 0,
      write_error_count: 42,
    };

    vi.mocked(invoke).mockResolvedValueOnce(mockResult);

    await store.stopRecording();

    expect(store.error).toMatch(/42 write error/);
  });

  it('does not set error.value when write_error_count is 0', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useRecordingStore } = await import('@/stores/recording');

    const store = useRecordingStore();
    (store as unknown as Record<string, unknown>).isRecording = true;

    const mockResult = {
      path: '/tmp/rec.wav',
      duration: 5.0,
      sample_rate: 44100,
      channels: 2,
      extra_segments: [],
      pre_record_seconds: 0,
      write_error_count: 0,
    };

    vi.mocked(invoke).mockResolvedValueOnce(mockResult);

    await store.stopRecording();

    expect(store.error).toBeNull();
  });

  it('does not set error.value when write_error_count is absent', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useRecordingStore } = await import('@/stores/recording');

    const store = useRecordingStore();
    (store as unknown as Record<string, unknown>).isRecording = true;

    const mockResult = {
      path: '/tmp/rec.wav',
      duration: 5.0,
      sample_rate: 44100,
      channels: 2,
      extra_segments: [],
      pre_record_seconds: 0,
      // write_error_count absent (old backend / graceful compat)
    };

    vi.mocked(invoke).mockResolvedValueOnce(mockResult);

    await store.stopRecording();

    expect(store.error).toBeNull();
  });
});
