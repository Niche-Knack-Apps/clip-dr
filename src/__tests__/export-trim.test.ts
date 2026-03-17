import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ExportEDL, ExportEDLTrack } from '@/shared/types';

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

/**
 * Replicate rebaseEdlToZero from export.ts so we can test the logic directly.
 * The actual function is private inside the store.
 */
function rebaseEdlToZero(edl: ExportEDL): void {
  if (edl.tracks.length === 0) return;
  const minStart = Math.min(...edl.tracks.map(t => t.track_start));
  if (minStart <= 0) return;
  for (const track of edl.tracks) {
    track.track_start -= minStart;
  }
  edl.end_time -= minStart;
}

function makeEdl(tracks: ExportEDLTrack[]): ExportEDL {
  const endTime = tracks.length > 0
    ? Math.max(...tracks.map(t => t.track_start + t.duration))
    : 0;
  return {
    tracks,
    output_path: '/tmp/out.wav',
    format: 'wav',
    sample_rate: 44100,
    channels: 2,
    start_time: 0,
    end_time: endTime,
  };
}

function makeTrack(trackStart: number, duration: number, fileOffset = 0): ExportEDLTrack {
  return {
    source_path: '/source/file.wav',
    track_start: trackStart,
    duration,
    volume: 1.0,
    file_offset: fileOffset,
  };
}

describe('Export Trim — rebaseEdlToZero', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('rebases single track at offset 5.0 to start at 0', () => {
    const edl = makeEdl([makeTrack(5.0, 3.0)]);
    expect(edl.end_time).toBe(8.0);

    rebaseEdlToZero(edl);

    expect(edl.tracks[0].track_start).toBe(0);
    expect(edl.end_time).toBe(3.0);
  });

  it('rebases two clips preserving internal gap', () => {
    const edl = makeEdl([
      makeTrack(3.0, 2.0),  // 3.0 - 5.0
      makeTrack(7.0, 3.0),  // 7.0 - 10.0
    ]);
    expect(edl.end_time).toBe(10.0);

    rebaseEdlToZero(edl);

    // First clip shifts from 3.0 to 0.0
    expect(edl.tracks[0].track_start).toBe(0);
    // Second clip shifts from 7.0 to 4.0 (preserves 2s gap)
    expect(edl.tracks[1].track_start).toBe(4.0);
    expect(edl.end_time).toBe(7.0);
  });

  it('does not rebase when track already starts at 0', () => {
    const edl = makeEdl([makeTrack(0, 5.0)]);

    rebaseEdlToZero(edl);

    expect(edl.tracks[0].track_start).toBe(0);
    expect(edl.end_time).toBe(5.0);
  });

  it('does not rebase empty EDL', () => {
    const edl = makeEdl([]);

    rebaseEdlToZero(edl);

    expect(edl.tracks).toHaveLength(0);
    expect(edl.end_time).toBe(0);
  });

  it('preserves file_offset when rebasing', () => {
    const edl = makeEdl([makeTrack(5.0, 3.0, 10.0)]);

    rebaseEdlToZero(edl);

    // track_start rebased, but file_offset is source-relative and must NOT change
    expect(edl.tracks[0].track_start).toBe(0);
    expect(edl.tracks[0].file_offset).toBe(10.0);
  });
});
