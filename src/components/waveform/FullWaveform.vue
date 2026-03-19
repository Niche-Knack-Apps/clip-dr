<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import WaveformCanvas from './WaveformCanvas.vue';
import SelectionWindow from './SelectionWindow.vue';
import SilenceOverlay from './SilenceOverlay.vue';
import Playhead from './Playhead.vue';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import { useSilenceStore } from '@/stores/silence';
import { useTracksStore } from '@/stores/tracks';
import { useUIStore } from '@/stores/ui';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useTimemarkInteraction } from '@/composables/useTimemarkInteraction';
import { formatTime } from '@/shared/utils';
import { WAVEFORM_HEIGHT } from '@/shared/constants';

interface Props {
  height?: number;
}

const props = withDefaults(defineProps<Props>(), {
  height: WAVEFORM_HEIGHT,
});

const { effectiveDuration } = useEffectiveAudio();
const playbackStore = usePlaybackStore();
const selectionStore = useSelectionStore();
const settingsStore = useSettingsStore();
const silenceStore = useSilenceStore();
const tracksStore = useTracksStore();
const uiStore = useUIStore();

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);
const containerLeft = ref(0);

const duration = effectiveDuration;

// Timemark interaction (context menu + drag) — shared composable
const {
  contextMenu,
  timemarkDrag,
  handleContextMenu,
  handleTimemarkContextMenu,
  handleDeleteMarker,
  handleTimemarkDragStart,
} = useTimemarkInteraction(
  containerRef,
  () => ({ start: 0, end: duration.value }),
);
const currentTime = computed(() => playbackStore.currentTime);
const selection = computed(() => selectionStore.selection);
const waveformColor = computed(() => settingsStore.settings.waveformColor);
const selectionColor = computed(() => settingsStore.settings.selectionColor);
const playheadColor = computed(() => settingsStore.settings.playheadColor);

// In/Out point markers on full waveform
const inPoint = computed(() => selectionStore.inOutPoints.inPoint);
const outPoint = computed(() => selectionStore.inOutPoints.outPoint);

function timeToPixel(time: number): number {
  const dur = duration.value;
  if (dur <= 0 || containerWidth.value <= 0) return 0;
  return (time / dur) * containerWidth.value;
}

// All timemarks from audible tracks with pixel positions (full timeline: 0 to duration).
// Markers follow track audibility: if any track is solo'd, only show markers for solo'd tracks;
// otherwise hide markers for muted tracks. This ensures markers represent content the user can hear.
const allTimemarks = computed(() => {
  const dur = duration.value;
  if (dur <= 0 || containerWidth.value <= 0) return [];
  const hasSolo = tracksStore.tracks.some(t => t.solo);
  const marks: { id: string; trackId: string; label: string; color: string; pixelLeft: number; time: number; trackStart: number }[] = [];
  for (const track of tracksStore.tracks) {
    if (!track.timemarks) continue;
    if (track.importStatus === 'importing' || track.importStatus === 'decoding') continue;
    if (hasSolo && !track.solo) continue;
    if (!hasSolo && track.muted) continue;
    for (const mark of track.timemarks) {
      const absTime = track.trackStart + mark.time;
      marks.push({
        id: mark.id,
        trackId: track.id,
        label: mark.label,
        color: mark.color || (mark.source === 'manual' ? '#00d4ff' : '#fbbf24'),
        pixelLeft: (absTime / dur) * containerWidth.value,
        time: mark.time,
        trackStart: track.trackStart,
      });
    }
  }
  return marks;
});

function handleTimemarkClick(trackStart: number, time: number) {
  playbackStore.seek(trackStart + time);
}

// Zoom constraints (same as ZoomedWaveform)
const MIN_ZOOM_DURATION = 0.5;
const ZOOM_FACTOR = 0.15;

