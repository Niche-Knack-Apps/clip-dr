<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import ClipRegion from './ClipRegion.vue';
import Playhead from '@/components/waveform/Playhead.vue';
import Slider from '@/components/ui/Slider.vue';
import type { Track } from '@/shared/types';
import { usePlaybackStore } from '@/stores/playback';
import { useTracksStore } from '@/stores/tracks';
import { useUIStore } from '@/stores/ui';
import { TRACK_HEIGHT, TRACK_PANEL_MIN_WIDTH } from '@/shared/constants';

interface Props {
  track: Track;
  isSelected?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isSelected: false,
});

const emit = defineEmits<{
  select: [trackId: string];
  toggleMute: [trackId: string];
  toggleSolo: [trackId: string];
  delete: [trackId: string];
  export: [trackId: string];
  rename: [trackId: string, name: string];
  setVolume: [trackId: string, volume: number];
  clipDragStart: [trackId: string, clipId: string];
  clipDrag: [trackId: string, clipId: string, newClipStart: number];
  clipDragEnd: [trackId: string, clipId: string, newClipStart: number];
  clipSelect: [trackId: string, clipId: string];
}>();

const playbackStore = usePlaybackStore();
const tracksStore = useTracksStore();
const uiStore = useUIStore();
const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);

// Clip dragging state
const isClipDragging = ref(false);
const clipDragPending = ref(false);
const clipDragStartX = ref(0);
const clipDragOriginalStart = ref(0);
const draggingClipId = ref<string | null>(null);

// rAF-based throttle for clip drag mousemove
let clipDragRafId: number | null = null;
let pendingClipDragEvent: MouseEvent | null = null;

// rAF-based throttle for import waveform redraws
let waveformRafId: number | null = null;

// Minimum pixels to move before drag starts (to allow click-to-select)
const DRAG_THRESHOLD = 5;

// Rename state
const isEditing = ref(false);
const editName = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

// Use timeline duration for display
const duration = computed(() => tracksStore.timelineDuration);
const currentTime = computed(() => playbackStore.currentTime);
const panelWidth = computed(() => uiStore.trackPanelWidth);
const showVolumeSlider = computed(() => panelWidth.value > TRACK_PANEL_MIN_WIDTH + 40);

// Import state
const isImporting = computed(() => !!props.track.importStatus && props.track.importStatus !== 'ready');

// Combined progress: waveform (30% weight) + audio fetch/decode (70% weight)
const combinedProgress = computed(() => {
  if (!isImporting.value) return 1;
  const waveformProg = props.track.importProgress || 0;
  const decodeProg = props.track.importDecodeProgress || 0;
  return waveformProg * 0.3 + decodeProg * 0.7;
});
const importWaveformRef = ref<HTMLCanvasElement | null>(null);

// Get clips for this track (supports multi-clip tracks)
const trackClips = computed(() => tracksStore.getTrackClips(props.track.id));

// Track timemarks with pixel positions
const trackTimemarks = computed(() => {
  if (!props.track.timemarks || props.track.timemarks.length === 0 || duration.value <= 0) return [];
  return props.track.timemarks.map(mark => ({
    ...mark,
    // Time is relative to the recording; add trackStart for absolute timeline position
    pixelLeft: ((props.track.trackStart + mark.time) / duration.value) * containerWidth.value,
  }));
});

function handleTimemarkClick(time: number) {
  playbackStore.seek(props.track.trackStart + time);
}

function handleTimemarkDelete(markId: string) {
  tracksStore.removeTrackTimemark(props.track.id, markId);
}

