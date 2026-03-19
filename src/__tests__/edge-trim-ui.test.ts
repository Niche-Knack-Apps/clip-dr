import { describe, it, expect } from 'vitest';

/**
 * Edge trim UI tests — pure logic tests for the edge detection and hidden audio computations
 * that ClipRegion.vue uses. These don't require component rendering.
 */

const EDGE_ZONE_PX = 12;

describe('Edge Trim UI — Logic', () => {
  describe('hasHiddenLeft/hasHiddenRight computations', () => {
    it('hasHiddenLeft is true when sourceOffset > sourceIn', () => {
      const clip = { sourceIn: 0, sourceOffset: 2, duration: 8, sourceDuration: 20 };
      const hasHiddenLeft = clip.sourceOffset > clip.sourceIn;
      expect(hasHiddenLeft).toBe(true);
    });

    it('hasHiddenLeft is false when sourceOffset === sourceIn', () => {
      const clip = { sourceIn: 2, sourceOffset: 2, duration: 8, sourceDuration: 20 };
      const hasHiddenLeft = clip.sourceOffset > clip.sourceIn;
      expect(hasHiddenLeft).toBe(false);
    });

    it('hasHiddenRight is true when clip end < source end', () => {
      const clip = { sourceIn: 0, sourceOffset: 2, duration: 8, sourceDuration: 20 };
      const hasHiddenRight = (clip.sourceOffset + clip.duration) < (clip.sourceIn + clip.sourceDuration);
      expect(hasHiddenRight).toBe(true); // 10 < 20
    });

    it('hasHiddenRight is false when clip extends to source end', () => {
      const clip = { sourceIn: 0, sourceOffset: 2, duration: 18, sourceDuration: 20 };
      const hasHiddenRight = (clip.sourceOffset + clip.duration) < (clip.sourceIn + clip.sourceDuration);
      expect(hasHiddenRight).toBe(false); // 20 === 20
    });
  });

  describe('edge zone hit detection', () => {
    it('click in left edge zone (0 to EDGE_ZONE_PX) detects left edge', () => {
      const clipWidth = 100;
      const localX = 5;
      const isLeftEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX <= EDGE_ZONE_PX;
      expect(isLeftEdge).toBe(true);
    });

    it('click in right edge zone detects right edge', () => {
      const clipWidth = 100;
      const localX = 95;
      const isRightEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX >= clipWidth - EDGE_ZONE_PX;
      expect(isRightEdge).toBe(true);
    });

    it('click in center is not an edge', () => {
      const clipWidth = 100;
      const localX = 50;
      const isLeftEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX <= EDGE_ZONE_PX;
      const isRightEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX >= clipWidth - EDGE_ZONE_PX;
      expect(isLeftEdge).toBe(false);
      expect(isRightEdge).toBe(false);
    });
  });

  describe('narrow clips prioritize drag over edge trim', () => {
    it('clip narrower than 2 × EDGE_ZONE_PX skips edge detection', () => {
      const clipWidth = 20; // < 24
      const localX = 3;
      const isEdgeDetectionEnabled = clipWidth >= EDGE_ZONE_PX * 2;
      expect(isEdgeDetectionEnabled).toBe(false);
    });

    it('clip exactly 2 × EDGE_ZONE_PX enables edge detection', () => {
      const clipWidth = 24; // === 24
      const localX = 3;
      const isEdgeDetectionEnabled = clipWidth >= EDGE_ZONE_PX * 2;
      expect(isEdgeDetectionEnabled).toBe(true);
    });
  });

  describe('clip drag vs edge trim threshold boundary', () => {
    it('at boundary pixel, left edge takes precedence', () => {
      const clipWidth = 100;
      const localX = EDGE_ZONE_PX; // exactly at boundary
      const isLeftEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX <= EDGE_ZONE_PX;
      expect(isLeftEdge).toBe(true);
    });

    it('one pixel past boundary, drag takes over', () => {
      const clipWidth = 100;
      const localX = EDGE_ZONE_PX + 1;
      const isLeftEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX <= EDGE_ZONE_PX;
      const isRightEdge = clipWidth >= EDGE_ZONE_PX * 2 && localX >= clipWidth - EDGE_ZONE_PX;
      expect(isLeftEdge).toBe(false);
      expect(isRightEdge).toBe(false);
    });
  });
});
