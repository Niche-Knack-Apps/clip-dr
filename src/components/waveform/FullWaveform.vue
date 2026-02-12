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
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
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

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);
const containerLeft = ref(0);

const duration = effectiveDuration;
const currentTime = computed(() => playbackStore.currentTime);
const selection = computed(() => selectionStore.selection);
const waveformColor = computed(() => settingsStore.settings.waveformColor);
const selectionColor = computed(() => settingsStore.settings.selectionColor);
const playheadColor = computed(() => settingsStore.settings.playheadColor);

// All timemarks from all tracks with pixel positions (full timeline: 0 to duration)
const allTimemarks = computed(() => {
  const dur = duration.value;
  if (dur <= 0 || containerWidth.value <= 0) return [];
  const marks: { id: string; label: string; color: string; pixelLeft: number; time: number; trackStart: number }[] = [];
  for (const track of tracksStore.tracks) {
    if (!track.timemarks) continue;
    for (const mark of track.timemarks) {
      const absTime = track.trackStart + mark.time;
      marks.push({
        id: mark.id,
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
});
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <span class="text-xs text-gray-400">Full Waveform</span>
      <span class="text-xs text-gray-500 font-mono">{{ formatTime(duration) }}</span>
    </div>

    <div
      ref="containerRef"
      class="relative"
      :style="{ height: `${props.height}px` }"
      @wheel.prevent="handleWheel"
    >
      <WaveformCanvas
        :start-time="0"
        :end-time="duration"
        :color="waveformColor"
        :height="props.height"
      />

      <!-- Silence region overlays (z-10 to stay above waveform but below selection) -->
      <SilenceOverlay
        v-for="region in silenceStore.silenceRegions"
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

      <!-- Timemark indicators -->
      <div
        v-for="mark in allTimemarks"
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
      />

      <!-- Time markers -->
      <div class="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-1 text-[10px] text-gray-500 font-mono">
        <span>0:00</span>
        <span>{{ formatTime(duration / 4) }}</span>
        <span>{{ formatTime(duration / 2) }}</span>
        <span>{{ formatTime((duration * 3) / 4) }}</span>
        <span>{{ formatTime(duration) }}</span>
      </div>
    </div>
  </div>
</template>
