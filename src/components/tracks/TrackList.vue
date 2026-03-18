<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import TrackLane from './TrackLane.vue';
import { useClipping } from '@/composables/useClipping';
import { useAudioStore } from '@/stores/audio';
import { useUIStore } from '@/stores/ui';
import { useTracksStore } from '@/stores/tracks';
import { useExportStore } from '@/stores/export';
import { useSettingsStore } from '@/stores/settings';
import { useSelectionStore } from '@/stores/selection';
import InfiniteKnob from '@/components/ui/InfiniteKnob.vue';
import { TRACK_PANEL_MIN_WIDTH, TRACK_PANEL_MAX_WIDTH, MIN_SELECTION_DURATION, TRACK_HEIGHT } from '@/shared/constants';
import { useHistoryStore } from '@/stores/history';
import type { ExportProfile } from '@/shared/types';
import scalpelIcon from '@/assets/scalpel.svg';

const audioStore = useAudioStore();
const uiStore = useUIStore();
const tracksStore = useTracksStore();
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
const exportPickerTrackId = ref<string | null>(null);
const exportProfiles = computed(() => settingsStore.getExportProfiles());
const exportPickerTrackName = computed(() => {
  if (!exportPickerTrackId.value) return '';
  return tracks.value.find(t => t.id === exportPickerTrackId.value)?.name || '';
});

function formatProfileLabel(profile: ExportProfile): string {
  if (profile.format === 'mp3' && profile.mp3Bitrate) {
    return `${profile.mp3Bitrate} kbps`;
  }
  return profile.format === 'wav' ? 'Lossless' : profile.format.toUpperCase();
}

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
const clipDragStartY = ref(0);
const CROSS_TRACK_THRESHOLD = 20; // pixels of vertical movement to trigger cross-track intent

// Cached scroll container rect for ghost positioning (captured at drag start)
const dragScrollContainerRect = ref<DOMRect | null>(null);

// Snap visualization state
const activeSnapTarget = ref<{ time: number } | null>(null);

// Floating drag ghost state
const dragGhostMouseX = ref(0);
const dragGhostMouseY = ref(0);
const dragGhostMouseOffsetX = ref(0);
const dragGhostActive = ref(false);
const ghostCanvasRef = ref<HTMLCanvasElement | null>(null);
let dragGhostRafId: number | null = null;

const panelWidth = computed(() => uiStore.trackPanelWidth);
const snapEnabled = computed(() => uiStore.snapEnabled);
const trackZoom = computed(() => uiStore.trackZoom);

function formatZoom(v: number): string {
  if (v >= 100) return `${Math.round(v)}`;
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
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
  return paddedDuration * trackZoom.value + panelWidth.value;
});

// Auto zoom to fit when tracks are added via import or record
// Only triggers for tracks with sourcePath (import/record), not clip creation or paste
watch(
  () => tracksStore.tracks.length,
  async (newLen, oldLen) => {
    if (newLen > (oldLen ?? 0)) {
      // Check if the newest track has a sourcePath (import/record indicator)
      const newest = tracksStore.tracks[tracksStore.tracks.length - 1];
      if (newest?.sourcePath) {
        await nextTick();
        const containerW = (scrollContainerRef.value?.clientWidth || 0) - panelWidth.value;
        console.log(`[Zoom] tracks.length watcher: ${oldLen} → ${newLen}, sourcePath=${newest?.sourcePath}, scrollW=${scrollContainerRef.value?.clientWidth}, panelW=${panelWidth.value}, containerW=${containerW}, timelineDuration=${tracksStore.timelineDuration.toFixed(2)}`);
        if (containerW > 0) {
          uiStore.zoomTrackToFit(tracksStore.timelineDuration, containerW);
        } else {
          uiStore.setTrackZoom(uiStore.TRACK_ZOOM_MIN);
        }
      }
    }
  }
);

watch(timelineWidth, (newW, oldW) => {
  console.log(`[Zoom] timelineWidth changed: ${oldW?.toFixed(1)} → ${newW.toFixed(1)}, trackZoom=${trackZoom.value.toFixed(6)}, duration=${tracksStore.timelineDuration.toFixed(2)}, scrollContainerW=${scrollContainerRef.value?.clientWidth}`);
});

// Zoom constants (match FullWaveform.vue exactly)
const ZOOM_FACTOR = 0.15;

// Wheel-burst coalescing for Ctrl+scroll zoom: zoom state updates synchronously
// on every wheel event, but scrollLeft correction is coalesced to one rAF.
let pendingZoomAnchor: { timeAtMouse: number; localX: number; newZoom: number } | null = null;
let zoomRafId: number | null = null;

function flushZoomScroll() {
  zoomRafId = null;
  const anchor = pendingZoomAnchor;
  const container = scrollContainerRef.value;
  if (!anchor || !container) return;
  pendingZoomAnchor = null;
  container.scrollLeft = anchor.timeAtMouse * anchor.newZoom - anchor.localX;
}

