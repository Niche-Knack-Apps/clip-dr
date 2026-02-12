<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import WaveformCanvas from './WaveformCanvas.vue';
import SilenceOverlay from './SilenceOverlay.vue';
import Playhead from './Playhead.vue';
import Toggle from '@/components/ui/Toggle.vue';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import { useSilenceStore } from '@/stores/silence';
import { useTracksStore } from '@/stores/tracks';
import { useUIStore } from '@/stores/ui';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { formatTime } from '@/shared/utils';
import { ZOOMED_HEIGHT } from '@/shared/constants';

interface Props {
  height?: number;
}

const props = withDefaults(defineProps<Props>(), {
  height: ZOOMED_HEIGHT,
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

// Drag state
type DragMode = 'none' | 'scrub' | 'select' | 'in' | 'out';
const dragMode = ref<DragMode>('none');
const dragStartTime = ref(0);
const dragStartX = ref(0);
const hasDragged = ref(false);

// rAF-based throttle for drag mousemove
let dragRafId: number | null = null;
let pendingDragEvent: MouseEvent | null = null;

// Minimum pixels moved to count as a drag vs click
const DRAG_THRESHOLD = 5;

// Zoom constraints
const MIN_ZOOM_DURATION = 0.5; // Minimum 0.5 seconds visible
const ZOOM_FACTOR = 0.15; // 15% zoom per scroll step

const selection = computed(() => selectionStore.selection);
const currentTime = computed(() => playbackStore.currentTime);

const inPoint = computed(() => selectionStore.inOutPoints.inPoint);
const outPoint = computed(() => selectionStore.inOutPoints.outPoint);

const waveformColor = computed(() => settingsStore.settings.waveformColor);
const playheadColor = computed(() => settingsStore.settings.playheadColor);
const followPlayhead = computed(() => uiStore.followPlayhead);

// Get silence regions visible in the current zoom range
const visibleSilenceRegions = computed(() =>
  silenceStore.getRegionsInRange(selection.value.start, selection.value.end)
);

// Timemarks visible in the current zoomed range
const visibleTimemarks = computed(() => {
  const start = selection.value.start;
  const end = selection.value.end;
  const range = end - start;
  if (range <= 0 || containerWidth.value <= 0) return [];
  const marks: { id: string; label: string; color: string; pixelLeft: number; time: number; trackStart: number }[] = [];
  for (const track of tracksStore.tracks) {
    if (!track.timemarks) continue;
    for (const mark of track.timemarks) {
      const absTime = track.trackStart + mark.time;
      if (absTime >= start && absTime <= end) {
        marks.push({
          id: mark.id,
          label: mark.label,
          color: mark.color || (mark.source === 'manual' ? '#00d4ff' : '#fbbf24'),
          pixelLeft: ((absTime - start) / range) * containerWidth.value,
          time: mark.time,
          trackStart: track.trackStart,
        });
      }
    }
  }
  return marks;
});

function handleTimemarkClick(trackStart: number, time: number) {
  playbackStore.seek(trackStart + time);
}

// Hit detection threshold in pixels
const MARKER_HIT_THRESHOLD = 10;

// Watch playhead and auto-scroll if follow mode is enabled (rAF-throttled)
let autoScrollRafId: number | null = null;

watch(currentTime, (time) => {
  if (!followPlayhead.value || !playbackStore.isPlaying) return;

  const viewStart = selection.value.start;
  const viewEnd = selection.value.end;

  if (time < viewStart || time > viewEnd) {
    // Coalesce: only schedule one scroll per frame
    if (autoScrollRafId === null) {
      autoScrollRafId = requestAnimationFrame(() => {
        autoScrollRafId = null;
        const t = currentTime.value;
        const vs = selection.value.start;
        const ve = selection.value.end;
        if (t < vs || t > ve) {
          const viewDuration = ve - vs;
          const newStart = Math.max(0, t - viewDuration * 0.25);
          const newEnd = Math.min(effectiveDuration.value, newStart + viewDuration);
          selectionStore.setSelection(
            newEnd - viewDuration < 0 ? 0 : newEnd - viewDuration,
            newEnd
          );
        }
      });
    }
  }
});

let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;

function updateWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
  }
}

