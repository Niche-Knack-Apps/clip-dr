<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, inject } from 'vue';
import TranscriptionWord from './TranscriptionWord.vue';
import { useTranscriptionStore } from '@/stores/transcription';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { useAudioStore } from '@/stores/audio';
import { useSearch } from '@/composables/useSearch';
import type { Word } from '@/shared/types';
import { WORD_HEIGHT } from '@/shared/constants';
import { useHistoryStore } from '@/stores/history';

const openSettings = inject<() => void>('openSettings');

const transcriptionStore = useTranscriptionStore();
const selectionStore = useSelectionStore();
const playbackStore = usePlaybackStore();
const audioStore = useAudioStore();
const { getHighlightedWordIndices } = useSearch();

const hasAudio = computed(() => audioStore.hasAudio);

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);

const selection = computed(() => selectionStore.selection);
const currentTime = computed(() => playbackStore.currentTime);
const highlightedIndices = computed(() => getHighlightedWordIndices());

// Drag state
type DragMode = 'none' | 'word' | 'global';
const dragMode = ref<DragMode>('none');
const dragWordId = ref<string | null>(null);
const dragStartX = ref(0);
const dragStartOffsetMs = ref(0);

const visibleWords = computed(() => {
  return transcriptionStore.getWordsInRange(selection.value.start, selection.value.end);
});

const activeWord = computed(() => {
  return transcriptionStore.getWordAtTime(currentTime.value);
});

let resizeObserver: ResizeObserver | null = null;

function updateWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
  }
}

function xToTime(clientX: number): number {
  if (!containerRef.value) return selection.value.start;
  const rect = containerRef.value.getBoundingClientRect();
  const x = clientX - rect.left;
  const range = selection.value.end - selection.value.start;
  return (x / rect.width) * range + selection.value.start;
}

function xToMs(deltaX: number): number {
  if (!containerRef.value) return 0;
  const rect = containerRef.value.getBoundingClientRect();
  const range = selection.value.end - selection.value.start;
  const deltaSec = (deltaX / rect.width) * range;
  return deltaSec * 1000;
}

function getWordPosition(word: Word): { left: number; width: number } {
  const range = selection.value.end - selection.value.start;
  const wordStart = Math.max(word.start, selection.value.start);
  const wordEnd = Math.min(word.end, selection.value.end);

  const left = ((wordStart - selection.value.start) / range) * containerWidth.value;
  const width = ((wordEnd - wordStart) / range) * containerWidth.value;

  return { left, width: Math.max(width, 20) };
}

function handleWordClick(word: Word) {
  if (dragMode.value === 'none') {
    playbackStore.seek(word.start);
  }
}

function handleWordTextUpdate(wordId: string, newText: string) {
  transcriptionStore.updateWordText(wordId, newText);
}

function handleWordDragStart(event: MouseEvent, word: Word) {
  event.preventDefault();
  event.stopPropagation();

  useHistoryStore().pushState('Adjust word timing');
  dragMode.value = 'word';
  dragWordId.value = word.id;
  dragStartX.value = event.clientX;
  dragStartOffsetMs.value = transcriptionStore.getWordOffset(word.id);

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleGlobalDragStart(event: MouseEvent) {
  event.preventDefault();

  useHistoryStore().pushState('Shift all words');
  dragMode.value = 'global';
  dragStartX.value = event.clientX;
  dragStartOffsetMs.value = transcriptionStore.globalOffsetMs;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  const deltaX = event.clientX - dragStartX.value;
  const deltaMs = xToMs(deltaX);

  if (dragMode.value === 'word' && dragWordId.value) {
    const newOffsetMs = dragStartOffsetMs.value + deltaMs;
    transcriptionStore.setWordOffset(dragWordId.value, newOffsetMs);
  } else if (dragMode.value === 'global') {
    const newOffsetMs = dragStartOffsetMs.value + deltaMs;
    transcriptionStore.setGlobalOffset(newOffsetMs);
  }
}

function handleMouseUp() {
  if (dragMode.value !== 'none' && transcriptionStore.hasUnsavedChanges) {
    // Auto-save timing adjustments
    transcriptionStore.saveTimingMetadata();
  }

  dragMode.value = 'none';
  dragWordId.value = null;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}

function isWordHighlighted(word: Word): boolean {
  const allWords = transcriptionStore.adjustedWords;
  const index = allWords.findIndex((w) => w.id === word.id);
  return highlightedIndices.value.has(index);
}

function isWordBeingDragged(word: Word): boolean {
  return dragMode.value === 'word' && dragWordId.value === word.id;
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
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
});
</script>