// Handle scroll wheel:
// - Plain wheel = expand/contract zoom-view selection window (matches FullWaveform/ZoomedWaveform)
// - Ctrl/Cmd+wheel = pixel-scale zoom (traditional DAW track zoom)
// - Shift+wheel = vertical scroll
function handleWheel(event: WheelEvent) {
  // Shift+wheel → vertical scroll through tracks
  if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
    if (scrollContainerRef.value) {
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      scrollContainerRef.value.scrollTop += delta;
      event.preventDefault();
    }
    return;
  }

  const rect = scrollContainerRef.value?.getBoundingClientRect();
  if (!rect) return;

  const mouseX = event.clientX - rect.left;

  // Don't zoom when over track controls (left panel)
  if (mouseX < panelWidth.value) return;

  event.preventDefault();

  // Ctrl/Cmd+wheel → pixel-scale zoom centered on mouse position
  if (event.ctrlKey || event.metaKey) {
    const container = scrollContainerRef.value;
    if (!container) return;

    // Calculate time position under mouse before zoom
    const localX = mouseX - panelWidth.value;
    const scrollX = container.scrollLeft;
    const oldZoom = trackZoom.value;
    const timeAtMouse = (localX + scrollX) / oldZoom;

    // Compute new zoom directly (bypass setTrackZoom to avoid resetMinTimelineDuration
    // which causes timeline width changes that fight with scroll position)
    const factor = event.deltaY < 0 ? 1.2 : (1 / 1.2);
    const newZoom = Math.max(uiStore.TRACK_ZOOM_MIN, Math.min(uiStore.TRACK_ZOOM_MAX, oldZoom * factor));
    if (newZoom === oldZoom) return;

    // Don't zoom IN when user wants to zoom OUT (at min boundary)
    if (event.deltaY > 0 && newZoom >= oldZoom) return;

    // Update trackZoom — ResizeObserver fires same-frame (before paint) to update
    // contentWidth, so no manual sync needed (dual-source caused flicker).
    uiStore.trackZoom = newZoom;

    // Part B: Coalesce scrollLeft correction — store the anchor and schedule ONE rAF.
    // Under rapid wheel input, each event updates zoom state immediately (so content
    // width is always correct), but scroll correction happens exactly once per frame
    // using the most recent anchor — no stacked corrections, no mini-oscillations.
    pendingZoomAnchor = { timeAtMouse, localX, newZoom };
    if (zoomRafId === null) {
      zoomRafId = requestAnimationFrame(flushZoomScroll);
    }
    return;
  }

  // Plain wheel → expand/contract selection window (matches FullWaveform.handleWheel)
  const dur = tracksStore.timelineDuration;
  if (dur <= 0) return;

  const sel = selectionStore.selection;
  const currentDuration = sel.end - sel.start;
  const maxDuration = dur;

  // Scroll up = zoom in (shrink window), scroll down = zoom out (expand window)
  const zoomIn = event.deltaY < 0;
  const factor = zoomIn ? (1 - ZOOM_FACTOR) : (1 + ZOOM_FACTOR);

  let newDuration = currentDuration * factor;
  newDuration = Math.max(MIN_SELECTION_DURATION, Math.min(maxDuration, newDuration));

  if (newDuration === currentDuration) return;

  // Map mouse X to time on the full timeline
  // Account for scroll position and panel width
  const timelineX = mouseX - panelWidth.value + (scrollContainerRef.value?.scrollLeft ?? 0);
  const timelineAreaWidth = contentWidth.value - panelWidth.value;
  const timeUnderMouse = timelineAreaWidth > 0
    ? (timelineX / timelineAreaWidth) * dur
    : dur / 2;

  // Calculate the ratio of where the mouse is in the current selection view
  const mouseRatio = (timeUnderMouse - sel.start) / currentDuration;

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

// Track if mousedown was on a drag handle
function handleMouseDown(event: MouseEvent) {
  canDrag.value = (event.target as HTMLElement).closest('.drag-handle') !== null;
}

function handleMouseUp() {
  canDrag.value = false;
}

function handleExport(trackId: string) {
  exportPickerTrackId.value = trackId;
}

