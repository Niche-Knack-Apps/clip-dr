<script setup lang="ts">
import { inject, computed, ref, watch, nextTick, onUnmounted } from 'vue';
import FullWaveform from '@/components/waveform/FullWaveform.vue';
import ZoomedWaveform from '@/components/waveform/ZoomedWaveform.vue';
import WordTimeline from '@/components/transcription/WordTimeline.vue';
import TrackList from '@/components/tracks/TrackList.vue';
import ProgressModal from '@/components/ui/ProgressModal.vue';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useTracksStore } from '@/stores/tracks';
import { useSettingsStore } from '@/stores/settings';
import { useClipboardStore } from '@/stores/clipboard';
import { useUIStore } from '@/stores/ui';
import { useTranscriptionStore } from '@/stores/transcription';
import { useHistoryStore } from '@/stores/history';
import { useRecordingStore } from '@/stores/recording';
import { useExportStore } from '@/stores/export';
import { useProjectStore } from '@/stores/project';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useClipping } from '@/composables/useClipping';
import { useKeyboardShortcuts } from '@/services/keyboard-shortcuts';
import { ALL_SHORTCUT_HINTS } from '@/shared/constants';

const { effectiveDuration } = useEffectiveAudio();
const { createClip } = useClipping();

// Check for audio using tracks store instead of audioStore.hasFile
const hasAudio = computed(() => tracksStore.hasAudio);
const playbackStore = usePlaybackStore();
const selectionStore = useSelectionStore();
const tracksStore = useTracksStore();
const settingsStore = useSettingsStore();
const clipboardStore = useClipboardStore();
const transcriptionStore = useTranscriptionStore();
const historyStore = useHistoryStore();
const recordingStore = useRecordingStore();
const exportStore = useExportStore();
const projectStore = useProjectStore();
const uiStore = useUIStore();

// Set up dirty tracking for project state
projectStore.setupDirtyTracking();

const focusSearch = inject<() => void>('focusSearch');

// Load transcription for the newly selected track (non-blocking)
watch(
  () => tracksStore.selectedTrackId,
  (newId) => {
    if (!newId || newId === 'ALL') return;
    // Non-blocking: load from disk or queue background transcription
    transcriptionStore.loadOrQueueTranscription(newId);
  }
);

// Set selection to full timeline when a new track is added
// Uses nextTick to ensure this runs AFTER the track-selection watcher
watch(
  () => tracksStore.tracks.length,
  async (newLen, oldLen) => {
    if (newLen > (oldLen ?? 0) && tracksStore.timelineDuration > 0) {
      await nextTick();
      selectionStore.selection = { start: 0, end: tracksStore.timelineDuration };
    }
  }
);

// When a specific track is selected, move the selection window to show its audio
watch(
  () => tracksStore.selectedTrackId,
  (newId) => {
    if (!newId || newId === 'ALL') return;
    const track = tracksStore.tracks.find(t => t.id === newId);
    if (!track) return;

    const trackStart = track.trackStart;
    const trackEnd = trackStart + track.duration;

    // Move selection to encompass this track's audio
    selectionStore.setSelection(trackStart, trackEnd);

    console.log(`[EditorView] Track selected: "${track.name}", moving selection to ${trackStart.toFixed(2)}-${trackEnd.toFixed(2)}s`);
  }
);

// Clamp selection when timeline shrinks (after cut/delete)
watch(
  () => tracksStore.timelineDuration,
  (newDuration, oldDuration) => {
    if (newDuration <= 0) return;
    if (newDuration >= (oldDuration ?? 0)) return;

    const sel = selectionStore.selection;
    if (sel.end > newDuration || sel.start >= newDuration) {
      selectionStore.selection = {
        start: Math.min(sel.start, Math.max(0, newDuration - (sel.end - sel.start))),
        end: Math.min(sel.end, newDuration),
      };
    }
  }
);