<template>
  <div class="flex flex-col">
    <!-- Words area -->
    <div
      ref="containerRef"
      class="relative bg-track-bg overflow-hidden"
      :style="{ height: `${WORD_HEIGHT}px` }"
    >
      <div
        v-for="word in visibleWords"
        :key="word.id"
        class="absolute top-0 flex items-center group"
        :class="{
          'cursor-grab': dragMode === 'none',
          'cursor-grabbing': isWordBeingDragged(word),
          'z-10': isWordBeingDragged(word),
        }"
        :style="{
          left: `${getWordPosition(word).left}px`,
          width: `${getWordPosition(word).width}px`,
          height: '100%',
        }"
        @mousedown="handleWordDragStart($event, word)"
      >
        <TranscriptionWord
          :word="word"
          :is-active="activeWord?.id === word.id"
          :is-highlighted="isWordHighlighted(word)"
          :is-dragging="isWordBeingDragged(word)"
          @click="handleWordClick"
          @update-text="handleWordTextUpdate"
        />
      </div>

      <div
        v-if="!visibleWords.length && transcriptionStore.hasTranscription"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-500"
      >
        No words in this region
      </div>

      <!-- Context-aware messages when no transcription -->
      <div
        v-if="!transcriptionStore.hasTranscription && !transcriptionStore.hasModel && hasAudio"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-500 italic px-2"
      >
        Whisper model not found.
        <button
          class="text-cyan-400 hover:underline cursor-pointer ml-1"
          @click="openSettings?.()"
        >
          Configure in Settings
        </button>
      </div>

      <div
        v-else-if="!transcriptionStore.hasTranscription && transcriptionStore.loading"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
      >
        <svg class="animate-spin h-3 w-3 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        Transcribing...
      </div>

      <div
        v-else-if="!transcriptionStore.hasTranscription && transcriptionStore.error"
        class="absolute inset-0 flex items-center justify-center text-xs text-red-400 px-2"
      >
        {{ transcriptionStore.error }}
      </div>

      <div
        v-else-if="!transcriptionStore.hasTranscription && !hasAudio"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-600"
      >
        Load audio to see transcription
      </div>

      <div
        v-else-if="!transcriptionStore.hasTranscription"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-600"
      >
        No transcription available
      </div>
    </div>

    <!-- Global offset drag bar -->
    <div
      v-if="transcriptionStore.hasTranscription"
      class="h-4 bg-gray-800 border-t border-gray-700 flex items-center transition-colors"
      :class="{ 'bg-cyan-900/30': dragMode === 'global' }"
    >
      <!-- Falloff toggle -->
      <label
        class="flex items-center gap-1 px-2 text-[9px] text-gray-500 cursor-pointer hover:text-gray-400 select-none"
        @click.stop
        title="When enabled, dragging a word pulls neighbors with diminishing force"
      >
        <input
          type="checkbox"
          :checked="transcriptionStore.enableFalloff"
          class="w-2.5 h-2.5 rounded border-gray-600 bg-gray-700 text-cyan-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
          @change="transcriptionStore.setEnableFalloff(($event.target as HTMLInputElement).checked)"
          @click.stop
        />
        Pull
      </label>

      <!-- Drag area -->
      <div
        class="flex-1 h-full cursor-ew-resize flex items-center justify-center hover:bg-gray-750"
        @mousedown="handleGlobalDragStart"
      >
        <div class="flex items-center gap-1 text-[9px] text-gray-500 select-none">
          <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
          </svg>
          <span v-if="transcriptionStore.globalOffsetMs !== 0">
            {{ transcriptionStore.globalOffsetMs > 0 ? '+' : '' }}{{ Math.round(transcriptionStore.globalOffsetMs) }}ms
          </span>
          <span v-else>Drag to shift all words</span>
        </div>
      </div>
    </div>
  </div>
</template>