async function handleProfileExport(profile: ExportProfile) {
  const trackId = exportPickerTrackId.value;
  if (!trackId) return;
  const track = tracks.value.find((t) => t.id === trackId);
  if (!track) return;

  try {
    exporting.value = true;
    exportPickerTrackId.value = null;
    const result = await exportStore.exportTrackWithProfile(track, profile);
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

function handleSetVolume(trackId: string, volume: number, skipHistory = false) {
  setTrackVolume(trackId, volume, skipHistory);
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

  // Use tiny transparent drag image to avoid browser ghost artifacts
  const ghost = document.createElement('canvas');
  ghost.width = 1;
  ghost.height = 1;
  event.dataTransfer.setDragImage(ghost, 0, 0);

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
function handleClipDragStart(trackId: string, clipId: string, mouseOffsetX: number, event?: MouseEvent) {
  useHistoryStore().pushState('Move clip');
  clipDraggingTrackId.value = trackId;
  clipDraggingClipId.value = clipId;
  clipDragTargetTrackId.value = trackId;
  dragGhostMouseOffsetX.value = mouseOffsetX;
  clipDragStartY.value = event?.clientY ?? 0;

  // Cache scroll container rect for ghost lane snapping
  dragScrollContainerRect.value = scrollContainerRef.value?.getBoundingClientRect() ?? null;

  // Start floating ghost tracking
  dragGhostActive.value = true;
  document.addEventListener('mousemove', trackDragMouse);
}

function handleClipDrag(trackId: string, clipId: string, newClipStart: number, mouseEvent?: MouseEvent) {
  clipDragPreviewStart.value = newClipStart;
  // Update clip position in real-time for visual feedback (with snap if enabled)
  tracksStore.setClipStart(trackId, clipId, newClipStart, snapEnabled.value);

  // Update snap visualization
  const clip = tracksStore.getTrackClips(trackId).find(c => c.id === clipId);
  if (clip) {
    activeSnapTarget.value = tracksStore.getSnapTarget(trackId, clipId, newClipStart, clip.duration, snapEnabled.value);
  }

  // Cross-track detection via Y-tracking (replaces mouseenter/mouseleave)
  if (mouseEvent && clipDraggingTrackId.value) {
    const deltaY = Math.abs(mouseEvent.clientY - clipDragStartY.value);
    if (deltaY < CROSS_TRACK_THRESHOLD) {
      clipDragTargetTrackId.value = clipDraggingTrackId.value;
    } else {
      const el = document.elementFromPoint(mouseEvent.clientX, mouseEvent.clientY);
      const trackEl = el?.closest('[data-track-id]');
      if (trackEl) {
        clipDragTargetTrackId.value = trackEl.getAttribute('data-track-id');
      }
    }
  }
}

async function handleClipDragEnd(trackId: string, clipId: string, newClipStart: number) {
  const isCrossTrack = clipDragTargetTrackId.value && clipDragTargetTrackId.value !== trackId;

  if (isCrossTrack) {
    // Cross-track drop: go straight to moveClipToTrack (skip setClipStart/finalize
    // on source — those would commit the clip at the new position on the source track,
    // then moveClipToTrack would duplicate it onto the target)
    tracksStore.moveClipToTrack(trackId, clipId, clipDragTargetTrackId.value!, newClipStart);
  } else {
    // Same-track drag: update position and finalize bounds
    tracksStore.setClipStart(trackId, clipId, newClipStart, snapEnabled.value);
    tracksStore.finalizeClipPositions(trackId);
  }

  // Stop floating ghost tracking and auto-scroll
  dragGhostActive.value = false;
  activeSnapTarget.value = null;
  stopAutoScroll();
  document.removeEventListener('mousemove', trackDragMouse);
  if (dragGhostRafId !== null) {
    cancelAnimationFrame(dragGhostRafId);
    dragGhostRafId = null;
  }

  // Reset state
  clipDraggingTrackId.value = null;
  clipDraggingClipId.value = null;
  clipDragTargetTrackId.value = null;
  dragScrollContainerRect.value = null;
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

  // Auto-fit zoom on first mount when tracks already exist
  // (tracks.length watcher misses the first import because TrackList
  // wasn't mounted when the track was created)
  // Use nextTick + rAF to ensure CSS layout is fully settled before measuring
  if (tracksStore.tracks.length > 0 && scrollContainerRef.value) {
    nextTick(() => {
      requestAnimationFrame(() => {
        const containerW = (scrollContainerRef.value?.clientWidth || 0) - panelWidth.value;
        if (containerW > 0) {
          uiStore.zoomTrackToFit(tracksStore.timelineDuration, containerW);
        }
      });
    });
  }
});

onUnmounted(() => {
  contentResizeObserver?.disconnect();
  document.removeEventListener('mousemove', trackDragMouse);
  document.removeEventListener('mousemove', handleDragBarMouseMove);
  document.removeEventListener('mouseup', handleDragBarMouseUp);
  document.removeEventListener('mousemove', handleBottomBarMouseMove);
  document.removeEventListener('mouseup', handleBottomBarMouseUp);
  document.removeEventListener('mousemove', handleRightBarMouseMove);
  document.removeEventListener('mouseup', handleRightBarMouseUp);
  if (dragGhostRafId !== null) {
    cancelAnimationFrame(dragGhostRafId);
  }
  if (dragPanRafId !== null) {
    cancelAnimationFrame(dragPanRafId);
  }
  if (bottomDragRafId !== null) {
    cancelAnimationFrame(bottomDragRafId);
  }
  if (rightDragRafId !== null) {
    cancelAnimationFrame(rightDragRafId);
  }
  if (zoomRafId !== null) {
    cancelAnimationFrame(zoomRafId);
  }
  stopAutoScroll();
});

// Ghost clip for cross-track drag preview
const ghostClip = computed(() => {
  if (!clipDraggingTrackId.value || !clipDraggingClipId.value) return null;
  if (!clipDragTargetTrackId.value || clipDragTargetTrackId.value === clipDraggingTrackId.value) return null;
  const clips = tracksStore.getTrackClips(clipDraggingTrackId.value);
  return clips.find(c => c.id === clipDraggingClipId.value) ?? null;
});

// Dragging clip data (for floating ghost — always available during any clip drag)
const draggingClipData = computed(() => {
  if (!clipDraggingTrackId.value || !clipDraggingClipId.value) return null;
  const clips = tracksStore.getTrackClips(clipDraggingTrackId.value);
  return clips.find(c => c.id === clipDraggingClipId.value) ?? null;
});

// Source track for ghost color
const draggingTrack = computed(() => {
  if (!clipDraggingTrackId.value) return null;
  return tracks.value.find(t => t.id === clipDraggingTrackId.value) ?? null;
});

// Whether current drag is cross-track
const isCrossTrackDrag = computed(() =>
  clipDragTargetTrackId.value !== null &&
  clipDraggingTrackId.value !== null &&
  clipDragTargetTrackId.value !== clipDraggingTrackId.value
);

// Ghost dimensions and position
const ghostWidthPx = computed(() => {
  const clip = draggingClipData.value;
  if (!clip || !dragGhostActive.value) return 0;
  const timelineAreaWidth = contentWidth.value - panelWidth.value;
  if (timelineAreaWidth <= 0 || tracksStore.timelineDuration <= 0) return 0;
  return (clip.duration / tracksStore.timelineDuration) * timelineAreaWidth;
});

const ghostLeft = computed(() => dragGhostMouseX.value - dragGhostMouseOffsetX.value);
const ghostTop = computed(() => {
  const targetId = clipDragTargetTrackId.value ?? clipDraggingTrackId.value;
  const containerRect = dragScrollContainerRect.value;
  if (targetId && containerRect && scrollContainerRef.value) {
    const trackIndex = tracks.value.findIndex(t => t.id === targetId);
    if (trackIndex >= 0) {
      const scrollTop = scrollContainerRef.value.scrollTop;
      // Track Y in viewport = container top + (index * height) - scroll offset + 1px inset
      return containerRect.top + (trackIndex * TRACK_HEIGHT) - scrollTop + 1;
    }
  }
  return dragGhostMouseY.value - (TRACK_HEIGHT / 2); // fallback
});

const ghostBgColor = computed(() => {
  const track = draggingTrack.value;
  if (!track) return 'rgba(75, 85, 99, 0.5)';
  return `${track.color}30`;
});

const ghostBorderColor = computed(() => {
  const track = draggingTrack.value;
  if (!track) return 'rgb(75, 85, 99)';
  return track.color;
});

const ghostWaveformColor = computed(() => {
  const track = draggingTrack.value;
  if (!track) return 'rgba(75, 85, 99, 0.6)';
  return `${track.color}80`;
});

// Auto-scroll during clip drag when mouse is near top/bottom edge of scroll container
const AUTO_SCROLL_ZONE = 40; // px from edge
const AUTO_SCROLL_SPEED = 6; // px per frame
let autoScrollRafId: number | null = null;
let autoScrollMouseY = 0;

function startAutoScroll() {
  if (autoScrollRafId !== null) return;
  autoScrollRafId = requestAnimationFrame(autoScrollTick);
}

function autoScrollTick() {
  autoScrollRafId = null;
  const container = scrollContainerRef.value;
  if (!container || !dragGhostActive.value) return;

  const rect = container.getBoundingClientRect();
  let scrolled = false;

  if (autoScrollMouseY < rect.top + AUTO_SCROLL_ZONE && container.scrollTop > 0) {
    container.scrollTop -= AUTO_SCROLL_SPEED;
    scrolled = true;
  } else if (autoScrollMouseY > rect.bottom - AUTO_SCROLL_ZONE &&
             container.scrollTop < container.scrollHeight - container.clientHeight) {
    container.scrollTop += AUTO_SCROLL_SPEED;
    scrolled = true;
  }

  if (scrolled) {
    autoScrollRafId = requestAnimationFrame(autoScrollTick);
  }
}

function stopAutoScroll() {
  if (autoScrollRafId !== null) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
}

// Mouse tracking for floating ghost
function trackDragMouse(event: MouseEvent) {
  autoScrollMouseY = event.clientY;
  startAutoScroll();

  if (dragGhostRafId !== null) return;
  dragGhostRafId = requestAnimationFrame(() => {
    dragGhostRafId = null;
    dragGhostMouseX.value = event.clientX;
    dragGhostMouseY.value = event.clientY;
  });
}

function drawGhostWaveform() {
  const canvas = ghostCanvasRef.value;
  const clip = draggingClipData.value;
  if (!canvas || !clip || !clip.waveformData || clip.waveformData.length < 2) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const data = clip.waveformData;
  const buckets = data.length / 2;
  const centerY = h / 2;
  ctx.fillStyle = ghostWaveformColor.value;
  ctx.beginPath();

  const barsToRender = Math.min(Math.floor(w), buckets);
  const barWidth = w / barsToRender;
  const bucketStep = buckets / barsToRender;

  for (let i = 0; i < barsToRender; i++) {
    const bIdx = Math.floor(i * bucketStep);
    const min = data[bIdx * 2];
    const max = data[bIdx * 2 + 1];
    const topY = centerY - max * centerY;
    const bottomY = centerY - min * centerY;
    ctx.rect(i * barWidth, topY, barWidth, Math.max(1, bottomY - topY));
  }
  ctx.fill();
}

// Watch for ghost visibility changes to draw waveform
watch([dragGhostActive, ghostWidthPx], () => {
  if (dragGhostActive.value && ghostWidthPx.value > 0) {
    nextTick(drawGhostWaveform);
  }
});

// Drag-to-pan state (for the grip bar above the tracks — pans zoom window horizontally)
const isDragPanning = ref(false);
let dragLastX = 0;
let dragPanRafId: number | null = null;
let pendingDragPanEvent: MouseEvent | null = null;

function handleDragBarMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  isDragPanning.value = true;
  dragLastX = event.clientX;
  document.addEventListener('mousemove', handleDragBarMouseMove);
  document.addEventListener('mouseup', handleDragBarMouseUp);
}

function handleDragBarMouseMove(event: MouseEvent) {
  pendingDragPanEvent = event;
  if (dragPanRafId === null) {
    dragPanRafId = requestAnimationFrame(flushDragPanMove);
  }
}

function flushDragPanMove() {
  dragPanRafId = null;
  const event = pendingDragPanEvent;
  if (!event) return;
  pendingDragPanEvent = null;

  const deltaX = event.clientX - dragLastX;
  dragLastX = event.clientX;

  const dur = tracksStore.timelineDuration;
  const timelineAreaWidth = contentWidth.value - panelWidth.value;
  if (dur > 0 && timelineAreaWidth > 0) {
    const deltaTime = deltaX / (timelineAreaWidth / dur);
    selectionStore.moveSelection(deltaTime);
  }
}

function handleDragBarMouseUp() {
  if (pendingDragPanEvent) flushDragPanMove();
  if (dragPanRafId !== null) {
    cancelAnimationFrame(dragPanRafId);
    dragPanRafId = null;
  }
  isDragPanning.value = false;
  document.removeEventListener('mousemove', handleDragBarMouseMove);
  document.removeEventListener('mouseup', handleDragBarMouseUp);
}

// Right scroll strip state (vertical scroll via drag)
const isRightDragging = ref(false);
let rightDragLastY = 0;
let rightDragRafId: number | null = null;
let pendingRightDragEvent: MouseEvent | null = null;

function handleRightBarMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  isRightDragging.value = true;
  rightDragLastY = event.clientY;
  document.addEventListener('mousemove', handleRightBarMouseMove);
  document.addEventListener('mouseup', handleRightBarMouseUp);
}

