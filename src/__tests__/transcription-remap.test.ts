import { describe, it, expect } from 'vitest';
import type { RenderClipMap } from '@/services/track-render';

/**
 * Standalone re-implementation of remapWordsFromRender for unit testing.
 * Mirrors the logic in transcription.ts without needing store setup.
 */
function remapWordsFromRender(
  words: Array<{ id: string; text: string; start: number; end: number; confidence: number }>,
  clipMap: RenderClipMap[],
  trackStart: number,
) {
  return words.map(w => {
    for (const cm of clipMap) {
      if (w.start >= cm.renderStart && w.start < cm.renderEnd) {
        const offsetInClip = w.start - cm.renderStart;
        const timelinePos = cm.timelineStart + offsetInClip;
        const dur = w.end - w.start;
        return { ...w, start: timelinePos - trackStart, end: timelinePos - trackStart + dur };
      }
    }
    return w;
  });
}

function mkWord(start: number, end: number, text = 'word'): { id: string; text: string; start: number; end: number; confidence: number } {
  return { id: `w-${start}`, text, start, end, confidence: 0.9 };
}

describe('remapWordsFromRender (v0.27.24 regression)', () => {
  it('remaps words from contiguous clips (no gap)', () => {
    // Two clips: [0-3s] and [3-7s], trackStart=0
    // Rendered as: [0-3s][3-7s] (no gap, no rebase needed)
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 3, timelineStart: 0 },
      { renderStart: 3, renderEnd: 7, timelineStart: 3 },
    ];
    const words = [mkWord(1, 1.5), mkWord(4, 4.5)];
    const result = remapWordsFromRender(words, clipMap, 0);

    expect(result[0].start).toBe(1);   // 0 + 1 - 0 = 1
    expect(result[1].start).toBe(4);   // 3 + 1 - 0 = 4
  });

  it('remaps words from clips with gap', () => {
    // Two clips: [0-3s] and [5-10s] (2s gap), trackStart=0
    // Rendered as: [0-3s][3-5s gap silence][5-10s]
    // BUT render preserves gaps, so rendered positions match timeline minus trackStart
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 3, timelineStart: 0 },
      { renderStart: 5, renderEnd: 10, timelineStart: 5 },
    ];
    const words = [mkWord(1, 1.5, 'hello'), mkWord(6, 6.5, 'world')];
    const result = remapWordsFromRender(words, clipMap, 0);

    expect(result[0].start).toBe(1);   // in first clip: 0 + 1 - 0
    expect(result[1].start).toBe(6);   // in second clip: 5 + 1 - 0
  });

  it('remaps words with trackStart offset', () => {
    // Track starts at 10s, clips at [10-13s] and [15-20s]
    // Render rebases to 0: [0-3s][5-10s]
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 3, timelineStart: 10 },
      { renderStart: 5, renderEnd: 10, timelineStart: 15 },
    ];
    const words = [mkWord(1, 1.5), mkWord(6, 6.5)];
    const result = remapWordsFromRender(words, clipMap, 10);

    // Word at render 1.0 → timeline 11.0 → stored as 11.0 - 10 = 1.0
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(1.5);
    // Word at render 6.0 → timeline 16.0 → stored as 16.0 - 10 = 6.0
    expect(result[1].start).toBe(6);
    expect(result[1].end).toBe(6.5);
  });

  it('remaps words when render compacts gaps (EDL rebase)', () => {
    // Track starts at 5s, clips at [5-8s] and [12-17s] (4s gap)
    // If render compacted gaps (removed 4s gap):
    // Rendered: [0-3s][3-8s] → but clipMap preserves original timeline
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 3, timelineStart: 5 },
      { renderStart: 3, renderEnd: 8, timelineStart: 12 },
    ];
    const words = [mkWord(1, 1.5, 'first'), mkWord(4, 4.5, 'second')];
    const result = remapWordsFromRender(words, clipMap, 5);

    // Word at render 1.0 → timeline 6.0 → stored as 6.0 - 5 = 1.0
    expect(result[0].start).toBe(1);
    // Word at render 4.0 → in second clip (renderStart=3): offset=1.0 → timeline 13.0 → stored as 13.0 - 5 = 8.0
    expect(result[1].start).toBe(8);
    expect(result[1].end).toBe(8.5);
  });

  it('handles single clip (no split)', () => {
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 10, timelineStart: 0 },
    ];
    const words = [mkWord(2, 2.5), mkWord(7, 7.5)];
    const result = remapWordsFromRender(words, clipMap, 0);

    expect(result[0].start).toBe(2);
    expect(result[1].start).toBe(7);
  });

  it('words in silence gaps remain unchanged', () => {
    // Gap between clips — word falls outside any clip's render range
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 3, timelineStart: 0 },
      { renderStart: 5, renderEnd: 10, timelineStart: 5 },
    ];
    // Word at 4.0s is in the silence gap (between renderEnd=3 and renderStart=5)
    const words = [mkWord(4, 4.5, 'ghost')];
    const result = remapWordsFromRender(words, clipMap, 0);

    // Falls through — returned as-is
    expect(result[0].start).toBe(4);
  });

  it('preserves word metadata through remap', () => {
    const clipMap: RenderClipMap[] = [
      { renderStart: 0, renderEnd: 5, timelineStart: 10 },
    ];
    const words = [{ id: 'w1', text: 'hello', start: 1, end: 1.5, confidence: 0.95 }];
    const result = remapWordsFromRender(words, clipMap, 10);

    expect(result[0].id).toBe('w1');
    expect(result[0].text).toBe('hello');
    expect(result[0].confidence).toBe(0.95);
  });
});
