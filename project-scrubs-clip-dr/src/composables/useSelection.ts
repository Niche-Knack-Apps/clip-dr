import { computed } from 'vue';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';

export function useSelection() {
  const selectionStore = useSelectionStore();
  const playbackStore = usePlaybackStore();

  const selection = computed(() => selectionStore.selection);
  const selectionStart = computed(() => selectionStore.selection.start);
  const selectionEnd = computed(() => selectionStore.selection.end);
  const selectionDuration = computed(() => selectionStore.selectionDuration);

  const inPoint = computed(() => selectionStore.inOutPoints.inPoint);
  const outPoint = computed(() => selectionStore.inOutPoints.outPoint);
  const hasInOutPoints = computed(() => selectionStore.hasInOutPoints);
  const clipDuration = computed(() => selectionStore.clipDuration);

  function setSelection(start: number, end: number): void {
    selectionStore.setSelection(start, end);
  }

  function moveSelection(delta: number): void {
    selectionStore.moveSelection(delta);
  }

  function resizeStart(newStart: number): void {
    selectionStore.resizeSelectionStart(newStart);
  }

  function resizeEnd(newEnd: number): void {
    selectionStore.resizeSelectionEnd(newEnd);
  }

  function centerOnPosition(position: number, width?: number): void {
    selectionStore.setSelectionFromPosition(position, width);
  }

  function setInPoint(): void {
    selectionStore.setInPoint(playbackStore.currentTime);
  }

  function setOutPoint(): void {
    selectionStore.setOutPoint(playbackStore.currentTime);
  }

  function setInPointAt(time: number): void {
    selectionStore.setInPoint(time);
  }

  function setOutPointAt(time: number): void {
    selectionStore.setOutPoint(time);
  }

  function clearInOutPoints(): void {
    selectionStore.clearInOutPoints();
  }

  function resetSelection(): void {
    selectionStore.resetSelection();
  }

  return {
    selection,
    selectionStart,
    selectionEnd,
    selectionDuration,
    inPoint,
    outPoint,
    hasInOutPoints,
    clipDuration,
    setSelection,
    moveSelection,
    resizeStart,
    resizeEnd,
    centerOnPosition,
    setInPoint,
    setOutPoint,
    setInPointAt,
    setOutPointAt,
    clearInOutPoints,
    resetSelection,
  };
}
