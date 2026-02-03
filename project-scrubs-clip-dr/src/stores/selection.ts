import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useTracksStore } from './tracks';
import type { Selection, InOutPoints } from '@/shared/types';
import { DEFAULT_SELECTION_DURATION, MIN_SELECTION_DURATION } from '@/shared/constants';
import { clamp } from '@/shared/utils';

export const useSelectionStore = defineStore('selection', () => {
  // Helper to get effective duration based on current selection/view mode
  // Returns track-relative duration (0 to duration) for zoom/selection window
  function getEffectiveDuration(): number {
    const tracksStore = useTracksStore();

    // If a specific track is selected, use its duration
    const selectedTrack = tracksStore.selectedTrack;
    if (selectedTrack) {
      return selectedTrack.duration;
    }

    // Otherwise use the full timeline duration
    return tracksStore.timelineDuration;
  }

  // Helper to get timeline range for in/out points
  // Returns [minTime, maxTime] in timeline coordinates
  function getTimelineRange(): { min: number; max: number } {
    const tracksStore = useTracksStore();

    // If a specific track is selected, use its timeline range
    const selectedTrack = tracksStore.selectedTrack;
    if (selectedTrack) {
      return {
        min: selectedTrack.trackStart,
        max: selectedTrack.trackStart + selectedTrack.duration,
      };
    }

    // Otherwise use the full timeline [0, duration]
    return {
      min: 0,
      max: tracksStore.timelineDuration,
    };
  }

  const selection = ref<Selection>({
    start: 0,
    end: DEFAULT_SELECTION_DURATION,
  });

  const inOutPoints = ref<InOutPoints>({
    inPoint: null,
    outPoint: null,
  });

  const selectionDuration = computed(() => selection.value.end - selection.value.start);

  const hasInOutPoints = computed(
    () => inOutPoints.value.inPoint !== null && inOutPoints.value.outPoint !== null
  );

  const clipDuration = computed(() => {
    if (!hasInOutPoints.value) return 0;
    return inOutPoints.value.outPoint! - inOutPoints.value.inPoint!;
  });

  function setSelection(start: number, end: number): void {
    const duration = getEffectiveDuration();
    const clampedStart = clamp(start, 0, duration - MIN_SELECTION_DURATION);
    const clampedEnd = clamp(end, clampedStart + MIN_SELECTION_DURATION, duration);

    selection.value = {
      start: clampedStart,
      end: clampedEnd,
    };
  }

  function moveSelection(delta: number): void {
    const duration = getEffectiveDuration();
    const selDuration = selectionDuration.value;

    let newStart = selection.value.start + delta;
    let newEnd = selection.value.end + delta;

    if (newStart < 0) {
      newStart = 0;
      newEnd = selDuration;
    }

    if (newEnd > duration) {
      newEnd = duration;
      newStart = duration - selDuration;
    }

    selection.value = {
      start: newStart,
      end: newEnd,
    };
  }

  function resizeSelectionStart(newStart: number): void {
    const clampedStart = clamp(newStart, 0, selection.value.end - MIN_SELECTION_DURATION);

    selection.value = {
      start: clampedStart,
      end: selection.value.end,
    };
  }

  function resizeSelectionEnd(newEnd: number): void {
    const duration = getEffectiveDuration();
    const clampedEnd = clamp(
      newEnd,
      selection.value.start + MIN_SELECTION_DURATION,
      duration
    );

    selection.value = {
      start: selection.value.start,
      end: clampedEnd,
    };
  }

  function setSelectionFromPosition(position: number, width: number = DEFAULT_SELECTION_DURATION): void {
    const duration = getEffectiveDuration();
    const halfWidth = width / 2;

    let start = position - halfWidth;
    let end = position + halfWidth;

    if (start < 0) {
      start = 0;
      end = width;
    }

    if (end > duration) {
      end = duration;
      start = Math.max(0, duration - width);
    }

    selection.value = { start, end };
  }

  function setInPoint(time: number): void {
    const range = getTimelineRange();
    inOutPoints.value.inPoint = clamp(time, range.min, range.max);
    if (inOutPoints.value.outPoint !== null && inOutPoints.value.outPoint < time) {
      inOutPoints.value.outPoint = null;
    }
  }

  function setOutPoint(time: number): void {
    const range = getTimelineRange();
    inOutPoints.value.outPoint = clamp(time, range.min, range.max);
    if (inOutPoints.value.inPoint !== null && inOutPoints.value.inPoint > time) {
      inOutPoints.value.inPoint = null;
    }
  }

  function clearInPoint(): void {
    inOutPoints.value.inPoint = null;
  }

  function clearOutPoint(): void {
    inOutPoints.value.outPoint = null;
  }

  function clearInOutPoints(): void {
    inOutPoints.value = {
      inPoint: null,
      outPoint: null,
    };
  }

  function resetSelection(): void {
    selection.value = {
      start: 0,
      end: Math.min(DEFAULT_SELECTION_DURATION, getEffectiveDuration()),
    };
    clearInOutPoints();
  }

  return {
    selection,
    inOutPoints,
    selectionDuration,
    hasInOutPoints,
    clipDuration,
    setSelection,
    moveSelection,
    resizeSelectionStart,
    resizeSelectionEnd,
    setSelectionFromPosition,
    setInPoint,
    setOutPoint,
    clearInPoint,
    clearOutPoint,
    clearInOutPoints,
    resetSelection,
  };
});
