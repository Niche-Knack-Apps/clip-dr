/**
 * Pure timeline ↔ pixel coordinate mapping.
 *
 * This module handles coordinate spaces 1-4:
 *   1. timelineTime — absolute seconds on the global timeline
 *   2. viewportTime — the visible zoomed window (start..end)
 *   3. contentX    — pixel position within scrollable timeline content
 *   4. clientX     — mouse event screen coordinates
 *
 * It does NOT handle clip/source/buffer coordinate spaces (5-7).
 * Those are separate semantic spaces — never mix them with this utility.
 *
 * All functions are arrow closures (no `this`) and safe to destructure.
 * The returned mapper is frozen (immutable).
 */

export interface TimeAxisMapper {
  /** Convert absolute time (seconds) to pixel X position within the mapped range */
  timeToX(time: number): number;
  /** Convert pixel X to time — unclamped (may return outside [startTime, endTime]) */
  xToTimeRaw(x: number): number;
  /** Convert pixel X to time — clamped to [startTime, endTime] */
  xToTimeClamped(x: number): number;
  /** Pixels per second at the current scale */
  pixelsPerSecond(): number;
}

/**
 * Create a frozen, pure time↔pixel mapper for a given range and width.
 *
 * @param startTime - Start of the visible/mapped time range (seconds)
 * @param endTime   - End of the visible/mapped time range (seconds)
 * @param width     - Pixel width of the container
 */
export function createTimeAxisMapper(
  startTime: number,
  endTime: number,
  width: number,
): TimeAxisMapper {
  const range = endTime - startTime;

  const timeToX = (time: number): number => {
    if (range <= 0 || width <= 0) return 0;
    return ((time - startTime) / range) * width;
  };

  const xToTimeRaw = (x: number): number => {
    if (width <= 0) return startTime;
    return (x / width) * range + startTime;
  };

  const xToTimeClamped = (x: number): number => {
    const t = xToTimeRaw(x);
    return Math.max(startTime, Math.min(t, endTime));
  };

  const pixelsPerSecond = (): number => {
    return range > 0 ? width / range : 1;
  };

  return Object.freeze({ timeToX, xToTimeRaw, xToTimeClamped, pixelsPerSecond });
}

/**
 * Convert a mouse clientX to a container-local X position.
 * This is a DOM utility — separate from time math.
 */
export function clientXToLocalX(clientX: number, el: HTMLElement): number {
  return clientX - el.getBoundingClientRect().left;
}