// Scroll wheel zoom handler - resizes selection window (same behavior as Panel 2)
function handleWheel(event: WheelEvent) {
  event.preventDefault();

  const dur = duration.value;
  if (dur <= 0) return;

  const rect = containerRef.value?.getBoundingClientRect();
  if (!rect) return;

  const currentDuration = selection.value.end - selection.value.start;
  const maxDuration = dur;

  // Scroll up = zoom in, scroll down = zoom out
  const zoomIn = event.deltaY < 0;
  const factor = zoomIn ? (1 - ZOOM_FACTOR) : (1 + ZOOM_FACTOR);

  let newDuration = currentDuration * factor;
  newDuration = Math.max(MIN_ZOOM_DURATION, Math.min(maxDuration, newDuration));

  if (newDuration === currentDuration) return;

  // Map mouse X to time on the full timeline (not the selection)
  const timeUnderMouse = ((event.clientX - rect.left) / rect.width) * dur;

  // Calculate the ratio of where the mouse is in the current selection view
  const mouseRatio = (timeUnderMouse - selection.value.start) / currentDuration;

  // Calculate new start/end keeping the mouse position stable
  let newStart = timeUnderMouse - (mouseRatio * newDuration);
  let newEnd = newStart + newDuration;

  // Clamp to audio bounds
  if (newStart < 0) {
    newStart = 0;
    newEnd = newDuration;
  }
  if (newEnd > dur) {
    newEnd = dur;
    newStart = Math.max(0, dur - newDuration);
  }

  selectionStore.setSelection(newStart, newEnd);
}

// Drag-to-pan state (for the grip bar above the waveform)
const isDragPanning = ref(false);
let dragLastX = 0;
let dragRafId: number | null = null;
let pendingDragEvent: MouseEvent | Touch | null = null;

function handleDragBarMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  isDragPanning.value = true;
  dragLastX = event.clientX;
  document.addEventListener('mousemove', handleDragBarMouseMove);
  document.addEventListener('mouseup', handleDragBarMouseUp);
}

function handleDragBarMouseMove(event: MouseEvent) {
  pendingDragEvent = event;
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDragMove);
  }
}

function flushDragMove() {
  dragRafId = null;
  const event = pendingDragEvent;
  if (!event) return;
  pendingDragEvent = null;

  const deltaX = event.clientX - dragLastX;
  dragLastX = event.clientX;
  const dur = duration.value;
  if (dur <= 0 || containerWidth.value <= 0) return;
  const deltaTime = deltaX / (containerWidth.value / dur);
  selectionStore.moveSelection(deltaTime);
}

function handleDragBarMouseUp() {
  if (pendingDragEvent) flushDragMove();
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  isDragPanning.value = false;
  document.removeEventListener('mousemove', handleDragBarMouseMove);
  document.removeEventListener('mouseup', handleDragBarMouseUp);
}

function handleDragBarTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) return;
  isDragPanning.value = true;
  dragLastX = event.touches[0].clientX;
  document.addEventListener('touchmove', handleDragBarTouchMove, { passive: false });
  document.addEventListener('touchend', handleDragBarTouchEnd);
}

function handleDragBarTouchMove(event: TouchEvent) {
  event.preventDefault();
  if (event.touches.length !== 1) return;
  pendingDragEvent = event.touches[0];
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDragMove);
  }
}

function handleDragBarTouchEnd() {
  if (pendingDragEvent) flushDragMove();
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  isDragPanning.value = false;
  document.removeEventListener('touchmove', handleDragBarTouchMove);
  document.removeEventListener('touchend', handleDragBarTouchEnd);
}

let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;

function updateWidth() {
  if (containerRef.value) {
    const rect = containerRef.value.getBoundingClientRect();
    containerWidth.value = rect.width;
    containerLeft.value = rect.left;
  }
}

function handleResize() {
  if (resizeRafId !== null) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    updateWidth();
  });
}

function handleWaveformClick(event: MouseEvent) {
  if (event.button !== 0) return;
  const rect = containerRef.value?.getBoundingClientRect();
  if (!rect || duration.value <= 0) return;
  const time = ((event.clientX - rect.left) / rect.width) * duration.value;
  playbackStore.seek(Math.max(0, Math.min(duration.value, time)));
}

function handlePlayheadDrag(time: number) {
  playbackStore.scrub(time);
}

function handleMove(delta: number) {
  selectionStore.moveSelection(delta);
}

