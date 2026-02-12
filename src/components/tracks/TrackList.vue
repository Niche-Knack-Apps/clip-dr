<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import TrackLane from './TrackLane.vue';
import { useClipping } from '@/composables/useClipping';
import { useAudioStore } from '@/stores/audio';
import { useUIStore } from '@/stores/ui';
import { useTracksStore } from '@/stores/tracks';
import { useTranscriptionStore } from '@/stores/transcription';
import { useExportStore } from '@/stores/export';
import { useSettingsStore } from '@/stores/settings';
import { useSelectionStore } from '@/stores/selection';
import { TRACK_PANEL_MIN_WIDTH, TRACK_PANEL_MAX_WIDTH } from '@/shared/constants';
import { useHistoryStore } from '@/stores/history';

const audioStore = useAudioStore();
const uiStore = useUIStore();
const tracksStore = useTracksStore();
const transcriptionStore = useTranscriptionStore();
const exportStore = useExportStore();
const settingsStore = useSettingsStore();
const selectionStore = useSelectionStore();

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
const clipDraggingClipId = ref<string | null>(null);
const clipDragTargetTrackId = ref<string | null>(null);
const clipDragPreviewStart = ref<number>(0);

const panelWidth = computed(() => uiStore.trackPanelWidth);
const snapEnabled = computed(() => uiStore.snapEnabled);
const trackZoom = computed(() => uiStore.trackZoom);

// Logarithmic zoom slider: left = zoomed in (max px/sec), right = zoomed out (min px/sec)
// Maps slider 0..1000 to zoom range using log scale for natural feel
const SLIDER_MAX = 1000;
const zoomSliderValue = computed(() => {
  const minLog = Math.log(uiStore.TRACK_ZOOM_MIN);
  const maxLog = Math.log(uiStore.TRACK_ZOOM_MAX);
  const currentLog = Math.log(trackZoom.value);
  // Invert: left (0) = max zoom, right (SLIDER_MAX) = min zoom
  return Math.round(SLIDER_MAX - ((currentLog - minLog) / (maxLog - minLog)) * SLIDER_MAX);
});

function handleZoomSlider(event: Event) {
  const sliderVal = Number((event.target as HTMLInputElement).value);
  const minLog = Math.log(uiStore.TRACK_ZOOM_MIN);
  const maxLog = Math.log(uiStore.TRACK_ZOOM_MAX);
  // Invert: slider 0 = max zoom, slider SLIDER_MAX = min zoom
  const fraction = 1 - (sliderVal / SLIDER_MAX);
  const zoom = Math.exp(minLog + fraction * (maxLog - minLog));
  uiStore.setTrackZoom(zoom);
}

// Reference to the scroll container for zoom calculations
const scrollContainerRef = ref<HTMLDivElement | null>(null);
// Reference to the inner content wrapper to measure actual rendered width
const contentRef = ref<HTMLDivElement | null>(null);
const contentWidth = ref(0);
let contentResizeObserver: ResizeObserver | null = null;

// Timeline width based on zoom level
// When zoomed all the way out, show all content plus 10% padding on the right
const timelineWidth = computed(() => {
  const duration = tracksStore.timelineDuration;
  // Add 10% extra duration for padding when zoomed out
  const paddedDuration = duration * 1.1;
  return Math.max(600, paddedDuration * trackZoom.value) + panelWidth.value;
});

// Selection window overlay position on track list
// Uses actual rendered width (from ResizeObserver) to match ClipRegion's coordinate space
const selectionOverlayLeft = computed(() => {
  const duration = tracksStore.timelineDuration;
  if (duration <= 0 || contentWidth.value <= 0) return 0;
  const timelineAreaWidth = contentWidth.value - panelWidth.value;
  if (timelineAreaWidth <= 0) return 0;
  return (selectionStore.selection.start / duration) * timelineAreaWidth + panelWidth.value;
});

const selectionOverlayWidth = computed(() => {
  const duration = tracksStore.timelineDuration;
  if (duration <= 0 || contentWidth.value <= 0) return 0;
  const timelineAreaWidth = contentWidth.value - panelWidth.value;
  if (timelineAreaWidth <= 0) return 0;
  return ((selectionStore.selection.end - selectionStore.selection.start) / duration) * timelineAreaWidth;
});