function handleRightBarMouseMove(event: MouseEvent) {
  pendingRightDragEvent = event;
  if (rightDragRafId === null) {
    rightDragRafId = requestAnimationFrame(flushRightDragMove);
  }
}

function flushRightDragMove() {
  rightDragRafId = null;
  const event = pendingRightDragEvent;
  if (!event || !scrollContainerRef.value) return;
  pendingRightDragEvent = null;
  const deltaY = event.clientY - rightDragLastY;
  rightDragLastY = event.clientY;
  scrollContainerRef.value.scrollTop += deltaY;
}

function handleRightBarMouseUp() {
  isRightDragging.value = false;
  document.removeEventListener('mousemove', handleRightBarMouseMove);
  document.removeEventListener('mouseup', handleRightBarMouseUp);
  if (rightDragRafId !== null) {
    cancelAnimationFrame(rightDragRafId);
    rightDragRafId = null;
  }
}

// Bottom scroll strip state (horizontal scroll via drag)
const isBottomDragging = ref(false);
let bottomDragLastX = 0;
let bottomDragRafId: number | null = null;
let pendingBottomDragEvent: MouseEvent | null = null;

function handleBottomBarMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  isBottomDragging.value = true;
  bottomDragLastX = event.clientX;
  document.addEventListener('mousemove', handleBottomBarMouseMove);
  document.addEventListener('mouseup', handleBottomBarMouseUp);
}

