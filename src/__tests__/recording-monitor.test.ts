import { describe, it, expect } from 'vitest';
import { WaveformRingBuffer } from '@/stores/recording';

// ── WaveformRingBuffer Tests ──

describe('WaveformRingBuffer', () => {
  it('starts empty with version 0', () => {
    const buf = new WaveformRingBuffer(10, 1);
    expect(buf.count).toBe(0);
    expect(buf.head).toBe(0);
    expect(buf.version).toBe(0);
    const view = buf.getView();
    expect(view.count).toBe(0);
  });

  it('push increments version and count', () => {
    const buf = new WaveformRingBuffer(10, 1);
    buf.push(0.5, 1.0);
    expect(buf.count).toBe(1);
    expect(buf.version).toBe(1);
    buf.push(0.8, 2.0);
    expect(buf.count).toBe(2);
    expect(buf.version).toBe(2);
  });

  it('mutates slots in-place (no allocation)', () => {
    const buf = new WaveformRingBuffer(5, 1);
    const slot0 = buf.buffer[0];
    buf.push(0.5, 1.0);
    // Same object reference — mutated in-place
    expect(buf.buffer[0]).toBe(slot0);
    expect(slot0.peak).toBe(0.5);
    expect(slot0.time).toBe(1.0);
  });

  it('wraps around when capacity reached', () => {
    const buf = new WaveformRingBuffer(3, 1);
    buf.push(0.1, 0);
    buf.push(0.2, 1);
    buf.push(0.3, 2);
    expect(buf.count).toBe(3);
    expect(buf.head).toBe(0); // wrapped
    // Push one more — overwrites oldest
    buf.push(0.4, 3);
    expect(buf.count).toBe(3); // still 3, not 4
    expect(buf.head).toBe(1);
    // Oldest is now at index 1, newest at index 0
    expect(buf.buffer[0].peak).toBe(0.4);
    expect(buf.buffer[1].peak).toBe(0.2);
    expect(buf.buffer[2].peak).toBe(0.3);
  });

  it('getView returns zero-copy reference', () => {
    const buf = new WaveformRingBuffer(5, 1);
    buf.push(0.7, 1.0);
    const view = buf.getView();
    // Same buffer reference — not a copy
    expect(view.buffer).toBe(buf.buffer);
    expect(view.version).toBe(1);
    expect(view.count).toBe(1);
    expect(view.head).toBe(1);
  });

  it('clear resets count and head but preserves buffer', () => {
    const buf = new WaveformRingBuffer(5, 1);
    buf.push(0.5, 1.0);
    buf.push(0.8, 2.0);
    const bufRef = buf.buffer;
    buf.clear();
    expect(buf.count).toBe(0);
    expect(buf.head).toBe(0);
    expect(buf.buffer).toBe(bufRef); // same array
    expect(buf.version).toBe(3); // clear bumps version
  });

  it('supports multi-channel peaks via Float32Array', () => {
    const buf = new WaveformRingBuffer(5, 2);
    buf.push(0.5, 1.0, [0.3, 0.7]);
    expect(buf.buffer[0].channelPeaks[0]).toBeCloseTo(0.3);
    expect(buf.buffer[0].channelPeaks[1]).toBeCloseTo(0.7);
  });

  it('defaults channelPeaks[0] to peak when no channelPeaks provided', () => {
    const buf = new WaveformRingBuffer(5, 1);
    buf.push(0.6, 1.0);
    expect(buf.buffer[0].channelPeaks[0]).toBeCloseTo(0.6);
  });

  it('handles 600-entry capacity (production size)', () => {
    const buf = new WaveformRingBuffer(600, 1);
    for (let i = 0; i < 1200; i++) {
      buf.push(Math.random(), i * 0.1);
    }
    expect(buf.count).toBe(600);
    expect(buf.version).toBe(1200);
    // Head should be at 1200 % 600 = 0
    expect(buf.head).toBe(0);
  });
});
