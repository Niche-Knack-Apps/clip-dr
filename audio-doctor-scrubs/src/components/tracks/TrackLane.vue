<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import ClipRegion from './ClipRegion.vue';
import Playhead from '@/components/waveform/Playhead.vue';
import Slider from '@/components/ui/Slider.vue';
import type { Track } from '@/shared/types';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
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
}>();

const audioStore = useAudioStore();
const playbackStore = usePlaybackStore();
const uiStore = useUIStore();
const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);
const isScrubbing = ref(false);

// Rename state
const isEditing = ref(false);
const editName = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

const duration = computed(() => audioStore.duration);
const currentTime = computed(() => playbackStore.currentTime);
const panelWidth = computed(() => uiStore.trackPanelWidth);
const showVolumeSlider = computed(() => panelWidth.value > TRACK_PANEL_MIN_WIDTH + 40);

let resizeObserver: ResizeObserver | null = null;

function updateWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
  }
}

function xToTime(x: number): number {
  return (x / containerWidth.value) * duration.value;
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  if (!containerRef.value) return;

  isScrubbing.value = true;
  playbackStore.startScrubbing();

  const rect = containerRef.value.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const time = xToTime(x);
  playbackStore.scrub(time);

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  if (!isScrubbing.value || !containerRef.value) return;

  const rect = containerRef.value.getBoundingClientRect();
  const x = Math.max(0, Math.min(event.clientX - rect.left, containerWidth.value));
  const time = xToTime(x);
  playbackStore.scrub(time);
}

function handleMouseUp() {
  isScrubbing.value = false;
  playbackStore.endScrubbing();

  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
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
      'flex border-b border-gray-800 transition-colors',
      isSelected ? 'bg-track-active' : 'bg-track-bg hover:bg-track-hover',
    ]"
    :style="{ height: `${TRACK_HEIGHT}px` }"
    @click="emit('select', track.id)"
  >
    <!-- Track controls (resizable) -->
    <div
      class="flex flex-col gap-0.5 px-2 py-1 border-r border-gray-800 shrink-0 overflow-hidden"
      :style="{ width: `${panelWidth}px` }"
    >
      <!-- Top row: name and type -->
      <div class="flex items-center gap-1 min-w-0">
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
            {{ track.type === 'full' ? 'Full' : 'Clip' }}
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
            v-if="track.type === 'clip'"
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
      <div v-if="showVolumeSlider" class="flex items-center gap-1 mt-auto">
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
          @click.stop
        />
        <span class="text-[9px] text-gray-500 w-6 text-right">{{ Math.round(track.volume * 100) }}%</span>
      </div>
    </div>

    <!-- Track timeline -->
    <div
      ref="containerRef"
      class="flex-1 relative cursor-ew-resize"
      @mousedown="handleMouseDown"
    >
      <ClipRegion
        :track="track"
        :container-width="containerWidth"
        :duration="duration"
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