function handleBottomBarMouseMove(event: MouseEvent) {
  pendingBottomDragEvent = event;
  if (bottomDragRafId === null) {
    bottomDragRafId = requestAnimationFrame(flushBottomDragMove);
  }
}

function flushBottomDragMove() {
  bottomDragRafId = null;
  const event = pendingBottomDragEvent;
  if (!event || !scrollContainerRef.value) return;
  pendingBottomDragEvent = null;
  const deltaX = event.clientX - bottomDragLastX;
  bottomDragLastX = event.clientX;
  scrollContainerRef.value.scrollLeft += deltaX;
}

function handleBottomBarMouseUp() {
  isBottomDragging.value = false;
  document.removeEventListener('mousemove', handleBottomBarMouseMove);
  document.removeEventListener('mouseup', handleBottomBarMouseUp);
  if (bottomDragRafId !== null) {
    cancelAnimationFrame(bottomDragRafId);
    bottomDragRafId = null;
  }
}

// Selection window container width — timeline area excluding panel
const selectionWindowContainerWidth = computed(() => {
  if (contentWidth.value <= 0) return 0;
  return contentWidth.value - panelWidth.value;
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
        <InfiniteKnob
          :model-value="trackZoom"
          :min="uiStore.TRACK_ZOOM_MIN"
          :max="uiStore.TRACK_ZOOM_MAX"
          :step="0.1"
          :sensitivity="2"
          :logarithmic="true"
          label="Zoom"
          :format-value="formatZoom"
          @update:model-value="(v: number) => uiStore.setTrackZoom(v)"
        />
        <span class="text-xs text-gray-500">{{ tracks.length }} track{{ tracks.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <!-- Drag strip to pan zoom window (horizontal only) -->
    <div
      class="h-5 flex items-center justify-center select-none shrink-0 border-b border-gray-700/60"
      :class="isDragPanning ? 'cursor-grabbing bg-cyan-800/40' : 'cursor-ew-resize bg-gray-800 hover:bg-cyan-900/30'"
      @mousedown="handleDragBarMouseDown"
    >
      <div class="flex items-center gap-0.5 text-gray-600 hover:text-gray-400 transition-colors">
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M15 19l-7-7 7-7" /></svg>
        <div class="w-4 h-1 rounded-full bg-current" />
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7" /></svg>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex flex-row">
    <div
      ref="scrollContainerRef"
      data-track-scroll
      class="flex-1 min-h-0 overflow-y-auto overflow-x-auto track-scroll-container"
      @wheel="handleWheel"
    >
      <div
        ref="contentRef"
        class="relative"
        :style="{ minWidth: `${timelineWidth}px` }"
      >
        <!-- Selection window overlay — visible above tracks (z-[5]) but non-interactive
             (pointer-events-none). Panning is done via the drag bar above tracks;
             edge resizing via the FullWaveform panel's SelectionWindow. -->
        <div
          v-if="tracksStore.timelineDuration > 0 && selectionWindowContainerWidth > 0"
          class="absolute top-0 bottom-0 z-[5] pointer-events-none"
          :style="{ left: `${panelWidth}px`, width: `${selectionWindowContainerWidth}px` }"
        >
          <!-- Dimmed area left of selection -->
          <div
            class="absolute top-0 bottom-0 left-0"
            :style="{
              width: `${(selectionStore.selection.start / tracksStore.timelineDuration) * selectionWindowContainerWidth}px`,
              backgroundColor: 'rgba(0, 0, 0, 0.15)',
            }"
          />
          <!-- Selection window -->
          <div
            class="absolute top-0 bottom-0"
            :style="{
              left: `${(selectionStore.selection.start / tracksStore.timelineDuration) * selectionWindowContainerWidth}px`,
              width: `${((selectionStore.selection.end - selectionStore.selection.start) / tracksStore.timelineDuration) * selectionWindowContainerWidth}px`,
              backgroundColor: 'rgba(255, 255, 255, 0.12)',
              border: '2px solid rgba(255, 255, 255, 0.35)',
            }"
          >
            <!-- Left edge gradient handle -->
            <div class="absolute top-0 bottom-0 left-0 w-1" style="background: linear-gradient(to right, rgba(255,255,255,0.25), transparent);" />
            <!-- Right edge gradient handle -->
            <div class="absolute top-0 bottom-0 right-0 w-1" style="background: linear-gradient(to left, rgba(255,255,255,0.25), transparent);" />
          </div>
          <!-- Dimmed area right of selection -->
          <div
            class="absolute top-0 bottom-0 right-0"
            :style="{
              width: `${((tracksStore.timelineDuration - selectionStore.selection.end) / tracksStore.timelineDuration) * selectionWindowContainerWidth}px`,
              backgroundColor: 'rgba(0, 0, 0, 0.15)',
            }"
          />
        </div>

        <!-- Snap guide line (visible during clip drag when near a snap edge) -->
        <div
          v-if="activeSnapTarget && tracksStore.timelineDuration > 0"
          class="absolute top-0 bottom-0 z-[6] pointer-events-none"
          :style="{
            left: `${panelWidth + (activeSnapTarget.time / tracksStore.timelineDuration) * selectionWindowContainerWidth}px`,
            width: '1px',
            borderLeft: '1px dashed rgba(0, 212, 255, 0.6)',
            transition: 'opacity 100ms',
          }"
        />

        <div
          v-for="track in tracks"
          :key="track.id"
          :data-track-id="track.id"
          class="relative"
          :class="{
            'border-t-2 border-cyan-500': dragOverTrackId === track.id && draggedTrackId !== track.id,
          }"
          draggable="true"
          @mousedown="handleMouseDown"
          @mouseup="handleMouseUp"
          @dragstart="handleDragStart($event, track.id)"
          @dragend="handleDragEnd"
          @dragover="handleDragOver($event, track.id)"
          @dragleave="handleDragLeave"
          @drop="handleDrop($event, track.id)"
        >
          <TrackLane
            :track="track"
            :is-selected="track.id === selectedTrackId"
            :is-cross-track-drag="track.id === clipDraggingTrackId && isCrossTrackDrag"
            @select="selectTrack"
            @toggle-mute="toggleMute"
            @toggle-solo="toggleSolo"
            @delete="deleteTrack"
            @export="handleExport"
            @rename="handleRename"
            @set-volume="handleSetVolume"
            @clip-drag-start="(tid: string, cid: string, ox: number, ev: MouseEvent) => handleClipDragStart(tid, cid, ox, ev)"
            @clip-drag="(tid: string, cid: string, ns: number, ev: MouseEvent) => handleClipDrag(tid, cid, ns, ev)"
            @clip-drag-end="handleClipDragEnd"
            @clip-select="handleClipSelect"
          />
          <!-- Drop target highlight overlay — renders above TrackLane's background -->
          <div
            v-if="clipDragTargetTrackId === track.id && clipDraggingTrackId !== null"
            class="absolute inset-0 pointer-events-none z-[4] bg-cyan-500/15 ring-1 ring-inset ring-cyan-400/50"
          />
        </div>

        <div
          v-if="!tracks.length"
          class="flex flex-col items-center justify-center h-full min-h-[120px] gap-4"
        >
          <img :src="scalpelIcon" alt="" class="invert opacity-[0.06] h-48 object-contain" />
          <div
            class="w-full px-8 text-gray-700/20"
            style="mask-image: linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)"
          >
            <svg class="w-full h-20" viewBox="0 0 1000 80" preserveAspectRatio="none" fill="currentColor">
              <rect x="5" y="34" width="7" height="12" rx="1" /><rect x="15" y="30" width="7" height="20" rx="1" />
              <rect x="25" y="26" width="7" height="28" rx="1" /><rect x="35" y="22" width="7" height="36" rx="1" />
              <rect x="45" y="28" width="7" height="24" rx="1" /><rect x="55" y="18" width="7" height="44" rx="1" />
              <rect x="65" y="24" width="7" height="32" rx="1" /><rect x="75" y="14" width="7" height="52" rx="1" />
              <rect x="85" y="20" width="7" height="40" rx="1" /><rect x="95" y="26" width="7" height="28" rx="1" />
              <rect x="105" y="16" width="7" height="48" rx="1" /><rect x="115" y="22" width="7" height="36" rx="1" />
              <rect x="125" y="10" width="7" height="60" rx="1" /><rect x="135" y="18" width="7" height="44" rx="1" />
              <rect x="145" y="24" width="7" height="32" rx="1" /><rect x="155" y="12" width="7" height="56" rx="1" />
              <rect x="165" y="20" width="7" height="40" rx="1" /><rect x="175" y="8" width="7" height="64" rx="1" />
              <rect x="185" y="16" width="7" height="48" rx="1" /><rect x="195" y="22" width="7" height="36" rx="1" />
              <rect x="205" y="6" width="7" height="68" rx="1" /><rect x="215" y="14" width="7" height="52" rx="1" />
              <rect x="225" y="20" width="7" height="40" rx="1" /><rect x="235" y="10" width="7" height="60" rx="1" />
              <rect x="245" y="18" width="7" height="44" rx="1" /><rect x="255" y="4" width="7" height="72" rx="1" />
              <rect x="265" y="12" width="7" height="56" rx="1" /><rect x="275" y="22" width="7" height="36" rx="1" />
              <rect x="285" y="8" width="7" height="64" rx="1" /><rect x="295" y="16" width="7" height="48" rx="1" />
              <rect x="305" y="2" width="7" height="76" rx="1" /><rect x="315" y="10" width="7" height="60" rx="1" />
              <rect x="325" y="18" width="7" height="44" rx="1" /><rect x="335" y="6" width="7" height="68" rx="1" />
              <rect x="345" y="14" width="7" height="52" rx="1" /><rect x="355" y="22" width="7" height="36" rx="1" />
              <rect x="365" y="8" width="7" height="64" rx="1" /><rect x="375" y="16" width="7" height="48" rx="1" />
              <rect x="385" y="4" width="7" height="72" rx="1" /><rect x="395" y="12" width="7" height="56" rx="1" />
              <rect x="405" y="20" width="7" height="40" rx="1" /><rect x="415" y="6" width="7" height="68" rx="1" />
              <rect x="425" y="14" width="7" height="52" rx="1" /><rect x="435" y="2" width="7" height="76" rx="1" />
              <rect x="445" y="10" width="7" height="60" rx="1" /><rect x="455" y="18" width="7" height="44" rx="1" />
              <rect x="465" y="8" width="7" height="64" rx="1" /><rect x="475" y="16" width="7" height="48" rx="1" />
              <rect x="485" y="4" width="7" height="72" rx="1" /><rect x="495" y="12" width="7" height="56" rx="1" />
              <rect x="505" y="20" width="7" height="40" rx="1" /><rect x="515" y="6" width="7" height="68" rx="1" />
              <rect x="525" y="14" width="7" height="52" rx="1" /><rect x="535" y="2" width="7" height="76" rx="1" />
              <rect x="545" y="10" width="7" height="60" rx="1" /><rect x="555" y="18" width="7" height="44" rx="1" />
              <rect x="565" y="8" width="7" height="64" rx="1" /><rect x="575" y="22" width="7" height="36" rx="1" />
              <rect x="585" y="4" width="7" height="72" rx="1" /><rect x="595" y="14" width="7" height="52" rx="1" />
              <rect x="605" y="6" width="7" height="68" rx="1" /><rect x="615" y="16" width="7" height="48" rx="1" />
              <rect x="625" y="2" width="7" height="76" rx="1" /><rect x="635" y="12" width="7" height="56" rx="1" />
              <rect x="645" y="20" width="7" height="40" rx="1" /><rect x="655" y="8" width="7" height="64" rx="1" />
              <rect x="665" y="16" width="7" height="48" rx="1" /><rect x="675" y="4" width="7" height="72" rx="1" />
              <rect x="685" y="10" width="7" height="60" rx="1" /><rect x="695" y="22" width="7" height="36" rx="1" />
              <rect x="705" y="6" width="7" height="68" rx="1" /><rect x="715" y="14" width="7" height="52" rx="1" />
              <rect x="725" y="8" width="7" height="64" rx="1" /><rect x="735" y="18" width="7" height="44" rx="1" />
              <rect x="745" y="10" width="7" height="60" rx="1" /><rect x="755" y="16" width="7" height="48" rx="1" />
              <rect x="765" y="6" width="7" height="68" rx="1" /><rect x="775" y="12" width="7" height="56" rx="1" />
              <rect x="785" y="20" width="7" height="40" rx="1" /><rect x="795" y="14" width="7" height="52" rx="1" />
              <rect x="805" y="8" width="7" height="64" rx="1" /><rect x="815" y="18" width="7" height="44" rx="1" />
              <rect x="825" y="22" width="7" height="36" rx="1" /><rect x="835" y="12" width="7" height="56" rx="1" />
              <rect x="845" y="16" width="7" height="48" rx="1" /><rect x="855" y="10" width="7" height="60" rx="1" />
              <rect x="865" y="20" width="7" height="40" rx="1" /><rect x="875" y="14" width="7" height="52" rx="1" />
              <rect x="885" y="24" width="7" height="32" rx="1" /><rect x="895" y="18" width="7" height="44" rx="1" />
              <rect x="905" y="22" width="7" height="36" rx="1" /><rect x="915" y="26" width="7" height="28" rx="1" />
              <rect x="925" y="20" width="7" height="40" rx="1" /><rect x="935" y="28" width="7" height="24" rx="1" />
              <rect x="945" y="24" width="7" height="32" rx="1" /><rect x="955" y="30" width="7" height="20" rx="1" />
              <rect x="965" y="26" width="7" height="28" rx="1" /><rect x="975" y="32" width="7" height="16" rx="1" />
              <rect x="985" y="34" width="7" height="12" rx="1" />
            </svg>
          </div>
          <span class="text-xs text-gray-600">Import or record audio</span>
        </div>
      </div>
    </div>

    <!-- Right scroll strip (vertical scroll via drag) -->
    <div
      class="w-5 flex items-center justify-center select-none shrink-0 border-l border-gray-700/60"
      :class="isRightDragging ? 'cursor-grabbing bg-cyan-800/40' : 'cursor-ns-resize bg-gray-800 hover:bg-cyan-900/30'"
      @mousedown="handleRightBarMouseDown"
    >
      <div class="flex flex-col items-center gap-0.5 text-gray-600 hover:text-gray-400 transition-colors">
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 15l7-7 7 7" /></svg>
        <div class="w-1 h-4 rounded-full bg-current" />
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M19 9l-7 7-7-7" /></svg>
      </div>
    </div>
    </div>

    <!-- Bottom scroll strip (horizontal scroll via drag) -->
    <div
      class="h-5 flex items-center justify-center select-none shrink-0 border-t border-gray-700/60"
      :class="isBottomDragging ? 'cursor-grabbing bg-cyan-800/40' : 'cursor-ew-resize bg-gray-800 hover:bg-cyan-900/30'"
      @mousedown="handleBottomBarMouseDown"
    >
      <div class="flex items-center gap-0.5 text-gray-600 hover:text-gray-400 transition-colors">
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M15 19l-7-7 7-7" /></svg>
        <div class="w-4 h-1 rounded-full bg-current" />
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7" /></svg>
      </div>
    </div>

    <!-- Floating drag ghost overlay — follows mouse during clip drag -->
    <div
      v-if="dragGhostActive && ghostWidthPx > 0"
      class="fixed z-50 pointer-events-none rounded overflow-hidden"
      :style="{
        left: `${ghostLeft}px`,
        top: `${ghostTop}px`,
        width: `${ghostWidthPx}px`,
        height: `${TRACK_HEIGHT - 2}px`,
        opacity: 0.4,
        backgroundColor: ghostBgColor,
        border: `1px solid ${ghostBorderColor}`,
      }"
    >
      <canvas ref="ghostCanvasRef" class="w-full h-full" />
    </div>

    <!-- Export profile picker overlay -->
    <div
      v-if="exportPickerTrackId"
      class="absolute inset-0 z-20 flex items-start justify-center pt-4 bg-black/40"
      @click.self="exportPickerTrackId = null"
    >
      <div class="p-3 bg-gray-800 rounded-lg shadow-xl border border-gray-700">
        <div class="flex items-center justify-between mb-2 gap-4">
          <span class="text-xs text-gray-300 truncate">Export: {{ exportPickerTrackName }}</span>
          <button
            class="text-gray-500 hover:text-gray-300 text-sm leading-none"
            @click="exportPickerTrackId = null"
          >
            &times;
          </button>
        </div>
        <div class="flex gap-2">
          <button
            v-for="profile in exportProfiles"
            :key="profile.id"
            :disabled="exporting"
            class="relative flex flex-col items-center justify-center w-[80px] h-[56px] rounded-lg border transition-all
                   border-gray-600 bg-gray-700 text-gray-200 hover:border-cyan-500 hover:bg-gray-600
                   disabled:opacity-50 disabled:cursor-not-allowed"
            @click="handleProfileExport(profile)"
          >
            <span class="text-xs font-medium">{{ profile.format.toUpperCase() }}</span>
            <span class="text-[10px] text-gray-400">{{ formatProfileLabel(profile) }}</span>
            <span v-if="profile.isFavorite" class="absolute top-0.5 right-1 text-[9px] text-yellow-400">&#9733;</span>
          </button>
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

<style scoped>
.track-scroll-container {
  scrollbar-width: none;
  -webkit-user-drag: none;
}
.track-scroll-container * {
  -webkit-user-drag: none;
}
.track-scroll-container::-webkit-scrollbar {
  width: 0;
  height: 0;
}
</style>