function handleResize() {
  if (resizeRafId !== null) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    updateWidth();
  });
}

function timeToX(time: number): number {
  const range = selection.value.end - selection.value.start;
  if (range <= 0) return 0;
  return ((time - selection.value.start) / range) * containerWidth.value;
}

function xToTime(clientX: number): number {
  if (!containerRef.value) return selection.value.start;
  const rect = containerRef.value.getBoundingClientRect();
  const x = clientX - rect.left;
  const range = selection.value.end - selection.value.start;
  const time = (x / rect.width) * range + selection.value.start;
  return Math.max(selection.value.start, Math.min(time, selection.value.end));
}

function getClickTarget(clientX: number): DragMode {
  if (!containerRef.value) return 'select';
  const rect = containerRef.value.getBoundingClientRect();
  const x = clientX - rect.left;

  // Check if clicking near in point
  if (inPoint.value !== null) {
    const inX = timeToX(inPoint.value);
    if (Math.abs(x - inX) < MARKER_HIT_THRESHOLD) {
      return 'in';
    }
  }

  // Check if clicking near out point
  if (outPoint.value !== null) {
    const outX = timeToX(outPoint.value);
    if (Math.abs(x - outX) < MARKER_HIT_THRESHOLD) {
      return 'out';
    }
  }

  // Default to selection mode
  return 'select';
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;

  const target = getClickTarget(event.clientX);
  const time = xToTime(event.clientX);

  dragMode.value = target;
  dragStartTime.value = time;
  dragStartX.value = event.clientX;
  hasDragged.value = false;

  if (target === 'in' || target === 'out') {
    // Dragging a marker - update it immediately
    hasDragged.value = true; // Marker drags count as drags
    if (target === 'in') {
      selectionStore.setInPoint(time);
    } else {
      selectionStore.setOutPoint(time);
    }
  }
  // For 'select' mode, we wait to see if user actually drags before setting in/out

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  if (dragMode.value === 'none') return;

  const distanceMoved = Math.abs(event.clientX - dragStartX.value);

  // Threshold check must be synchronous to feel responsive
  if (!hasDragged.value && distanceMoved >= DRAG_THRESHOLD) {
    hasDragged.value = true;
    if (dragMode.value === 'select') {
      selectionStore.setInPoint(dragStartTime.value);
    }
  }

  if (!hasDragged.value) return;

  // Throttle the actual position updates to rAF rate
  pendingDragEvent = event;
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDragMove);
  }
}

function flushDragMove() {
  dragRafId = null;
  const event = pendingDragEvent;
  if (!event || dragMode.value === 'none') return;
  pendingDragEvent = null;

  const time = xToTime(event.clientX);

  if (dragMode.value === 'in') {
    if (outPoint.value !== null && time >= outPoint.value) {
      selectionStore.setInPoint(outPoint.value - 0.001);
    } else {
      selectionStore.setInPoint(time);
    }
  } else if (dragMode.value === 'out') {
    if (inPoint.value !== null && time <= inPoint.value) {
      selectionStore.setOutPoint(inPoint.value + 0.001);
    } else {
      selectionStore.setOutPoint(time);
    }
  } else if (dragMode.value === 'select') {
    if (time < dragStartTime.value) {
      selectionStore.setInPoint(time);
      selectionStore.setOutPoint(dragStartTime.value);
    } else {
      selectionStore.setInPoint(dragStartTime.value);
      selectionStore.setOutPoint(time);
    }
  }
}

function handleMouseUp(event: MouseEvent) {
  // Flush any pending drag
  if (pendingDragEvent) {
    flushDragMove();
  }
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }

  // If it was just a click (no drag) in select mode
  if (!hasDragged.value && dragMode.value === 'select') {
    const time = xToTime(event.clientX);
    const hasIOPoints = inPoint.value !== null && outPoint.value !== null;

    // Check if click is outside I/O region
    const isOutsideIO = hasIOPoints && (
      time < inPoint.value! || time > outPoint.value!
    );

    if (hasIOPoints && isOutsideIO) {
      // Click outside I/O points - clear them
      selectionStore.clearInOutPoints();
    } else {
      // Move playhead
      playbackStore.seek(time);
    }
  }

  dragMode.value = 'none';
  hasDragged.value = false;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}

