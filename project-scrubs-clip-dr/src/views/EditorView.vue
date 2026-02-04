<script setup lang="ts">
import { inject, computed, ref, watch } from 'vue';
import FullWaveform from '@/components/waveform/FullWaveform.vue';
import ZoomedWaveform from '@/components/waveform/ZoomedWaveform.vue';
import WordTimeline from '@/components/transcription/WordTimeline.vue';
import TrackList from '@/components/tracks/TrackList.vue';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useTracksStore } from '@/stores/tracks';
import { useSettingsStore } from '@/stores/settings';
import { useClipboardStore } from '@/stores/clipboard';
import { useUIStore } from '@/stores/ui';
import { useTranscriptionStore } from '@/stores/transcription';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useKeyboardShortcuts } from '@/services/keyboard-shortcuts';

const { effectiveDuration } = useEffectiveAudio();

// Check for audio using tracks store instead of audioStore.hasFile
const hasAudio = computed(() => tracksStore.hasAudio);
const playbackStore = usePlaybackStore();
const selectionStore = useSelectionStore();
const tracksStore = useTracksStore();
const settingsStore = useSettingsStore();
const clipboardStore = useClipboardStore();
const transcriptionStore = useTranscriptionStore();
const uiStore = useUIStore();

const focusSearch = inject<() => void>('focusSearch');

// Load transcription for the newly selected track
watch(
  () => tracksStore.selectedTrackId,
  (newId, oldId) => {
    if (newId && newId !== oldId) {
      // transcribeAudio checks for existing saved transcription first,
      // falling back to running the model if needed
      transcriptionStore.transcribeAudio().catch(() => {
        // Silently fail - track may not have a transcription
      });
    }
  }
);

// Auto-zoom to show all tracks when a new track is added
watch(
  () => tracksStore.tracks.length,
  (newLen, oldLen) => {
    if (newLen > (oldLen ?? 0) && tracksStore.timelineDuration > 0) {
      // Directly set selection to full timeline, bypassing setSelection()
      // which clamps to the selected track's duration (the new track is auto-selected
      // so getEffectiveDuration() would return just that track, not the full timeline)
      selectionStore.selection = { start: 0, end: tracksStore.timelineDuration };

      // Also zoom track list to fit all content
      const container = document.querySelector('[data-track-scroll]');
      if (container) {
        const containerWidth = container.clientWidth - uiStore.trackPanelWidth;
        uiStore.zoomTrackToFit(tracksStore.timelineDuration, containerWidth);
      }
    }
  }
);

// Clamp selection and re-zoom only when timeline SHRINKS (after cut/delete)
watch(
  () => tracksStore.timelineDuration,
  (newDuration, oldDuration) => {
    if (newDuration <= 0) return;
    // Only act when duration decreased — ignore growth (e.g. during recording)
    if (newDuration >= (oldDuration ?? 0)) return;

    const sel = selectionStore.selection;
    if (sel.end > newDuration || sel.start >= newDuration) {
      selectionStore.selection = {
        start: Math.min(sel.start, Math.max(0, newDuration - (sel.end - sel.start))),
        end: Math.min(sel.end, newDuration),
      };
    }
    // Re-zoom track list to fit updated content
    const container = document.querySelector('[data-track-scroll]');
    if (container) {
      const containerWidth = container.clientWidth - uiStore.trackPanelWidth;
      uiStore.zoomTrackToFit(newDuration, containerWidth);
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

useKeyboardShortcuts({
  onPlayPause: () => playbackStore.togglePlay(),
  onSetIn: () => selectionStore.setInPoint(playbackStore.currentTime),
  onSetOut: () => selectionStore.setOutPoint(playbackStore.currentTime),
  onCreateClip: () => {
    // Create clip is now just paste from clipboard
    clipboardStore.paste();
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
  // Direct shortcuts (X/V/Del without Ctrl)
  onCutDirect: () => clipboardStore.cut(),
  onPasteDirect: () => clipboardStore.paste(),
  onDeleteDirect: () => clipboardStore.deleteSelected(),
  // Zoom shortcuts (+/-)
  onZoomIn: () => uiStore.zoomTrackIn(),
  onZoomOut: () => uiStore.zoomTrackOut(),
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

    <!-- Keyboard shortcuts help -->
    <div class="shrink-0 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">Space</kbd> Play/Pause</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">L</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">→</kbd> Forward</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">J</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">←</kbd> Reverse</span>
      <span>+<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">K</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">↑</kbd>=2x</span>
      <span>+<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">Shift</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">↓</kbd>=0.5x</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">I</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">O</kbd> In/Out</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">C</kbd> Clip</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">X</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">V</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">Del</kbd> Cut/Paste/Delete</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">Tab</kbd> Next Track</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">+</kbd>/<kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">-</kbd> Zoom</span>
      <span><kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">Ctrl</kbd>+Scroll Zoom Tracks</span>
      <span v-if="playbackStore.playbackSpeed !== 1" class="text-cyan-400">{{ playbackStore.playbackSpeed > 0 ? '' : '-' }}{{ Math.abs(playbackStore.playbackSpeed) }}x</span>
    </div>
  </div>
</template>
