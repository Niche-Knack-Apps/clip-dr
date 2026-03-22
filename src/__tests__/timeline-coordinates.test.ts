import { describe, it, expect } from 'vitest';
import { createTimeAxisMapper, clientXToLocalX } from '@/shared/timeline-coordinates';

describe('createTimeAxisMapper', () => {
  // ── Round-trip invariants ──

  describe('round-trip identity', () => {
    it('time → x → time preserves value', () => {
      const m = createTimeAxisMapper(0, 100, 1000);
      for (const t of [0, 25, 50, 75, 100, 42.7]) {
        expect(m.xToTimeRaw(m.timeToX(t))).toBeCloseTo(t, 10);
      }
    });

    it('x → time → x preserves value', () => {
      const m = createTimeAxisMapper(0, 100, 1000);
      for (const x of [0, 250, 500, 750, 1000, 427]) {
        expect(m.timeToX(m.xToTimeRaw(x))).toBeCloseTo(x, 10);
      }
    });

    it('round-trip with non-zero start', () => {
      const m = createTimeAxisMapper(10, 60, 500);
      for (const t of [10, 25, 35, 60]) {
        expect(m.xToTimeRaw(m.timeToX(t))).toBeCloseTo(t, 10);
      }
    });

    it('precision at large duration (1 hour)', () => {
      const m = createTimeAxisMapper(0, 3600, 10000);
      const t = 1847.123456789;
      expect(m.xToTimeRaw(m.timeToX(t))).toBeCloseTo(t, 6);
    });

    it('precision at extreme zoom (10000px for 0.1s)', () => {
      const m = createTimeAxisMapper(50, 50.1, 10000);
      const t = 50.05;
      expect(m.xToTimeRaw(m.timeToX(t))).toBeCloseTo(t, 8);
    });
  });

  // ── Basic conversions ──

  describe('timeToX', () => {
    it('maps start to 0 and end to width', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.timeToX(0)).toBe(0);
      expect(m.timeToX(10)).toBe(1000);
    });

    it('maps midpoint correctly', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.timeToX(5)).toBe(500);
    });

    it('handles non-zero start', () => {
      const m = createTimeAxisMapper(20, 30, 500);
      expect(m.timeToX(20)).toBe(0);
      expect(m.timeToX(25)).toBe(250);
      expect(m.timeToX(30)).toBe(500);
    });

    it('allows time outside range (unclamped output)', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.timeToX(-5)).toBe(-500);
      expect(m.timeToX(15)).toBe(1500);
    });
  });

  describe('xToTimeRaw', () => {
    it('maps 0 to start and width to end', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.xToTimeRaw(0)).toBe(0);
      expect(m.xToTimeRaw(1000)).toBe(10);
    });

    it('allows x outside range (unclamped)', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.xToTimeRaw(-100)).toBe(-1);
      expect(m.xToTimeRaw(1100)).toBe(11);
    });
  });

  describe('xToTimeClamped', () => {
    it('clamps negative x to startTime', () => {
      const m = createTimeAxisMapper(5, 15, 1000);
      expect(m.xToTimeClamped(-100)).toBe(5);
    });

    it('clamps x > width to endTime', () => {
      const m = createTimeAxisMapper(5, 15, 1000);
      expect(m.xToTimeClamped(1500)).toBe(15);
    });

    it('does not clamp within range', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.xToTimeClamped(500)).toBe(5);
    });
  });

  describe('pixelsPerSecond', () => {
    it('returns correct ratio', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(m.pixelsPerSecond()).toBe(100);
    });

    it('handles non-zero start', () => {
      const m = createTimeAxisMapper(5, 15, 500);
      expect(m.pixelsPerSecond()).toBe(50);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('zero width → timeToX returns 0', () => {
      const m = createTimeAxisMapper(0, 10, 0);
      expect(m.timeToX(5)).toBe(0);
    });

    it('zero width → xToTimeRaw returns startTime', () => {
      const m = createTimeAxisMapper(5, 15, 0);
      expect(m.xToTimeRaw(100)).toBe(5);
    });

    it('zero range (start == end) → timeToX returns 0', () => {
      const m = createTimeAxisMapper(5, 5, 1000);
      expect(m.timeToX(5)).toBe(0);
    });

    it('zero range → pixelsPerSecond returns 1 (safe fallback)', () => {
      const m = createTimeAxisMapper(5, 5, 1000);
      expect(m.pixelsPerSecond()).toBe(1);
    });
  });

  // ── Safety guarantees ──

  describe('safety', () => {
    it('destructured functions work (no this dependency)', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      const { timeToX, xToTimeRaw, xToTimeClamped, pixelsPerSecond } = m;
      expect(timeToX(5)).toBe(500);
      expect(xToTimeRaw(500)).toBe(5);
      expect(xToTimeClamped(500)).toBe(5);
      expect(pixelsPerSecond()).toBe(100);
    });

    it('mapper is frozen (immutable)', () => {
      const m = createTimeAxisMapper(0, 10, 1000);
      expect(Object.isFrozen(m)).toBe(true);
      expect(() => { (m as any).timeToX = () => 0; }).toThrow();
    });
  });
});

describe('clientXToLocalX', () => {
  it('subtracts element left from clientX', () => {
    const el = {
      getBoundingClientRect: () => ({ left: 100, top: 0, right: 500, bottom: 100, width: 400, height: 100, x: 100, y: 0, toJSON: () => {} }),
    } as HTMLElement;
    expect(clientXToLocalX(350, el)).toBe(250);
  });
});