// Scroll wheel zoom handler
function handleWheel(event: WheelEvent) {
  event.preventDefault();

  const duration = effectiveDuration.value;
  if (duration <= 0) return;

  const currentDuration = selection.value.end - selection.value.start;
  const maxDuration = duration;

  // Determine zoom direction: scroll up = zoom in, scroll down = zoom out
  const zoomIn = event.deltaY < 0;
  const factor = zoomIn ? (1 - ZOOM_FACTOR) : (1 + ZOOM_FACTOR);

  let newDuration = currentDuration * factor;

  // Clamp duration
  newDuration = Math.max(MIN_ZOOM_DURATION, Math.min(maxDuration, newDuration));

  // If duration didn't change, we're at a limit
  if (newDuration === currentDuration) return;

  // Get the time position under the mouse cursor
  const timeUnderMouse = xToTime(event.clientX);

  // Calculate the ratio of where the mouse is in the current view (0 to 1)
  const mouseRatio = (timeUnderMouse - selection.value.start) / currentDuration;

  // Calculate new start/end keeping the mouse position stable
  let newStart = timeUnderMouse - (mouseRatio * newDuration);
  let newEnd = newStart + newDuration;

  // Clamp to audio bounds
  if (newStart < 0) {
    newStart = 0;
    newEnd = newDuration;
  }
  if (newEnd > duration) {
    newEnd = duration;
    newStart = Math.max(0, duration - newDuration);
  }

  selectionStore.setSelection(newStart, newEnd);
}