// Auto zoom all the way out when tracks are added via import or record
// Only triggers for tracks with sourcePath (import/record), not clip creation or paste
watch(
  () => tracksStore.tracks.length,
  async (newLen, oldLen) => {
    if (newLen > (oldLen ?? 0)) {
      // Check if the newest track has a sourcePath (import/record indicator)
      const newest = tracksStore.tracks[tracksStore.tracks.length - 1];
      if (newest?.sourcePath) {
        await nextTick();
        uiStore.setTrackZoom(uiStore.TRACK_ZOOM_MIN);
      }
    }
  }
);

// Handle scroll wheel: Ctrl+wheel zooms, plain wheel scrolls natively
function handleWheel(event: WheelEvent) {
  // Only zoom with Ctrl/Cmd held - let plain wheel scroll naturally
  if (!event.ctrlKey && !event.metaKey) return;

  const rect = scrollContainerRef.value?.getBoundingClientRect();
  if (!rect) return;

  const mouseX = event.clientX - rect.left;

  // Don't zoom when over track controls (left panel)
  if (mouseX < panelWidth.value) return;

  event.preventDefault();

  // Zoom in/out based on scroll direction
  if (event.deltaY < 0) {
    uiStore.zoomTrackIn();
  } else {
    uiStore.zoomTrackOut();
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
    exporting.value = true;
    // Sync MP3 bitrate from settings to export store
    exportStore.setMp3Bitrate(settingsStore.settings.defaultMp3Bitrate || 192);
    // Native save dialog handles format selection
    const result = await exportStore.exportTrack(track);
    if (result) {
      console.log('[TrackList] Exported track:', track.name, 'to:', result);
    }
  } catch (e) {
    console.error('[TrackList] Export failed:', e);
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
let resizeRafId: number | null = null;
let pendingResizeEvent: MouseEvent | null = null;

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
  pendingResizeEvent = event;
  if (resizeRafId === null) {
    resizeRafId = requestAnimationFrame(flushResize);
  }
}

function flushResize() {
  resizeRafId = null;
  if (!pendingResizeEvent || !isResizing.value) return;
  const delta = pendingResizeEvent.clientX - resizeStartX.value;
  pendingResizeEvent = null;
  const newWidth = Math.max(
    TRACK_PANEL_MIN_WIDTH,
    Math.min(TRACK_PANEL_MAX_WIDTH, resizeStartWidth.value + delta)
  );
  uiStore.setTrackPanelWidth(newWidth);
}

function stopResize() {
  if (pendingResizeEvent) flushResize();
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
    resizeRafId = null;
  }
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
function handleClipDragStart(trackId: string, clipId: string) {
  useHistoryStore().pushState('Move clip');
  clipDraggingTrackId.value = trackId;
  clipDraggingClipId.value = clipId;
  clipDragTargetTrackId.value = trackId;
}

function handleClipDrag(trackId: string, clipId: string, newClipStart: number) {
  clipDragPreviewStart.value = newClipStart;
  // Update clip position in real-time for visual feedback (with snap if enabled)
  tracksStore.setClipStart(trackId, clipId, newClipStart, snapEnabled.value);
}

function handleClipDragEnd(trackId: string, clipId: string, newClipStart: number) {
  // Final position update (with snap if enabled)
  tracksStore.setClipStart(trackId, clipId, newClipStart, snapEnabled.value);

  // Finalize track bounds after drag completes
  tracksStore.finalizeClipPositions(trackId);

  // If dragged to a different track, move the audio
  // TODO: Support moving individual clips between tracks
  if (clipDragTargetTrackId.value && clipDragTargetTrackId.value !== trackId) {
    const ctx = audioStore.getAudioContext();
    tracksStore.moveTrackToTrack(trackId, clipDragTargetTrackId.value, newClipStart, ctx);
  }

  // Only re-transcribe multi-clip tracks where clip arrangement changed audio content.
  // Single-buffer tracks only change trackStart, which getAdjustedWords() handles via trackOffset.
  const movedTrack = tracksStore.tracks.find(t => t.id === trackId);
  if (movedTrack?.clips && movedTrack.clips.length > 1 && transcriptionStore.hasTranscriptionForTrack(trackId)) {
    console.log('[TrackList] Multi-clip track rearranged, re-queuing transcription...');
    transcriptionStore.removeTranscription(trackId);
    transcriptionStore.queueTranscription(trackId, 'normal');
  }

  // Reset state
  clipDraggingTrackId.value = null;
  clipDraggingClipId.value = null;
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

// Measure actual rendered width of the content wrapper
onMounted(() => {
  if (contentRef.value) {
    contentWidth.value = contentRef.value.clientWidth;
    contentResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        contentWidth.value = entry.contentRect.width;
      }
    });
    contentResizeObserver.observe(contentRef.value);
  }
});

