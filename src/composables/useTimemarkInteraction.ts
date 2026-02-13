import { ref, onMounted, onUnmounted } from 'vue';
import { useHistoryStore } from '@/stores/history';
import { useTracksStore } from '@/stores/tracks';

export interface TimemarkDragState {
  trackId: string;
  markId: string;
  startX: number;
  startTime: number;
}

export function useTimemarkInteraction(
  containerRef: ReturnType<typeof ref<HTMLDivElement | null>>,
  /** Returns the time range visible in the waveform (used for pixel-to-time conversion) */
  getTimeRange: () => { start: number; end: number },
) {
  const tracksStore = useTracksStore();
  const historyStore = useHistoryStore();

  const contextMenu = ref<{ x: number; y: number; trackId: string; markId: string } | null>(null);
  const timemarkDrag = ref<TimemarkDragState | null>(null);

  // --- Context menu ---

  function handleContextMenu(event: MouseEvent) {
    contextMenu.value = null;

    if (!containerRef.value) return;
    const rect = containerRef.value.getBoundingClientRect();
    const { start, end } = getTimeRange();
    const range = end - start;
    if (range <= 0) return;

    const time = start + ((event.clientX - rect.left) / rect.width) * range;

    let targetTrack = tracksStore.selectedTrack;
    if (!targetTrack) {
      targetTrack = tracksStore.tracks.find(t =>
        time >= t.trackStart && time <= t.trackStart + t.duration
      ) ?? tracksStore.tracks[0] ?? null;
    }
    if (!targetTrack) return;

    const relativeTime = time - targetTrack.trackStart;
    if (relativeTime < 0 || relativeTime > targetTrack.duration) return;

    tracksStore.addTimemark(targetTrack.id, relativeTime, 'Manual mark');
  }

  function handleTimemarkContextMenu(event: MouseEvent, trackId: string, markId: string) {
    contextMenu.value = { x: event.clientX, y: event.clientY, trackId, markId };
  }

  function handleDeleteMarker() {
    if (!contextMenu.value) return;
    tracksStore.removeTrackTimemark(contextMenu.value.trackId, contextMenu.value.markId);
    contextMenu.value = null;
  }

  function dismissContextMenu() {
    contextMenu.value = null;
  }

  // --- Timemark drag ---

  function handleTimemarkDragStart(event: MouseEvent, trackId: string, markId: string, markTime: number) {
    if (event.button !== 0) return;
    event.stopPropagation();

    historyStore.pushState('Move marker');

    timemarkDrag.value = { trackId, markId, startX: event.clientX, startTime: markTime };

    document.addEventListener('mousemove', handleTimemarkDragMove);
    document.addEventListener('mouseup', handleTimemarkDragEnd);
  }

  function handleTimemarkDragMove(event: MouseEvent) {
    if (!timemarkDrag.value || !containerRef.value) return;

    const { start, end } = getTimeRange();
    const range = end - start;
    if (range <= 0) return;

    const rect = containerRef.value.getBoundingClientRect();
    const pixelDelta = event.clientX - timemarkDrag.value.startX;
    const timeDelta = (pixelDelta / rect.width) * range;
    const newTime = timemarkDrag.value.startTime + timeDelta;

    tracksStore.updateTimemarkTime(timemarkDrag.value.trackId, timemarkDrag.value.markId, newTime);
  }

  function handleTimemarkDragEnd() {
    timemarkDrag.value = null;
    document.removeEventListener('mousemove', handleTimemarkDragMove);
    document.removeEventListener('mouseup', handleTimemarkDragEnd);
  }

  // --- Global dismiss listeners ---

  function handleGlobalClick() {
    contextMenu.value = null;
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      contextMenu.value = null;
    }
  }

  onMounted(() => {
    document.addEventListener('click', handleGlobalClick);
    document.addEventListener('keydown', handleEscape);
  });

  onUnmounted(() => {
    document.removeEventListener('click', handleGlobalClick);
    document.removeEventListener('keydown', handleEscape);
    document.removeEventListener('mousemove', handleTimemarkDragMove);
    document.removeEventListener('mouseup', handleTimemarkDragEnd);
  });

  return {
    contextMenu,
    timemarkDrag,
    handleContextMenu,
    handleTimemarkContextMenu,
    handleDeleteMarker,
    dismissContextMenu,
    handleTimemarkDragStart,
  };
}
