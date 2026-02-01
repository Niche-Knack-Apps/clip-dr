<script setup lang="ts">
import { ref, computed } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import TrackLane from './TrackLane.vue';
import { useClipping } from '@/composables/useClipping';
import { useAudioStore } from '@/stores/audio';
import { useUIStore } from '@/stores/ui';
import { TRACK_PANEL_MIN_WIDTH, TRACK_PANEL_MAX_WIDTH } from '@/shared/constants';

const audioStore = useAudioStore();
const uiStore = useUIStore();

const {
  tracks,
  selectedTrackId,
  selectTrack,
  toggleMute,
  toggleSolo,
  deleteTrack,
  renameTrack,
  setTrackVolume,
  reorderTrack,
} = useClipping();

const exporting = ref(false);
const isResizing = ref(false);
const resizeStartX = ref(0);
const resizeStartWidth = ref(0);

// Drag reorder state
const draggedTrackId = ref<string | null>(null);
const dragOverTrackId = ref<string | null>(null);

const panelWidth = computed(() => uiStore.trackPanelWidth);

async function handleExport(trackId: string) {
  const track = tracks.value.find((t) => t.id === trackId);
  if (!track || !audioStore.currentFile) return;

  try {
    const defaultName = track.type === 'clip'
      ? `${track.name}.wav`
      : `${audioStore.fileName.replace(/\.[^.]+$/, '')}_export.wav`;

    const savePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });

    if (!savePath) return;

    exporting.value = true;

    await invoke('export_audio_region', {
      sourcePath: audioStore.currentFile.path,
      outputPath: savePath,
      startTime: track.start,
      endTime: track.end,
    });

    console.log('Export complete:', savePath);
  } catch (e) {
    console.error('Export failed:', e);
  } finally {
    exporting.value = false;
  }
}

function handleRename(trackId: string, name: string) {
  renameTrack(trackId, name);
}

function handleSetVolume(trackId: string, volume: number) {
  setTrackVolume(trackId, volume);
}

// Panel resize handlers
function startResize(event: MouseEvent) {
  event.preventDefault();
  isResizing.value = true;
  resizeStartX.value = event.clientX;
  resizeStartWidth.value = panelWidth.value;

  document.addEventListener('mousemove', handleResizeMove);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function handleResizeMove(event: MouseEvent) {
  if (!isResizing.value) return;

  const delta = event.clientX - resizeStartX.value;
  const newWidth = Math.max(
    TRACK_PANEL_MIN_WIDTH,
    Math.min(TRACK_PANEL_MAX_WIDTH, resizeStartWidth.value + delta)
  );
  uiStore.setTrackPanelWidth(newWidth);
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

// Drag reorder handlers
function handleDragStart(event: DragEvent, trackId: string) {
  if (!event.dataTransfer) return;

  draggedTrackId.value = trackId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', trackId);

  // Add drag styling
  const target = event.target as HTMLElement;
  setTimeout(() => {
    target.style.opacity = '0.5';
  }, 0);
}

function handleDragEnd(event: DragEvent) {
  const target = event.target as HTMLElement;
  target.style.opacity = '';
  draggedTrackId.value = null;
  dragOverTrackId.value = null;
}

function handleDragOver(event: DragEvent, trackId: string) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  dragOverTrackId.value = trackId;
}

function handleDragLeave() {
  dragOverTrackId.value = null;
}

function handleDrop(event: DragEvent, targetTrackId: string) {
  event.preventDefault();

  if (draggedTrackId.value && draggedTrackId.value !== targetTrackId) {
    const fromIndex = tracks.value.findIndex((t) => t.id === draggedTrackId.value);
    const toIndex = tracks.value.findIndex((t) => t.id === targetTrackId);

    if (fromIndex !== -1 && toIndex !== -1) {
      reorderTrack(fromIndex, toIndex);
    }
  }

  draggedTrackId.value = null;
  dragOverTrackId.value = null;
}
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden relative">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <span class="text-xs text-gray-400">Tracks</span>
      <div class="flex items-center gap-2">
        <span v-if="exporting" class="text-xs text-cyan-400">Exporting...</span>
        <span class="text-xs text-gray-500">{{ tracks.length }} track{{ tracks.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <div class="max-h-48 overflow-y-auto">
      <div
        v-for="track in tracks"
        :key="track.id"
        class="relative"
        :class="{
          'border-t-2 border-cyan-500': dragOverTrackId === track.id && draggedTrackId !== track.id,
        }"
        draggable="true"
        @dragstart="handleDragStart($event, track.id)"
        @dragend="handleDragEnd"
        @dragover="handleDragOver($event, track.id)"
        @dragleave="handleDragLeave"
        @drop="handleDrop($event, track.id)"
      >
        <TrackLane
          :track="track"
          :is-selected="track.id === selectedTrackId"
          @select="selectTrack"
          @toggle-mute="toggleMute"
          @toggle-solo="toggleSolo"
          @delete="deleteTrack"
          @export="handleExport"
          @rename="handleRename"
          @set-volume="handleSetVolume"
        />
      </div>

      <div
        v-if="!tracks.length"
        class="flex items-center justify-center h-16 text-xs text-gray-600"
      >
        No tracks
      </div>
    </div>

    <!-- Resize handle -->
    <div
      class="absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-cyan-500/50 transition-colors z-10"
      :style="{ left: `${panelWidth}px` }"
      :class="{ 'bg-cyan-500/50': isResizing }"
      @mousedown="startResize"
    />
  </div>
</template>
