import { describe, it, expect } from 'vitest';
import { generateTicks, formatRulerTime } from '@/components/tracks/time-ruler-utils';

describe('generateTicks', () => {
  it('returns empty array when duration is 0', () => {
    expect(generateTicks(800, 0, 'hms')).toEqual([]);
  });

  it('returns empty array when containerWidth is 0', () => {
    expect(generateTicks(0, 60, 'hms')).toEqual([]);
  });

  it('returns empty array when duration is negative', () => {
    expect(generateTicks(800, -5, 'hms')).toEqual([]);
  });

  it('picks sub-second interval for short duration', () => {
    // 0.5s duration, 800px wide → pxPerSec=1600, 0.1*1600=160 >= 60
    const ticks = generateTicks(800, 0.5, 'hms');
    expect(ticks.length).toBeGreaterThan(1);
    // First tick at t=0
    expect(ticks[0].time).toBe(0);
    // Labels should be decimal format
    const labeled = ticks.filter(t => t.label !== null);
    if (labeled.length > 0) {
      expect(labeled[0].label).toMatch(/^\d+\.\d$/);
    }
  });

  it('picks second-level interval for medium duration', () => {
    // 30s duration, 800px wide → pxPerSec≈26.7, 1*26.7=26.7 < 60, 2*26.7=53.3 < 60, 5*26.7=133 >= 60
    const ticks = generateTicks(800, 30, 'hms');
    expect(ticks.length).toBeGreaterThan(1);
    // Check interval is 5s
    if (ticks.length >= 2) {
      const interval = ticks[1].time - ticks[0].time;
      expect(interval).toBe(5);
    }
  });

  it('picks minute-level interval for long duration', () => {
    // 2hr = 7200s, 800px → pxPerSec≈0.111, need interval where iv*0.111>=60 → iv>=540
    // 600*0.111=66.6 >= 60 → picks 600s (10min)
    const ticks = generateTicks(800, 7200, 'hms');
    expect(ticks.length).toBeGreaterThan(1);
    if (ticks.length >= 2) {
      const interval = ticks[1].time - ticks[0].time;
      expect(interval).toBe(600);
    }
  });

  it('keeps all tick x values within [0, containerWidth]', () => {
    const ticks = generateTicks(600, 45, 'ms');
    for (const tick of ticks) {
      expect(tick.x).toBeGreaterThanOrEqual(0);
      expect(tick.x).toBeLessThanOrEqual(600);
    }
  });

  it('labels are never closer than 80px apart', () => {
    const ticks = generateTicks(1200, 120, 'hms');
    const labeledX = ticks.filter(t => t.label !== null).map(t => t.x);
    for (let i = 1; i < labeledX.length; i++) {
      // Allow tiny floating point tolerance
      expect(labeledX[i] - labeledX[i - 1]).toBeGreaterThanOrEqual(79.9);
    }
  });

  it('suppresses label on first tick if too close to left edge', () => {
    // The first tick is always at t=0 (x=0), which is < 15px → label should be null
    const ticks = generateTicks(800, 60, 'hms');
    expect(ticks[0].time).toBe(0);
    expect(ticks[0].x).toBe(0);
    expect(ticks[0].label).toBeNull();
  });

  it('suppresses label on last tick if too close to right edge', () => {
    // Use a duration where the last tick lands very close to containerWidth
    // 10s duration, 600px, interval=1s (1*60=60), last tick at t=10, x=600 → rightClip
    const ticks = generateTicks(600, 10, 'hms');
    const last = ticks[ticks.length - 1];
    if (last && last.x > 600 - 25) {
      expect(last.label).toBeNull();
    }
  });

  it('always starts with t=0', () => {
    const ticks = generateTicks(500, 30, 'ms');
    expect(ticks[0].time).toBe(0);
  });
});

describe('formatRulerTime', () => {
  it('shows decimal seconds for sub-second intervals', () => {
    expect(formatRulerTime(0.3, 0.1, 'hms')).toBe('0.3');
    expect(formatRulerTime(1.5, 0.5, 'ms')).toBe('1.5');
  });

  it('shows M:SS for hms format under 1 hour', () => {
    expect(formatRulerTime(0, 1, 'hms')).toBe('0:00');
    expect(formatRulerTime(90, 5, 'hms')).toBe('1:30');
    expect(formatRulerTime(765, 5, 'hms')).toBe('12:45');
  });

  it('shows MM:SS for ms format under 1 hour', () => {
    expect(formatRulerTime(0, 1, 'ms')).toBe('00:00');
    expect(formatRulerTime(90, 5, 'ms')).toBe('01:30');
    expect(formatRulerTime(765, 5, 'ms')).toBe('12:45');
  });

  it('shows H:MM:SS for times >= 1 hour', () => {
    expect(formatRulerTime(3600, 60, 'hms')).toBe('1:00:00');
    expect(formatRulerTime(3661, 1, 'hms')).toBe('1:01:01');
    expect(formatRulerTime(7200, 300, 'ms')).toBe('2:00:00');
  });
});