function handleResizeStart(newStart: number) {
  selectionStore.resizeSelectionStart(newStart);
}

function handleResizeEnd(newEnd: number) {
  selectionStore.resizeSelectionEnd(newEnd);
}

// Aggregate silence regions from ALL tracks (each tagged with its trackId for edit ops)
const allSilenceRegions = computed(() => {
  const result: { trackId: string; region: ReturnType<typeof silenceStore.getRegionsForTrack>[number] }[] = [];
  for (const track of tracksStore.tracks) {
    for (const region of silenceStore.getRegionsForTrack(track.id)) {
      result.push({ trackId: track.id, region });
    }
  }
  return result;
});

// Resolve trackId for a silence region by looking it up in the aggregated list
function findTrackForRegion(regionId: string): string {
  return allSilenceRegions.value.find(r => r.region.id === regionId)?.trackId ?? '';
}

function handleSilenceResize(id: string, updates: { start?: number; end?: number }) {
  silenceStore.updateRegion(findTrackForRegion(id), id, updates);
}

function handleSilenceMove(id: string, delta: number) {
  silenceStore.moveRegion(findTrackForRegion(id), id, delta);
}

function handleSilenceDelete(id: string) {
  silenceStore.deleteRegion(findTrackForRegion(id), id);
}

function handleSilenceRestore(id: string) {
  silenceStore.restoreRegion(findTrackForRegion(id), id);
}

