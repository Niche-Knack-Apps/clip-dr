<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
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

// Get clips for this track (supports multi-clip tracks)
const trackClips = computed(() => tracksStore.getTrackClips(props.track.id));

// Format track duration
const formattedDuration = computed(() => {
  const d = props.track.duration;
  const mins = Math.floor(d / 60);
  const secs = Math.floor(d % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
});

let resizeObserver: ResizeObserver | null = null;

function updateWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
  }
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

  // Check if we've crossed the drag threshold
  if (!isClipDragging.value && Math.abs(deltaX) >= DRAG_THRESHOLD) {
    isClipDragging.value = true;
    emit('clipDragStart', props.track.id, draggingClipId.value);
  }

  // Only update position if actually dragging
  if (isClipDragging.value) {
    const deltaTime = (deltaX / containerWidth.value) * duration.value;
    const newStart = Math.max(0, clipDragOriginalStart.value + deltaTime);
    emit('clipDrag', props.track.id, draggingClipId.value, newStart);
  }
}

function handleClipDragEnd(event: MouseEvent) {
  const wasDragging = isClipDragging.value;
  const clipId = draggingClipId.value;

  if (wasDragging && clipId) {
    const deltaX = event.clientX - clipDragStartX.value;
    const deltaTime = (deltaX / containerWidth.value) * duration.value;
    const newStart = Math.max(0, clipDragOriginalStart.value + deltaTime);
    emit('clipDragEnd', props.track.id, clipId, newStart);
  }
  // If not dragging (threshold not reached), the click event on parent will handle selection

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
  <div
    :class="[
      'flex border-b transition-colors',
      isSelected
        ? 'bg-track-active border-l-2 ring-1 ring-inset ring-opacity-30 border-gray-800'
        : 'bg-track-bg hover:bg-track-hover border-gray-800',
    ]"
    :style="{
      height: `${TRACK_HEIGHT}px`,
      borderLeftColor: isSelected ? track.color : undefined,
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
              track.muted
                ? 'bg-red-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
            ]"
            title="Mute"
            @click.stop="emit('toggleMute', track.id)"
          >
            M
          </button>

          <button
            type="button"
            :class="[
              'w-5 h-5 text-[10px] font-bold rounded transition-colors',
              track.solo
                ? 'bg-yellow-500 text-gray-900'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
            ]"
            title="Solo"
            @click.stop="emit('toggleSolo', track.id)"
          >
            S
          </button>

          <button
            type="button"
            class="w-5 h-5 text-[10px] font-bold rounded bg-gray-700 text-gray-400 hover:bg-green-600 hover:text-white transition-colors"
            title="Export"
            @click.stop="emit('export', track.id)"
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
      <!-- Render each clip in the track -->
      <ClipRegion
        v-for="clip in trackClips"
        :key="clip.id"
        :track="track"
        :clip="clip"
        :container-width="containerWidth"
        :duration="duration"
        :is-dragging="isClipDragging"
        :dragging-clip-id="draggingClipId"
        @drag-start="handleClipDragStart"
      />

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