// Format track duration
const formattedDuration = computed(() => {
  const d = props.track.duration;
  const mins = Math.floor(d / 60);
  const secs = Math.floor(d % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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

// Clip drag handlers - called from ClipRegion
function handleClipDragStart(clipId: string, event: MouseEvent) {
  if (event.button !== 0) return;

  // Find the clip being dragged to get its original position
  const clip = trackClips.value.find(c => c.id === clipId);
  if (!clip) return;

  // Don't start drag immediately - wait for threshold
  clipDragPending.value = true;
  isClipDragging.value = false;
  clipDragStartX.value = event.clientX;
  clipDragOriginalStart.value = clip.clipStart;
  draggingClipId.value = clipId;

  document.addEventListener('mousemove', handleClipDragMove);
  document.addEventListener('mouseup', handleClipDragEnd);
}

function handleClipDragMove(event: MouseEvent) {
  if (!clipDragPending.value && !isClipDragging.value) return;
  if (!containerRef.value || !draggingClipId.value) return;

  const deltaX = event.clientX - clipDragStartX.value;

  // Check if we've crossed the drag threshold (synchronous - don't defer)
  if (!isClipDragging.value && Math.abs(deltaX) >= DRAG_THRESHOLD) {
    isClipDragging.value = true;
    emit('clipDragStart', props.track.id, draggingClipId.value);
  }

  // Throttle position updates to rAF rate
  if (isClipDragging.value) {
    pendingClipDragEvent = event;
    if (clipDragRafId === null) {
      clipDragRafId = requestAnimationFrame(flushClipDrag);
    }
  }
}

function flushClipDrag() {
  clipDragRafId = null;
  if (pendingClipDragEvent && isClipDragging.value && draggingClipId.value) {
    const deltaX = pendingClipDragEvent.clientX - clipDragStartX.value;
    const deltaTime = (deltaX / containerWidth.value) * duration.value;
    const newStart = Math.max(0, clipDragOriginalStart.value + deltaTime);
    pendingClipDragEvent = null;
    emit('clipDrag', props.track.id, draggingClipId.value, newStart);
  }
}

function handleClipDragEnd(event: MouseEvent) {
  // Cancel any pending rAF
  if (clipDragRafId !== null) {
    cancelAnimationFrame(clipDragRafId);
    clipDragRafId = null;
  }
  pendingClipDragEvent = null;

  const wasDragging = isClipDragging.value;
  const clipId = draggingClipId.value;

  if (wasDragging && clipId) {
    const deltaX = event.clientX - clipDragStartX.value;
    const deltaTime = (deltaX / containerWidth.value) * duration.value;
    const newStart = Math.max(0, clipDragOriginalStart.value + deltaTime);
    emit('clipDragEnd', props.track.id, clipId, newStart);
  } else if (!wasDragging && clipId) {
    // Drag threshold not met - this was a click, select the clip
    emit('clipSelect', props.track.id, clipId);
  }

  clipDragPending.value = false;
  isClipDragging.value = false;
  draggingClipId.value = null;

  document.removeEventListener('mousemove', handleClipDragMove);
  document.removeEventListener('mouseup', handleClipDragEnd);
}

// Rename handlers
function startEditing() {
  isEditing.value = true;
  editName.value = props.track.name;
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function finishEditing() {
  if (isEditing.value && editName.value.trim()) {
    emit('rename', props.track.id, editName.value.trim());
  }
  isEditing.value = false;
}

function cancelEditing() {
  isEditing.value = false;
  editName.value = props.track.name;
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    finishEditing();
  } else if (event.key === 'Escape') {
    cancelEditing();
  }
}

// Volume handler
function handleVolumeChange(value: number) {
  emit('setVolume', props.track.id, value);
}

// Draw static waveform for importing tracks (progressive fill-in)
function drawImportWaveform() {
  const canvas = importWaveformRef.value;
  if (!canvas) return;
  const waveform = props.track.audioData.waveformData;
  if (!waveform || waveform.length === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const centerY = h / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = props.track.color + '80'; // 50% opacity

  const buckets = waveform.length / 2;
  const pxPerBucket = w / buckets;

  for (let i = 0; i < buckets; i++) {
    const min = waveform[i * 2];
    const max = waveform[i * 2 + 1];
    if (min === 0 && max === 0) continue;

    const x = i * pxPerBucket;
    const minY = centerY - max * centerY;
    const maxY = centerY - min * centerY;
    ctx.fillRect(x, minY, Math.max(1, pxPerBucket), maxY - minY);
  }
}

// Debounce waveform redraws — multiple chunk arrivals in one frame only trigger one draw
function scheduleWaveformRedraw() {
  if (waveformRafId !== null) return; // already scheduled
  waveformRafId = requestAnimationFrame(() => {
    waveformRafId = null;
    drawImportWaveform();
  });
}

watch(
  () => [props.track.audioData.waveformData, containerWidth.value, isImporting.value],
  () => {
    if (isImporting.value) {
      scheduleWaveformRedraw();
    }
  },
  { deep: false }
);

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
  if (clipDragRafId !== null) {
    cancelAnimationFrame(clipDragRafId);
  }
  if (waveformRafId !== null) {
    cancelAnimationFrame(waveformRafId);
  }
});
</script>

<template>
  <div
    :class="[
      'flex border-b border-l-2 transition-colors',
      isSelected
        ? 'bg-track-active ring-1 ring-inset ring-opacity-30 border-gray-800'
        : 'bg-track-bg hover:bg-track-hover border-gray-800',
    ]"
    :style="{
      height: `${TRACK_HEIGHT}px`,
      borderLeftColor: isSelected ? track.color : 'transparent',
      '--ring-color': isSelected ? track.color : undefined,
    }"
    @click="emit('select', track.id)"
  >
    <!-- Track controls (resizable) -->
    <div
      class="flex flex-col gap-0.5 px-2 py-1 border-r border-gray-800 shrink-0 overflow-hidden"
      :style="{ width: `${panelWidth}px` }"
    >
      <!-- Top row: drag handle, name and duration -->
      <div class="flex items-center gap-1 min-w-0">
        <!-- Drag handle -->
        <div
          class="drag-handle shrink-0 cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 transition-colors"
          title="Drag to reorder"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8-12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>
          </svg>
        </div>

        <!-- Color indicator -->
        <div
          class="w-2 h-2 rounded-full shrink-0"
          :style="{ backgroundColor: track.color }"
        />

        <div class="flex-1 min-w-0">
          <!-- Editable name -->
          <input
            v-if="isEditing"
            ref="inputRef"
            v-model="editName"
            type="text"
            class="w-full text-xs font-medium text-gray-200 bg-gray-700 border border-cyan-500 rounded px-1 py-0 outline-none"
            @blur="finishEditing"
            @keydown="handleKeyDown"
            @click.stop
          />
          <div
            v-else
            class="text-xs font-medium text-gray-200 truncate cursor-text"
            title="Double-click to rename"
            @dblclick.stop="startEditing"
          >
            {{ track.name }}
          </div>
          <div class="text-[10px] text-gray-500">
            {{ formattedDuration }}
          </div>
        </div>

        <!-- Control buttons -->
        <div class="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            :class="[
              'w-5 h-5 text-[10px] font-bold rounded transition-colors',
              isImporting
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : track.muted
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
            ]"
            title="Mute"
            :disabled="isImporting"
            @click.stop="!isImporting && emit('toggleMute', track.id)"
          >
            M
          </button>

          <button
            type="button"
            :class="[
              'w-5 h-5 text-[10px] font-bold rounded transition-colors',
              isImporting
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : track.solo
                  ? 'bg-yellow-500 text-gray-900'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
            ]"
            title="Solo"
            :disabled="isImporting"
            @click.stop="!isImporting && emit('toggleSolo', track.id)"
          >
            S
          </button>

          <button
            type="button"
            :class="[
              'w-5 h-5 text-[10px] font-bold rounded transition-colors',
              isImporting
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-gray-700 text-gray-400 hover:bg-green-600 hover:text-white',
            ]"
            title="Export"
            :disabled="isImporting"
            @click.stop="!isImporting && emit('export', track.id)"
          >
            E
          </button>

          <button
            type="button"
            class="w-5 h-5 text-[10px] font-bold rounded bg-gray-700 text-gray-400 hover:bg-red-600 hover:text-white transition-colors"
            title="Delete"
            @click.stop="emit('delete', track.id)"
          >
            X
          </button>
        </div>
      </div>

      <!-- Bottom row: volume slider (only when expanded) -->
      <div
        v-if="showVolumeSlider"
        class="flex items-center gap-1 mt-auto"
        @mousedown.stop
        @dragstart.prevent
      >
        <svg class="w-3 h-3 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <Slider
          :model-value="track.volume"
          :min="0"
          :max="1"
          :step="0.01"
          class="flex-1"
          @update:model-value="handleVolumeChange"
        />
        <span class="text-[9px] text-gray-500 w-6 text-right">{{ Math.round(track.volume * 100) }}%</span>
      </div>
    </div>

    <!-- Track timeline -->
    <div
      ref="containerRef"
      class="flex-1 relative"
    >
      <!-- Static waveform for importing tracks (progressive fill-in) -->
      <canvas
        v-if="isImporting && track.audioData.waveformData.length > 0"
        ref="importWaveformRef"
        class="absolute inset-0 w-full h-full"
        :width="containerWidth"
        :height="TRACK_HEIGHT"
      />

      <!-- Import progress bar — visible bar moving toward loaded -->
      <div v-if="isImporting" class="absolute inset-0 z-10 pointer-events-none">
        <!-- Dim overlay to push waveform back so progress bar stands out -->
        <div class="absolute inset-0 bg-gray-900/70" />
        <!-- Progress bar at bottom -->
        <div class="absolute bottom-0 left-0 right-0 h-2 bg-gray-700/80 overflow-hidden">
          <div
            class="h-full bg-emerald-400 transition-all duration-300 ease-out"
            :style="{ width: `${combinedProgress * 100}%` }"
          />
          <!-- Shimmer pulse at leading edge -->
          <div
            class="absolute top-0 h-full w-16 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"
            :style="{ left: `${Math.max(0, combinedProgress * 100 - 8)}%` }"
          />
        </div>
      </div>

      <!-- Render each clip in the track (only when not importing) -->
      <ClipRegion
        v-for="clip in trackClips"
        :key="clip.id"
        :track="track"
        :clip="clip"
        :container-width="containerWidth"
        :duration="duration"
        :is-dragging="isClipDragging"
        :dragging-clip-id="draggingClipId"
        :is-selected="clip.id === tracksStore.selectedClipId"
        @drag-start="handleClipDragStart"
      />

      <!-- Timemark indicators -->
      <div
        v-for="mark in trackTimemarks"
        :key="mark.id"
        class="absolute top-0 bottom-0 z-10 cursor-pointer group/tm"
        :style="{ left: `${mark.pixelLeft - 4}px`, width: '9px' }"
        :title="mark.label"
        @click.stop="handleTimemarkClick(mark.time)"
        @contextmenu.prevent.stop="handleTimemarkDelete(mark.id)"
      >
        <!-- Triangle flag at top -->
        <div
          class="absolute top-0 left-0"
          :style="{
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: `8px solid ${mark.color || (mark.source === 'manual' ? '#00d4ff' : '#fbbf24')}`,
          }"
        />
        <!-- Tooltip on hover -->
        <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-gray-900 border border-gray-700 rounded text-[9px] text-gray-200 whitespace-nowrap opacity-0 group-hover/tm:opacity-100 pointer-events-none transition-opacity z-20">
          {{ mark.label }}
          <span class="text-gray-500 ml-1">(right-click to delete)</span>
        </div>
      </div>

      <Playhead
        :position="currentTime"
        :container-width="containerWidth"
        :start-time="0"
        :end-time="duration"
        color="#ff3366"
        :draggable="true"
        @drag-start="playbackStore.startScrubbing()"
        @drag="(time) => playbackStore.scrub(time)"
        @drag-end="playbackStore.endScrubbing()"
      />
    </div>
  </div>
</template>
