<script setup lang="ts">
import { ref, computed } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import TrackLane from './TrackLane.vue';
import { useClipping } from '@/composables/useClipping';
import { useAudioStore } from '@/stores/audio';
import { useUIStore } from '@/stores/ui';
import { useTracksStore } from '@/stores/tracks';
import { TRACK_PANEL_MIN_WIDTH, TRACK_PANEL_MAX_WIDTH } from '@/shared/constants';

const audioStore = useAudioStore();
const uiStore = useUIStore();
const tracksStore = useTracksStore();

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

// Drag reorder state (for reordering track list)
const draggedTrackId = ref<string | null>(null);
const dragOverTrackId = ref<string | null>(null);
const canDrag = ref(false);

// Clip dragging state (for moving clips on timeline / between tracks)
const clipDraggingTrackId = ref<string | null>(null);
const clipDragTargetTrackId = ref<string | null>(null);
const clipDragPreviewStart = ref<number>(0);

const panelWidth = computed(() => uiStore.trackPanelWidth);
const isAllSelected = computed(() => selectedTrackId.value === 'ALL');

// Toggle ALL view on/off
function toggleAllView() {
  if (isAllSelected.value) {
    // Deselect ALL - select first track if available
    if (tracks.value.length > 0) {
      selectTrack(tracks.value[0].id);
    }
  } else {
    selectTrack('ALL');
  }
}

// Track if mousedown was on a drag handle
function handleMouseDown(event: MouseEvent) {
  canDrag.value = (event.target as HTMLElement).closest('.drag-handle') !== null;
}

function handleMouseUp() {
  canDrag.value = false;
}

async function handleExport(trackId: string) {
  const track = tracks.value.find((t) => t.id === trackId);
  if (!track) return;

  try {
    const defaultName = `${track.name}.wav`;

    const savePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });

    if (!savePath) return;

    exporting.value = true;

    // For track-centric model, we'd export the track's buffer directly
    // For now, use the track's audio data
    // TODO: Implement direct buffer export
    console.log('Export track:', track.name, 'to:', savePath);
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
  if (!event.dataTransfer || !canDrag.value) {
    event.preventDefault();
    return;
  }

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

// Clip drag handlers (for moving clips on timeline)
function handleClipDragStart(trackId: string) {
  clipDraggingTrackId.value = trackId;
  clipDragTargetTrackId.value = trackId;
}

function handleClipDrag(trackId: string, newTrackStart: number) {
  clipDragPreviewStart.value = newTrackStart;
  // Update track position in real-time for visual feedback
  tracksStore.setTrackStart(trackId, newTrackStart);
}

function handleClipDragEnd(trackId: string, newTrackStart: number) {
  // Final position update
  tracksStore.setTrackStart(trackId, newTrackStart);

  // If dragged to a different track, move the audio
  if (clipDragTargetTrackId.value && clipDragTargetTrackId.value !== trackId) {
    const ctx = audioStore.getAudioContext();
    tracksStore.moveTrackToTrack(trackId, clipDragTargetTrackId.value, newTrackStart, ctx);
  }

  // Reset state
  clipDraggingTrackId.value = null;
  clipDragTargetTrackId.value = null;
}

// Track which lane the clip is being dragged over (for cross-track drop)
function handleClipDragOverTrack(targetTrackId: string) {
  if (clipDraggingTrackId.value && clipDraggingTrackId.value !== targetTrackId) {
    clipDragTargetTrackId.value = targetTrackId;
  }
}

function handleClipDragLeaveTrack() {
  if (clipDraggingTrackId.value) {
    clipDragTargetTrackId.value = clipDraggingTrackId.value;
  }
}
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden relative">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-400">Tracks</span>
        <!-- ALL Tracks button -->
        <button
          type="button"
          :class="[
            'px-2 py-0.5 text-[10px] font-medium rounded transition-colors',
            isAllSelected
              ? 'bg-cyan-600 text-white'
              : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
          ]"
          title="View all tracks combined (click to toggle)"
          @click="toggleAllView"
        >
          ALL
        </button>
      </div>
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
          'bg-cyan-900/30': clipDragTargetTrackId === track.id && clipDraggingTrackId !== track.id,
        }"
        draggable="true"
        @mousedown="handleMouseDown"
        @mouseup="handleMouseUp"
        @dragstart="handleDragStart($event, track.id)"
        @dragend="handleDragEnd"
        @dragover="handleDragOver($event, track.id)"
        @dragleave="handleDragLeave"
        @drop="handleDrop($event, track.id)"
        @mouseenter="handleClipDragOverTrack(track.id)"
        @mouseleave="handleClipDragLeaveTrack"
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
          @clip-drag-start="handleClipDragStart"
          @clip-drag="handleClipDrag"
          @clip-drag-end="handleClipDragEnd"
        />
      </div>

      <div
        v-if="!tracks.length"
        class="flex items-center justify-center h-16 text-xs text-gray-600"
      >
        No tracks - Import or record audio
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