// Section resize state
const isResizingWaveform = ref(false);
const isResizingZoomed = ref(false);
const resizeStartY = ref(0);
const resizeStartHeight = ref(0);

// Resize handlers for waveform section
function startWaveformResize(event: MouseEvent) {
  event.preventDefault();
  isResizingWaveform.value = true;
  resizeStartY.value = event.clientY;
  resizeStartHeight.value = uiStore.waveformHeight;

  document.addEventListener('mousemove', handleWaveformResize);
  document.addEventListener('mouseup', stopWaveformResize);
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
}

function handleWaveformResize(event: MouseEvent) {
  if (!isResizingWaveform.value) return;
  const delta = event.clientY - resizeStartY.value;
  uiStore.setWaveformHeight(resizeStartHeight.value + delta);
}

function stopWaveformResize() {
  isResizingWaveform.value = false;
  document.removeEventListener('mousemove', handleWaveformResize);
  document.removeEventListener('mouseup', stopWaveformResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

// Resize handlers for zoomed section
function startZoomedResize(event: MouseEvent) {
  event.preventDefault();
  isResizingZoomed.value = true;
  resizeStartY.value = event.clientY;
  resizeStartHeight.value = uiStore.zoomedHeight;

  document.addEventListener('mousemove', handleZoomedResize);
  document.addEventListener('mouseup', stopZoomedResize);
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
}

function handleZoomedResize(event: MouseEvent) {
  if (!isResizingZoomed.value) return;
  const delta = event.clientY - resizeStartY.value;
  uiStore.setZoomedHeight(resizeStartHeight.value + delta);
}

function stopZoomedResize() {
  isResizingZoomed.value = false;
  document.removeEventListener('mousemove', handleZoomedResize);
  document.removeEventListener('mouseup', stopZoomedResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

// Clean up document-level event listeners and timers on unmount
onUnmounted(() => {
  document.removeEventListener('mousemove', handleWaveformResize);
  document.removeEventListener('mouseup', stopWaveformResize);
  document.removeEventListener('mousemove', handleZoomedResize);
  document.removeEventListener('mouseup', stopZoomedResize);
  if (exportModalTimer) { clearTimeout(exportModalTimer); exportModalTimer = null; }
  if (importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
});

// Keyboard shortcuts modal
const showShortcutsModal = ref(false);

// --- Export progress modal with 5s delay ---
const showExportModal = ref(false);
let exportModalTimer: ReturnType<typeof setTimeout> | null = null;

watch(() => exportStore.loading, (isLoading) => {
  if (isLoading) {
    exportModalTimer = setTimeout(() => { showExportModal.value = true; }, 5000);
  } else {
    if (exportModalTimer) { clearTimeout(exportModalTimer); exportModalTimer = null; }
    showExportModal.value = false;
  }
});

// --- Large-file import/caching (polling for non-reactive importDecodeProgress) ---
const showImportModal = ref(false);
const importProgress = ref(0);
const importSubtitle = ref('');
let importPollTimer: ReturnType<typeof setInterval> | null = null;

function pollCachingProgress() {
  const track = tracksStore.tracks.find(t => t.importStatus === 'caching');
  if (track) {
    importProgress.value = Math.round((track.importDecodeProgress ?? 0) * 100);
    importSubtitle.value = track.name;
  } else {
    showImportModal.value = false;
    importProgress.value = 0;
    importSubtitle.value = '';
    if (importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
  }
}

watch(
  () => tracksStore.tracks,
  (tracks) => {
    const caching = tracks.find(t => t.importStatus === 'caching');
    if (caching && !showImportModal.value) {
      showImportModal.value = true;
      importSubtitle.value = caching.name;
      importProgress.value = Math.round((caching.importDecodeProgress ?? 0) * 100);
      if (!importPollTimer) {
        importPollTimer = setInterval(pollCachingProgress, 250);
      }
    } else if (!caching && showImportModal.value) {
      showImportModal.value = false;
      importProgress.value = 0;
      importSubtitle.value = '';
      if (importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
    }
  },
  { immediate: true }
);

// --- Unified progress modal state (export takes priority) ---
const showProgressModal = computed(() => showExportModal.value || showImportModal.value);

const progressModalTitle = computed(() => {
  if (showExportModal.value) return 'Exporting...';
  return 'Importing large file...';
});

const progressModalProgress = computed(() => {
  if (showExportModal.value) return exportStore.progress;
  return importProgress.value;
});

const progressModalSubtitle = computed(() => {
  if (showExportModal.value) {
    const p = exportStore.currentExportPath;
    return p ? p.split(/[/\\]/).pop() ?? '' : '';
  }
  return importSubtitle.value;
});

// Dynamic bottom bar hints
const activeHints = computed(() => {
  const enabled = settingsStore.settings.shortcutHints;
  return ALL_SHORTCUT_HINTS.filter(h => enabled.includes(h.id));
});

useKeyboardShortcuts({
  onPlayPause: () => playbackStore.togglePlay(),
  onSetIn: () => selectionStore.setInPoint(playbackStore.currentTime),
  onSetOut: () => selectionStore.setOutPoint(playbackStore.currentTime),
  onCreateClip: () => {
    createClip();
  },
  onJumpStart: () => playbackStore.seek(0),
  onJumpEnd: () => playbackStore.seek(effectiveDuration.value),
  onJumpIn: () => {
    const { inPoint } = selectionStore.inOutPoints;
    if (inPoint !== null) playbackStore.seek(inPoint);
  },
  onJumpOut: () => {
    const { outPoint } = selectionStore.inOutPoints;
    if (outPoint !== null) playbackStore.seek(outPoint);
  },
  onDeleteTrack: () => clipboardStore.deleteSelected(),
  onFocusSearch: () => focusSearch?.(),
  // New shortcuts
  onJumpLayerStart: () => playbackStore.jumpToLayerStart(),
  onJumpLayerEnd: () => playbackStore.jumpToLayerEnd(),
  onSpeedUp: () => playbackStore.speedUp(),
  onSpeedDown: () => playbackStore.speedDown(),
  onNudge: (ms) => playbackStore.nudge(ms),
  // JKL playback actions
  onJklPlay: (speed, reverse) => playbackStore.jklPlayAtSpeed(speed, reverse),
  onJklStop: () => playbackStore.jklStop(),
  // Clipboard actions (Ctrl+X/C/V)
  onCut: () => clipboardStore.cut(),
  onCopy: () => clipboardStore.copy(),
  onPaste: () => clipboardStore.paste(),
  // Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
  onUndo: () => historyStore.undo(),
  onRedo: () => historyStore.redo(),
  // Direct shortcuts (X/V/Del without Ctrl)
  onCutDirect: () => clipboardStore.cut(),
  onPasteDirect: () => clipboardStore.paste(),
  onDeleteDirect: () => clipboardStore.deleteSelected(),
  // Zoom shortcuts (+/-)
  onZoomIn: () => uiStore.zoomTrackIn(),
  onZoomOut: () => uiStore.zoomTrackOut(),
  onNextMarker: () => playbackStore.jumpToNextMarker(),
  onPreviousMarker: () => playbackStore.jumpToPreviousMarker(),
  onAddTimemark: () => {
    if (recordingStore.isRecording) {
      recordingStore.addTimemark();
    } else {
      // Add marker at playhead on selected (or first) track
      const trackId = tracksStore.selectedTrackId && tracksStore.selectedTrackId !== 'ALL'
        ? tracksStore.selectedTrackId
        : tracksStore.tracks[0]?.id;
      if (trackId) {
        tracksStore.addTimemark(trackId, playbackStore.currentTime, 'Marker');
      }
    }
  },
  // Track selection cycling (Tab/Shift+Tab)
  onSelectNextTrack: () => {
    const tracks = tracksStore.tracks;
    if (tracks.length === 0) return;
    const currentId = tracksStore.selectedTrackId;
    if (currentId === 'ALL' || currentId === null) {
      tracksStore.selectTrack(tracks[0].id);
    } else {
      const idx = tracks.findIndex(t => t.id === currentId);
      const nextIdx = (idx + 1) % tracks.length;
      tracksStore.selectTrack(tracks[nextIdx].id);
    }
  },
  onSelectPrevTrack: () => {
    const tracks = tracksStore.tracks;
    if (tracks.length === 0) return;
    const currentId = tracksStore.selectedTrackId;
    if (currentId === 'ALL' || currentId === null) {
      tracksStore.selectTrack(tracks[tracks.length - 1].id);
    } else {
      const idx = tracks.findIndex(t => t.id === currentId);
      const prevIdx = (idx - 1 + tracks.length) % tracks.length;
      tracksStore.selectTrack(tracks[prevIdx].id);
    }
  },
  // Quick Re-Export (Ctrl+Shift+E)
  onQuickExport: () => exportStore.quickReExport(),
  // Project save/open (Ctrl+S / Ctrl+O)
  onSaveProject: () => projectStore.saveProject(),
  onOpenProject: () => projectStore.openProject(),
  // Help modal
  onShowHelp: () => { showShortcutsModal.value = !showShortcutsModal.value; },
  // Loop mode shortcuts (Q/W/E/R/T) — also enables looping if disabled
  onSetLoopMode: (mode) => {
    if (!playbackStore.loopEnabled) {
      playbackStore.setLoopEnabled(true);
    }
    playbackStore.setLoopMode(mode);
  },
});
</script>

<template>
  <div class="h-full flex flex-col p-3 gap-2 overflow-hidden">
    <!-- Empty state -->
    <div
      v-if="!hasAudio"
      class="flex-1 flex flex-col items-center justify-center text-gray-500"
    >
      <svg class="w-16 h-16 mb-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="m24 9.5a3.5 3.5 0 1 0 -5 3.15v3.35a5 5 0 0 1 -10 0v-.151a7.513 7.513 0 0 0 6-7.349v-5a3.5 3.5 0 0 0 -3.5-3.5h-2.5v3h2.5a.5.5 0 0 1 .5.5v5a4.5 4.5 0 0 1 -9 0v-5a.5.5 0 0 1 .5-.5h2.5v-3h-2.5a3.5 3.5 0 0 0 -3.5 3.5v5a7.513 7.513 0 0 0 6 7.349v.151a8 8 0 0 0 16 0v-3.35a3.491 3.491 0 0 0 2-3.15z"/>
      </svg>
      <p class="text-lg font-medium mb-2">Get your scrubs!</p>
      <p class="text-sm">Import or record audio to get started</p>
    </div>

    <!-- Editor -->
    <template v-else>
      <!-- Full Waveform -->
      <div class="shrink-0">
        <FullWaveform :height="uiStore.waveformHeight" />
      </div>

      <!-- Resize handle between waveform and zoomed -->
      <div
        class="shrink-0 h-2 -my-1 cursor-ns-resize hover:bg-cyan-500/30 transition-colors flex items-center justify-center group z-10"
        :class="{ 'bg-cyan-500/30': isResizingWaveform }"
        @mousedown="startWaveformResize"
      >
        <div class="w-12 h-1 bg-gray-600 group-hover:bg-cyan-400 rounded-full transition-colors" />
      </div>

      <!-- Zoomed Waveform -->
      <div class="shrink-0">
        <ZoomedWaveform :height="uiStore.zoomedHeight" />
      </div>

      <!-- Word Timeline (transcription) -->
      <WordTimeline v-if="settingsStore.settings.showTranscription" class="shrink-0" />

      <!-- Resize handle between zoomed/transcription and tracks -->
      <div
        class="shrink-0 h-2 -my-1 cursor-ns-resize hover:bg-cyan-500/30 transition-colors flex items-center justify-center group z-10"
        :class="{ 'bg-cyan-500/30': isResizingZoomed }"
        @mousedown="startZoomedResize"
      >
        <div class="w-12 h-1 bg-gray-600 group-hover:bg-cyan-400 rounded-full transition-colors" />
      </div>

      <!-- Tracks -->
      <div class="flex-1 min-h-0">
        <TrackList />
      </div>
    </template>

    <!-- Keyboard shortcuts help (dynamic) -->
    <div class="shrink-0 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
      <span
        v-for="hint in activeHints"
        :key="hint.id"
        :class="{ 'cursor-pointer hover:text-gray-200': hint.id === 'help' }"
        @click="hint.id === 'help' ? (showShortcutsModal = true) : undefined"
      >
        <kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">{{ hint.keys }}</kbd> {{ hint.label }}
      </span>
      <span v-if="playbackStore.playbackSpeed !== 1" class="text-cyan-400">{{ playbackStore.playbackSpeed > 0 ? '' : '-' }}{{ Math.abs(playbackStore.playbackSpeed) }}x</span>
    </div>

    <!-- Progress modal (export / large-file import) -->
    <ProgressModal
      :visible="showProgressModal"
      :title="progressModalTitle"
      :progress="progressModalProgress"
      :subtitle="progressModalSubtitle"
    />

    <!-- Keyboard shortcuts modal -->
    <Teleport to="body">
      <div
        v-if="showShortcutsModal"
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        @click.self="showShortcutsModal = false"
        @keydown.escape="showShortcutsModal = false"
      >
        <div class="bg-gray-900 rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
          <div class="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <h2 class="text-lg font-medium">Keyboard Shortcuts</h2>
            <button
              type="button"
              class="p-1 text-gray-400 hover:text-gray-200 transition-colors"
              @click="showShortcutsModal = false"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="p-4 space-y-4 overflow-y-auto flex-1 text-sm">
            <!-- Playback -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Playback</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Play / Pause</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Space</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Forward</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">L</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&rarr;</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Reverse</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">J</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&larr;</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">2x speed (hold with J/L)</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">K</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">0.5x speed (hold with J/L)</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Shift</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Speed up</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&uarr;</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Speed down</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&darr;</kbd></div>
              </div>
            </div>

            <!-- Navigation -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Navigation</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Jump to start / end</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Home</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">End</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Jump to In / Out point</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">[</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">]</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Jump to track start / end</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">S</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">D</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Previous / next marker</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&lt;</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">&gt;</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Next / previous track</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Tab</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Shift+Tab</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Nudge (10ms per digit)</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">1</kbd>&ndash;<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">9</kbd></span></div>
              </div>
            </div>

            <!-- Loop Modes -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Loop Modes</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Full</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Q</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Zoom</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">W</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">In/Out</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">E</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Active tracks</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">R</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Clip</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">T</kbd></div>
              </div>
            </div>

            <!-- Editing -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Editing</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Set In / Out point</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">I</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">O</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Create clip</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">C</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Cut</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">X</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Paste</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">V</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Delete</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Del</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Cut / Copy / Paste (system)</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">X</kbd>/<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">C</kbd>/<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">V</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Undo / Redo</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Z</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Shift</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Z</kbd></span></div>
              </div>
            </div>

            <!-- Zoom -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Zoom</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Zoom in / out</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">+</kbd> / <kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">-</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Zoom tracks</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+Scroll</span></div>
              </div>
            </div>

            <!-- Other -->
            <div>
              <h3 class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Other</h3>
              <div class="space-y-1">
                <div class="flex justify-between"><span class="text-gray-400">Search</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">F</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Quick Re-Export</span><span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Ctrl</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">Shift</kbd>+<kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">E</kbd></span></div>
                <div class="flex justify-between"><span class="text-gray-400">Add marker at playhead</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">M</kbd></div>
                <div class="flex justify-between"><span class="text-gray-400">Show this modal</span><kbd class="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">?</kbd></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
