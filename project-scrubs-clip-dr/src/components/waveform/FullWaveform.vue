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

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);
const containerLeft = ref(0);

const duration = effectiveDuration;
const currentTime = computed(() => playbackStore.currentTime);
const selection = computed(() => selectionStore.selection);
const waveformColor = computed(() => settingsStore.settings.waveformColor);
const selectionColor = computed(() => settingsStore.settings.selectionColor);
const playheadColor = computed(() => settingsStore.settings.playheadColor);

// Zoom constraints (same as ZoomedWaveform)
const MIN_ZOOM_DURATION = 0.5;
const MAX_ZOOM_DURATION = 60;
const ZOOM_FACTOR = 0.15;

// Scroll wheel zoom handler - resizes selection window (same behavior as Panel 2)
function handleWheel(event: WheelEvent) {
  event.preventDefault();

  const dur = duration.value;
  if (dur <= 0) return;

  const rect = containerRef.value?.getBoundingClientRect();
  if (!rect) return;

  const currentDuration = selection.value.end - selection.value.start;
  const maxDuration = Math.min(MAX_ZOOM_DURATION, dur);

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

function updateWidth() {
  if (containerRef.value) {
    const rect = containerRef.value.getBoundingClientRect();
    containerWidth.value = rect.width;
    containerLeft.value = rect.left;
  }
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

  resizeObserver = new ResizeObserver(updateWidth);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
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
