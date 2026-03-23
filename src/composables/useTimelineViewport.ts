/**
 * Reactive Vue composable wrappers for timeline coordinate mapping.
 *
 * useTimelineViewport — thin wrapper over createTimeAxisMapper for panels
 * useTimelineViewportTransform — adds scroll/panel layout transforms (TrackList)
 */

import { computed, type MaybeRefOrGetter, toValue, type ComputedRef } from 'vue';
import { createTimeAxisMapper } from '@/shared/timeline-coordinates';

/**
 * Reactive timeline↔pixel mapper for a panel with a visible time range.
 *
 * Usage:
 *   const { timeToX, xToTimeRaw, xToTimeClamped, pixelsPerSecond } =
 *     useTimelineViewport(startTime, endTime, containerWidth);
 */
export function useTimelineViewport(
  startTime: MaybeRefOrGetter<number>,
  endTime: MaybeRefOrGetter<number>,
  containerWidth: MaybeRefOrGetter<number>,
) {
  const mapper = computed(() =>
    createTimeAxisMapper(toValue(startTime), toValue(endTime), toValue(containerWidth))
  );

  const pixelsPerSecond: ComputedRef<number> = computed(() => mapper.value.pixelsPerSecond());

  return {
    /** Convert timelineTime to pixel X */
    timeToX: (time: number) => mapper.value.timeToX(time),
    /** Convert pixel X to timelineTime — unclamped */
    xToTimeRaw: (x: number) => mapper.value.xToTimeRaw(x),
    /** Convert pixel X to timelineTime — clamped to [start, end] */
    xToTimeClamped: (x: number) => mapper.value.xToTimeClamped(x),
    /** Pixels per second at current scale */
    pixelsPerSecond,
  };
}

/**
 * Reactive layout transform for scrollable timeline panels (e.g. TrackList).
 * Adds scroll offset + panel width transforms on top of the pure time mapper.
 *
 * This is a **layout transform**, not time math — content↔viewport space.
 */
export function useTimelineViewportTransform(
  startTime: MaybeRefOrGetter<number>,
  endTime: MaybeRefOrGetter<number>,
  contentWidth: MaybeRefOrGetter<number>,
  scrollLeft: MaybeRefOrGetter<number>,
  panelWidth: MaybeRefOrGetter<number>,
) {
  const mapper = computed(() =>
    createTimeAxisMapper(toValue(startTime), toValue(endTime), toValue(contentWidth))
  );

  /** Convert timelineTime to viewport-relative X (accounts for scroll + panel) */
  const timeToViewportX = (time: number): number =>
    mapper.value.timeToX(time) - toValue(scrollLeft) + toValue(panelWidth);

  /** Convert viewport X to timelineTime — unclamped */
  const viewportXToTimeRaw = (x: number): number =>
    mapper.value.xToTimeRaw(x + toValue(scrollLeft) - toValue(panelWidth));

  return { mapper, timeToViewportX, viewportXToTimeRaw };
}
