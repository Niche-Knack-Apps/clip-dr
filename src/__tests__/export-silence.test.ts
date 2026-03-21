import { describe, it, expect } from 'vitest';
import type { ExportEDLTrack, SilenceRegion } from '@/shared/types';
import { subtractSilenceFromClip, collapseTimeline, computeUnionSilenceRegions } from '@/stores/export';

function mkClip(trackStart: number, duration: number, fileOffset = 0, envelope?: Array<{ time: number; value: number }>): ExportEDLTrack {
  return {
    source_path: '/src.wav',
    track_start: trackStart,
    duration,
    volume: 1.0,
    file_offset: fileOffset,
    volume_envelope: envelope,
  };
}

function mkSilence(start: number, end: number): SilenceRegion {
  return { id: `s-${start}-${end}`, start, end, enabled: true };
}

describe('subtractSilenceFromClip', () => {
  it('returns clip unchanged when no silence overlaps', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(15, 20)]);
    expect(result).toHaveLength(1);
    expect(result[0].track_start).toBe(0);
    expect(result[0].duration).toBe(10);
  });

  it('returns empty array when clip is entirely inside silence', () => {
    const clip = mkClip(2, 3); // 2–5
    const result = subtractSilenceFromClip(clip, [mkSilence(1, 6)]);
    expect(result).toHaveLength(0);
  });

  it('splits clip around silence in the middle', () => {
    const clip = mkClip(0, 10, 0); // 0–10
    const result = subtractSilenceFromClip(clip, [mkSilence(3, 5)]); // silence 3–5
    expect(result).toHaveLength(2);
    // Before silence: 0–3
    expect(result[0].track_start).toBe(0);
    expect(result[0].duration).toBe(3);
    expect(result[0].file_offset).toBe(0);
    // After silence: 5–10
    expect(result[1].track_start).toBe(5);
    expect(result[1].duration).toBe(5);
    expect(result[1].file_offset).toBe(5);
  });

  it('handles multiple silences in one clip', () => {
    const clip = mkClip(0, 20, 10); // timeline 0–20, file offset 10
    const silences = [mkSilence(3, 5), mkSilence(12, 15)];
    const result = subtractSilenceFromClip(clip, silences);
    expect(result).toHaveLength(3);
    // 0–3
    expect(result[0].track_start).toBe(0);
    expect(result[0].duration).toBe(3);
    expect(result[0].file_offset).toBe(10);
    // 5–12
    expect(result[1].track_start).toBe(5);
    expect(result[1].duration).toBe(7);
    expect(result[1].file_offset).toBe(15);
    // 15–20
    expect(result[2].track_start).toBe(15);
    expect(result[2].duration).toBe(5);
    expect(result[2].file_offset).toBe(25);
  });

  it('handles silence at clip start', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(0, 3)]);
    expect(result).toHaveLength(1);
    expect(result[0].track_start).toBe(3);
    expect(result[0].duration).toBe(7);
    expect(result[0].file_offset).toBe(3);
  });

  it('handles silence at clip end', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(7, 10)]);
    expect(result).toHaveLength(1);
    expect(result[0].track_start).toBe(0);
    expect(result[0].duration).toBe(7);
    expect(result[0].file_offset).toBe(0);
  });

  it('rebases volume envelope to each sub-clip', () => {
    const envelope = [
      { time: 1, value: 0.8 },
      { time: 4, value: 0.5 },
      { time: 7, value: 0.3 },
    ];
    const clip = mkClip(0, 10, 0, envelope);
    const result = subtractSilenceFromClip(clip, [mkSilence(3, 5)]);
    expect(result).toHaveLength(2);
    // Sub-clip 0–3: envelope point at t=1 (offset 0)
    expect(result[0].volume_envelope).toHaveLength(1);
    expect(result[0].volume_envelope![0].time).toBe(1);
    // Sub-clip 5–10: envelope points rebased by offset 5 → t=4→-1 (filtered), t=7→2
    expect(result[1].volume_envelope).toHaveLength(1);
    expect(result[1].volume_envelope![0].time).toBe(2);
    expect(result[1].volume_envelope![0].value).toBe(0.3);
  });

  it('handles silence extending beyond clip boundaries', () => {
    const clip = mkClip(5, 10); // 5–15
    const silences = [mkSilence(3, 8), mkSilence(13, 20)];
    const result = subtractSilenceFromClip(clip, silences);
    expect(result).toHaveLength(1);
    // Only speech portion: 8–13
    expect(result[0].track_start).toBe(8);
    expect(result[0].duration).toBe(5);
    expect(result[0].file_offset).toBe(3); // 8-5=3 offset from clip start
  });
});