// Marker drag handlers
function handleInMarkerMouseDown(event: MouseEvent) {
  event.stopPropagation();
  if (event.button !== 0) return;

  dragMode.value = 'in';
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleOutMarkerMouseDown(event: MouseEvent) {
  event.stopPropagation();
  if (event.button !== 0) return;

  dragMode.value = 'out';
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

// Silence overlay handlers
function handleSilenceResize(id: string, updates: { start?: number; end?: number }) {
  silenceStore.updateRegion(id, updates);
}

function handleSilenceMove(id: string, delta: number) {
  silenceStore.moveRegion(id, delta);
}

function handleSilenceDelete(id: string) {
  silenceStore.deleteRegion(id);
}

function handleSilenceRestore(id: string) {
  silenceStore.restoreRegion(id);
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
  if (autoScrollRafId !== null) {
    cancelAnimationFrame(autoScrollRafId);
  }
});
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <div class="flex items-center gap-3">
        <span class="text-xs text-gray-400">Zoomed View</span>
        <Toggle
          :model-value="followPlayhead"
          label="Follow"
          @update:model-value="uiStore.setFollowPlayhead"
        />
      </div>
      <div class="flex items-center gap-2 text-xs font-mono">
        <span class="text-gray-500">{{ formatTime(selection.start) }}</span>
        <span class="text-gray-600">-</span>
        <span class="text-gray-500">{{ formatTime(selection.end) }}</span>
      </div>
    </div>

    <div
      ref="containerRef"
      class="relative cursor-ew-resize"
      :style="{ height: `${props.height}px` }"
      @mousedown="handleMouseDown"
      @wheel.prevent="handleWheel"
    >
      <WaveformCanvas
        :start-time="selection.start"
        :end-time="selection.end"
        :color="waveformColor"
        :height="props.height"
      />

      <!-- Silence region overlays (z-index below markers) -->
      <SilenceOverlay
        v-for="region in visibleSilenceRegions"
        :key="region.id"
        :region="region"
        :container-width="containerWidth"
        :start-time="selection.start"
        :end-time="selection.end"
        class="z-10"
        @resize="handleSilenceResize"
        @move="handleSilenceMove"
        @delete="handleSilenceDelete"
        @restore="handleSilenceRestore"
      />

      <!-- Timemark indicators -->
      <div
        v-for="mark in visibleTimemarks"
        :key="mark.id"
        class="absolute top-0 bottom-0 z-10 cursor-pointer group/tm"
        :style="{ left: `${mark.pixelLeft - 4}px`, width: '9px' }"
        :title="mark.label"
        @click.stop="handleTimemarkClick(mark.trackStart, mark.time)"
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
        <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-gray-900 border border-gray-700 rounded text-[9px] text-gray-200 whitespace-nowrap opacity-0 group-hover/tm:opacity-100 pointer-events-none transition-opacity z-20">
          {{ mark.label }}
        </div>
      </div>

      <!-- In point marker (draggable) -->
      <div
        v-if="inPoint !== null && inPoint >= selection.start && inPoint <= selection.end"
        class="absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize z-20 group"
        :style="{ left: `${timeToX(inPoint)}px` }"
        @mousedown="handleInMarkerMouseDown"
      >
        <!-- Timestamp badge (visible on hover or drag) -->
        <div
          :class="[
            'absolute left-1/2 -translate-x-1/2 top-1 px-1.5 py-0.5 bg-green-600 text-white text-[10px] font-mono rounded shadow-lg whitespace-nowrap transition-opacity pointer-events-none z-30',
            dragMode === 'in' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          ]"
        >
          {{ formatTime(inPoint) }}
        </div>
        <div class="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-0.5 bg-green-500 group-hover:w-1 transition-all" />
        <div class="absolute left-1/2 -translate-x-1/2 -top-1 w-3 h-3 bg-green-500 rounded-full group-hover:scale-125 transition-transform" />
        <span class="absolute top-6 left-3 text-[10px] text-green-500 font-mono pointer-events-none">IN</span>
      </div>

      <!-- Out point marker (draggable) -->
      <div
        v-if="outPoint !== null && outPoint >= selection.start && outPoint <= selection.end"
        class="absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize z-20 group"
        :style="{ left: `${timeToX(outPoint)}px` }"
        @mousedown="handleOutMarkerMouseDown"
      >
        <!-- Timestamp badge (visible on hover or drag) -->
        <div
          :class="[
            'absolute left-1/2 -translate-x-1/2 top-1 px-1.5 py-0.5 bg-red-600 text-white text-[10px] font-mono rounded shadow-lg whitespace-nowrap transition-opacity pointer-events-none z-30',
            dragMode === 'out' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          ]"
        >
          {{ formatTime(outPoint) }}
        </div>
        <div class="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-0.5 bg-red-500 group-hover:w-1 transition-all" />
        <div class="absolute left-1/2 -translate-x-1/2 -top-1 w-3 h-3 bg-red-500 rounded-full group-hover:scale-125 transition-transform" />
        <span class="absolute top-6 left-3 text-[10px] text-red-500 font-mono pointer-events-none">OUT</span>
      </div>

      <!-- In/Out region highlight -->
      <div
        v-if="inPoint !== null && outPoint !== null"
        class="absolute top-0 bottom-0 bg-waveform-clip/20 pointer-events-none"
        :style="{
          left: `${timeToX(Math.max(inPoint, selection.start))}px`,
          width: `${timeToX(Math.min(outPoint, selection.end)) - timeToX(Math.max(inPoint, selection.start))}px`,
        }"
      />

      <Playhead
        :position="currentTime"
        :container-width="containerWidth"
        :start-time="selection.start"
        :end-time="selection.end"
        :color="playheadColor"
        :draggable="true"
        @drag-start="playbackStore.startScrubbing()"
        @drag="(time) => playbackStore.scrub(time)"
        @drag-end="playbackStore.endScrubbing()"
      />

      <!-- Time markers -->
      <div class="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-1 text-[10px] text-gray-500 font-mono">
        <span>{{ formatTime(selection.start) }}</span>
        <span>{{ formatTime((selection.start + selection.end) / 2) }}</span>
        <span>{{ formatTime(selection.end) }}</span>
      </div>
    </div>
  </div>
</template>
