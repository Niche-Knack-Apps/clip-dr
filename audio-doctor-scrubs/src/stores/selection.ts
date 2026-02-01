import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useCleaningStore } from './cleaning';
import { useSilenceStore } from './silence';
import type { Selection, InOutPoints } from '@/shared/types';
import { DEFAULT_SELECTION_DURATION, MIN_SELECTION_DURATION } from '@/shared/constants';
import { clamp } from '@/shared/utils';

export const useSelectionStore = defineStore('selection', () => {
  const audioStore = useAudioStore();

  // Helper to get effective duration (from soloed processed track or full duration)
  function getEffectiveDuration(): number {
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();
    const silenceStore = useSilenceStore();

    const soloedClip = tracksStore.clipTracks.find(t => t.solo);
    if (soloedClip) {
      const hasProcessedAudio = cleaningStore.hasCleanedAudio(soloedClip.id) ||
                                silenceStore.hasCutAudio(soloedClip.id);
      if (hasProcessedAudio) {
        return soloedClip.end; // Track end IS the duration for processed tracks
      }
    }
    return audioStore.duration;
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
    inOutPoints.value.inPoint = clamp(time, 0, getEffectiveDuration());
    if (inOutPoints.value.outPoint !== null && inOutPoints.value.outPoint < time) {
      inOutPoints.value.outPoint = null;
    }
  }

  function setOutPoint(time: number): void {
    inOutPoints.value.outPoint = clamp(time, 0, getEffectiveDuration());
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