describe('collapseTimeline', () => {
  it('returns unchanged clips when no silence', () => {
    const clips = [mkClip(0, 5), mkClip(5, 5)];
    const { clips: result, newEndTime } = collapseTimeline(clips, [], 10);
    expect(result[0].track_start).toBe(0);
    expect(result[1].track_start).toBe(5);
    expect(newEndTime).toBe(10);
  });

  it('collapses gaps from removed silence', () => {
    // After subtractSilenceFromClip, clips are at 0–3 and 5–10.
    // Silence 3–5 (2s gap). Clip at 5 should shift to 3.
    const clips = [mkClip(0, 3), mkClip(5, 5)];
    const silence = [mkSilence(3, 5)];
    const { clips: result, newEndTime } = collapseTimeline(clips, silence, 10);
    expect(result[0].track_start).toBe(0);
    expect(result[1].track_start).toBe(3); // 5 - 2s silence before it
    expect(newEndTime).toBe(8); // 10 - 2
  });

  it('handles multiple silence regions', () => {
    const clips = [mkClip(0, 3), mkClip(5, 4), mkClip(12, 3)];
    const silences = [mkSilence(3, 5), mkSilence(9, 12)]; // 2s + 3s = 5s total
    const { clips: result, newEndTime } = collapseTimeline(clips, silences, 15);
    expect(result[0].track_start).toBe(0);     // no silence before
    expect(result[1].track_start).toBe(3);     // 5 - 2s
    expect(result[2].track_start).toBe(7);     // 12 - 5s
    expect(newEndTime).toBe(10);               // 15 - 5
  });
});

describe('subtractSilenceFromClip — crossfade', () => {
  it('applies fade_in/fade_out at silence-created edges', () => {
    const clip = mkClip(0, 10); // 0–10
    const result = subtractSilenceFromClip(clip, [mkSilence(3, 5)], 0.01); // 10ms crossfade
    expect(result).toHaveLength(2);
    // Before silence (0–3): no fade_in (original start), fade_out at silence boundary
    expect(result[0].fade_in).toBeUndefined();
    expect(result[0].fade_out).toBe(0.01);
    // After silence (5–10): fade_in at silence boundary, no fade_out (original end)
    expect(result[1].fade_in).toBe(0.01);
    expect(result[1].fade_out).toBeUndefined();
  });

  it('both edges get fades for middle sub-clip', () => {
    const clip = mkClip(0, 20);
    const result = subtractSilenceFromClip(clip, [mkSilence(3, 5), mkSilence(12, 15)], 0.01);
    expect(result).toHaveLength(3);
    // Middle sub-clip (5–12): both edges created by silence
    expect(result[1].fade_in).toBe(0.01);
    expect(result[1].fade_out).toBe(0.01);
  });

  it('no fades when crossfadeSec is 0', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(3, 5)], 0);
    expect(result[0].fade_in).toBeUndefined();
    expect(result[0].fade_out).toBeUndefined();
    expect(result[1].fade_in).toBeUndefined();
    expect(result[1].fade_out).toBeUndefined();
  });

  it('clamps fade to half sub-clip duration', () => {
    const clip = mkClip(0, 10);
    // Silence 4–6 leaves sub-clips of 4s and 4s. Crossfade 3s → clamped to 2s (half)
    const result = subtractSilenceFromClip(clip, [mkSilence(4, 6)], 3);
    expect(result[0].fade_out).toBe(2); // 4/2 = 2
    expect(result[1].fade_in).toBe(2);
  });

  it('silence at start: sub-clip gets fade_in only', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(0, 3)], 0.01);
    expect(result).toHaveLength(1);
    // Start edge is silence boundary, end edge is original clip end
    expect(result[0].fade_in).toBe(0.01);
    expect(result[0].fade_out).toBeUndefined();
  });

  it('silence at end: sub-clip gets fade_out only', () => {
    const clip = mkClip(0, 10);
    const result = subtractSilenceFromClip(clip, [mkSilence(7, 10)], 0.01);
    expect(result).toHaveLength(1);
    // Start edge is original clip start, end edge is silence boundary
    expect(result[0].fade_in).toBeUndefined();
    expect(result[0].fade_out).toBe(0.01);
  });
});

describe('computeUnionSilenceRegions', () => {
  it('returns empty for no tracks', () => {
    const mockStore = { getActiveRegionsForTrack: () => [] } as any;
    expect(computeUnionSilenceRegions([], mockStore)).toEqual([]);
  });

  it('merges overlapping regions from multiple tracks', () => {
    const regions: Record<string, SilenceRegion[]> = {
      't1': [mkSilence(1, 4), mkSilence(8, 10)],
      't2': [mkSilence(3, 6)],
    };
    const mockStore = {
      getActiveRegionsForTrack: (id: string) => regions[id] || [],
    } as any;
    const tracks = [{ id: 't1' }, { id: 't2' }] as any[];
    const result = computeUnionSilenceRegions(tracks, mockStore);
    expect(result).toHaveLength(2);
    // 1–4 merged with 3–6 → 1–6
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(6);
    // 8–10 standalone
    expect(result[1].start).toBe(8);
    expect(result[1].end).toBe(10);
  });

  it('handles non-overlapping regions', () => {
    const regions: Record<string, SilenceRegion[]> = {
      't1': [mkSilence(1, 3)],
      't2': [mkSilence(5, 7)],
    };
    const mockStore = {
      getActiveRegionsForTrack: (id: string) => regions[id] || [],
    } as any;
    const tracks = [{ id: 't1' }, { id: 't2' }] as any[];
    const result = computeUnionSilenceRegions(tracks, mockStore);
    expect(result).toHaveLength(2);
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(3);
    expect(result[1].start).toBe(5);
    expect(result[1].end).toBe(7);
  });
});
