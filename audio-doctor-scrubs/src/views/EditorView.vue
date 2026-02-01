<script setup lang="ts">
import { inject } from 'vue';
import FullWaveform from '@/components/waveform/FullWaveform.vue';
import ZoomedWaveform from '@/components/waveform/ZoomedWaveform.vue';
import WordTimeline from '@/components/transcription/WordTimeline.vue';
import TrackList from '@/components/tracks/TrackList.vue';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useTracksStore } from '@/stores/tracks';
import { useSettingsStore } from '@/stores/settings';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useKeyboardShortcuts } from '@/services/keyboard-shortcuts';

const audioStore = useAudioStore();
const { effectiveDuration } = useEffectiveAudio();
const playbackStore = usePlaybackStore();
const selectionStore = useSelectionStore();
const tracksStore = useTracksStore();
const settingsStore = useSettingsStore();

const focusSearch = inject<() => void>('focusSearch');

useKeyboardShortcuts({
  onPlayPause: () => playbackStore.togglePlay(),
  onSetIn: () => selectionStore.setInPoint(playbackStore.currentTime),
  onSetOut: () => selectionStore.setOutPoint(playbackStore.currentTime),
  onCreateClip: () => {
    if (selectionStore.hasInOutPoints) {
      tracksStore.createClip();
    }
  },
  onToggleLoop: () => playbackStore.setLoopEnabled(!playbackStore.loopEnabled),
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
  onDeleteTrack: () => {
    const selected = tracksStore.selectedTrack;
    if (selected && selected.type === 'clip') {
      tracksStore.deleteTrack(selected.id);
    }
  },
  onFocusSearch: () => focusSearch?.(),
  // New shortcuts
  onJumpLayerStart: () => playbackStore.jumpToLayerStart(),
  onJumpLayerEnd: () => playbackStore.jumpToLayerEnd(),
  onSpeedUp: () => playbackStore.speedUp(),
  onSpeedDown: () => playbackStore.speedDown(),
  onNudge: (ms) => playbackStore.nudge(ms),
});
</script>

<template>
  <div class="h-full flex flex-col p-3 gap-3 overflow-hidden">
    <!-- Empty state -->
    <div
      v-if="!audioStore.hasFile"
      class="flex-1 flex flex-col items-center justify-center text-gray-500"
    >
      <svg class="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1"
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
        />
      </svg>
      <p class="text-lg font-medium mb-2">No audio loaded</p>
      <p class="text-sm">Click "Import" to load an audio file</p>
    </div>

    <!-- Editor -->
    <template v-else>
      <!-- Full Waveform -->
      <div class="shrink-0">
        <FullWaveform />
      </div>

      <!-- Zoomed Waveform + Transcription -->
      <div class="shrink-0">
        <ZoomedWaveform />
        <WordTimeline v-if="settingsStore.settings.showTranscription" />
      </div>

      <!-- Tracks -->
      <div class="flex-1 min-h-0">
        <TrackList />
      </div>
    </template>

    <!-- Keyboard shortcuts help -->
    <div class="shrink-0 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-gray-600">
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">Space</kbd> Play/Pause</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">S</kbd>/<kbd class="px-1 py-0.5 bg-gray-800 rounded">E</kbd> Layer Start/End</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">→</kbd>/<kbd class="px-1 py-0.5 bg-gray-800 rounded">←</kbd> Speed Up/Reverse</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">1-9</kbd> Nudge 10-90ms</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">I</kbd>/<kbd class="px-1 py-0.5 bg-gray-800 rounded">O</kbd> In/Out</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">C</kbd> Clip</span>
      <span><kbd class="px-1 py-0.5 bg-gray-800 rounded">L</kbd> Loop</span>
      <span v-if="playbackStore.playbackSpeed !== 1" class="text-cyan-400">{{ playbackStore.playbackSpeed }}x</span>
    </div>
  </div>
</template>