onMounted(() => {
  updateWidth();

  resizeObserver = new ResizeObserver(handleResize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
  }
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
  }
  document.removeEventListener('mousemove', handleDragBarMouseMove);
  document.removeEventListener('mouseup', handleDragBarMouseUp);
  document.removeEventListener('touchmove', handleDragBarTouchMove);
  document.removeEventListener('touchend', handleDragBarTouchEnd);
});
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <span class="text-xs text-gray-400">Full Waveform</span>
      <span class="text-xs text-gray-500 font-mono">{{ formatTime(duration, settingsStore.settings.timeFormat) }}</span>
    </div>

    <!-- Drag strip to pan zoom window -->
    <div
      class="h-5 flex items-center justify-center select-none bg-gray-800"
      :class="isDragPanning ? 'cursor-grabbing bg-cyan-800/40' : 'cursor-ew-resize hover:bg-cyan-900/30'"
      @mousedown="handleDragBarMouseDown"
      @touchstart.passive="handleDragBarTouchStart"
    >
      <div class="flex items-center gap-0.5 text-gray-600 hover:text-gray-400 transition-colors">
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M15 19l-7-7 7-7" /></svg>
        <div class="w-4 h-1 rounded-full bg-current" />
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7" /></svg>
      </div>
    </div>

    <div
      ref="containerRef"
      class="relative"
      :style="{ height: `${props.height}px` }"
      @click="handleWaveformClick"
      @wheel.prevent="handleWheel"
      @contextmenu.prevent="handleContextMenu"
    >
      <WaveformCanvas
        :start-time="0"
        :end-time="duration"
        :color="waveformColor"
        :height="props.height"
      />

      <!-- Silence region overlays (z-10 to stay above waveform but below selection) -->
      <SilenceOverlay
        v-for="{ region } in allSilenceRegions"
        :key="region.id"
        :region="region"
        :container-width="containerWidth"
        :start-time="0"
        :end-time="duration"
        class="z-10"
        @resize="handleSilenceResize"
        @move="handleSilenceMove"
        @delete="handleSilenceDelete"
        @restore="handleSilenceRestore"
      />

      <SelectionWindow
        :start="selection.start"
        :end="selection.end"
        :container-width="containerWidth"
        :container-left="containerLeft"
        :duration="duration"
        :color="selectionColor"
        @move="handleMove"
        @resize-start="handleResizeStart"
        @resize-end="handleResizeEnd"
      />

      <!-- Ghost trim-edge line (visible during active trim) -->
      <div
        v-if="uiStore.activeTrimEdge"
        class="absolute top-0 bottom-0 w-px z-16 pointer-events-none"
        :style="{
          left: `${timeToPixel(uiStore.activeTrimEdge.time)}px`,
          backgroundColor: uiStore.activeTrimEdge.edge === 'left' ? 'rgba(0,212,255,0.4)' : 'rgba(255,100,100,0.4)',
        }"
      />

      <!-- In/Out point markers on full waveform -->
      <div
        v-if="inPoint !== null"
        class="absolute top-0 bottom-0 w-px bg-emerald-400 z-12 pointer-events-none"
        :style="{ left: `${timeToPixel(inPoint)}px` }"
      >
        <div class="absolute -top-0.5 -left-1 text-[8px] font-bold text-emerald-400">I</div>
      </div>
      <div
        v-if="outPoint !== null"
        class="absolute top-0 bottom-0 w-px bg-red-400 z-12 pointer-events-none"
        :style="{ left: `${timeToPixel(outPoint)}px` }"
      >
        <div class="absolute -top-0.5 -left-1.5 text-[8px] font-bold text-red-400">O</div>
      </div>
      <!-- I/O region highlight -->
      <div
        v-if="inPoint !== null && outPoint !== null"
        class="absolute top-0 bottom-0 bg-white/5 z-11 pointer-events-none"
        :style="{
          left: `${timeToPixel(inPoint)}px`,
          width: `${timeToPixel(outPoint) - timeToPixel(inPoint)}px`,
        }"
      />

      <!-- Timemark indicators (hidden during clip drag/trim, draggable + right-click to delete) -->
      <div
        v-for="mark in allTimemarks"
        v-show="!uiStore.isClipDragActive"
        :key="mark.id"
        class="absolute top-0 bottom-0 z-15 cursor-grab group/tm"
        :class="{ 'cursor-grabbing': timemarkDrag?.markId === mark.id, 'tm-highlighted': uiStore.hoveredTimemarkId === mark.id }"
        :style="{ left: `${mark.pixelLeft - 4}px`, width: '9px' }"
        :title="mark.label"
        @mousedown="handleTimemarkDragStart($event, mark.trackId, mark.id, mark.time)"
        @mouseenter="uiStore.setHoveredTimemark(mark.id)"
        @mouseleave="uiStore.clearHoveredTimemark()"
        @click.stop="handleTimemarkClick(mark.trackStart, mark.time)"
        @contextmenu.prevent.stop="handleTimemarkContextMenu($event, mark.trackId, mark.id)"
      >
        <div
          class="absolute top-0 left-0"
          :style="{
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: `8px solid ${mark.color}`,
          }"
        />
        <div
          class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-gray-900 border border-gray-700 rounded text-[9px] text-gray-200 whitespace-nowrap pointer-events-none transition-opacity z-20"
          :class="uiStore.hoveredTimemarkId === mark.id ? 'opacity-100' : 'opacity-0 group-hover/tm:opacity-100'"
        >
          {{ mark.label }}
        </div>
      </div>

      <Playhead
        :position="currentTime"
        :container-width="containerWidth"
        :start-time="0"
        :end-time="duration"
        :color="playheadColor"
        :draggable="true"
        @drag-start="playbackStore.startScrubbing()"
        @drag="handlePlayheadDrag"
        @drag-end="playbackStore.endScrubbing()"
        @click="(time) => playbackStore.seek(time)"
      />

      <!-- Time markers -->
      <div class="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-1 text-[10px] text-gray-500 font-mono">
        <span>0:00</span>
        <span>{{ formatTime(duration / 4, settingsStore.settings.timeFormat) }}</span>
        <span>{{ formatTime(duration / 2, settingsStore.settings.timeFormat) }}</span>
        <span>{{ formatTime((duration * 3) / 4, settingsStore.settings.timeFormat) }}</span>
        <span>{{ formatTime(duration, settingsStore.settings.timeFormat) }}</span>
      </div>
    </div>

    <!-- Context menu for marker deletion -->
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="fixed z-50 bg-gray-800 border border-gray-600 rounded shadow-lg py-1 min-w-[140px]"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
      >
        <button
          class="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
          @click="handleDeleteMarker"
        >
          Delete marker
        </button>
      </div>
    </Teleport>
  </div>
</template>