onUnmounted(() => {
  contentResizeObserver?.disconnect();
});

// Clip select handler (click without drag)
function handleClipSelect(trackId: string, clipId: string) {
  // Only change track selection if needed (avoid clearing clip selection via selectTrack)
  if (tracksStore.selectedTrackId !== trackId) {
    tracksStore.selectTrack(trackId);
  }
  tracksStore.selectClip(trackId, clipId);
}
</script>

<template>
  <div class="bg-waveform-bg rounded-lg overflow-hidden relative h-full flex flex-col">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-400">Tracks</span>
        <!-- Snap/Magnet button -->
        <button
          type="button"
          :class="[
            'p-1 rounded transition-colors',
            snapEnabled
              ? 'bg-cyan-600 text-white'
              : 'bg-gray-700 text-gray-400 hover:bg-gray-600',
          ]"
          title="Snap clips to edges (prevents overlap)"
          @click="uiStore.toggleSnap()"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="m15,0v11.807c0,1.638-1.187,3.035-2.701,3.179-.858.083-1.684-.189-2.316-.765-.625-.568-.983-1.377-.983-2.221V0H0v11.652c0,6.689,5,12.348,12.003,12.348,3.164,0,6.142-1.216,8.404-3.437,2.316-2.275,3.593-5.316,3.593-8.563V0h-9Zm6,12c0,2.435-.957,4.716-2.695,6.422-1.736,1.706-4.039,2.618-6.474,2.576-4.869-.089-8.831-4.282-8.831-9.347v-5.652h3v6c0,1.687.716,3.305,1.965,4.44,1.248,1.135,2.932,1.695,4.62,1.532,3.037-.29,5.416-2.998,5.416-6.166v-5.807h3v6Z"/>
          </svg>
        </button>
        <!-- Add empty track button -->
        <button
          type="button"
          class="p-1 rounded transition-colors bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-white"
          title="Add empty track"
          @click="tracksStore.addEmptyTrack()"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="exporting" class="text-xs text-cyan-400">Exporting...</span>
        <!-- Zoom slider: left = zoom in, right = zoom out -->
        <div class="flex items-center gap-1" title="Timeline zoom (left=in, right=out)">
          <svg class="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
          </svg>
          <input
            type="range"
            :min="0"
            :max="SLIDER_MAX"
            :value="zoomSliderValue"
            class="w-20 h-1 accent-cyan-500 cursor-pointer"
            @input="handleZoomSlider"
          />
          <svg class="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
          </svg>
        </div>
        <span class="text-xs text-gray-500">{{ tracks.length }} track{{ tracks.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <div
      ref="scrollContainerRef"
      data-track-scroll
      class="flex-1 min-h-0 overflow-y-auto overflow-x-auto"
      @wheel="handleWheel"
    >
      <div
        ref="contentRef"
        class="relative"
        :style="{ minWidth: `${timelineWidth}px` }"
      >
        <!-- Selection window overlay -->
        <div
          v-if="tracksStore.timelineDuration > 0"
          class="pointer-events-none z-[5] absolute top-0 bottom-0"
          :style="{
            left: `${selectionOverlayLeft}px`,
            width: `${selectionOverlayWidth}px`,
            backgroundColor: 'rgba(0, 212, 255, 0.08)',
            borderLeft: '1px solid rgba(0, 212, 255, 0.25)',
            borderRight: '1px solid rgba(0, 212, 255, 0.25)',
          }"
        />

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
            @clip-select="handleClipSelect"
          />
        </div>

        <div
          v-if="!tracks.length"
          class="flex items-center justify-center h-16 text-xs text-gray-600"
        >
          No tracks - Import or record audio
        </div>
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
