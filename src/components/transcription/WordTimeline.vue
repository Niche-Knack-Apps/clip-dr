<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, inject } from 'vue';
import TranscriptionWord from './TranscriptionWord.vue';
import { useTranscriptionStore } from '@/stores/transcription';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { useAudioStore } from '@/stores/audio';
import { useSearch } from '@/composables/useSearch';
import type { Word, Track } from '@/shared/types';
import { WORD_HEIGHT } from '@/shared/constants';
import { useHistoryStore } from '@/stores/history';
import { TRACK_COLORS } from '@/shared/types';

const openSettings = inject<() => void>('openSettings');

const transcriptionStore = useTranscriptionStore();
const tracksStore = useTracksStore();
const selectionStore = useSelectionStore();
const playbackStore = usePlaybackStore();
const audioStore = useAudioStore();
const { getHighlightedWordIndices } = useSearch();

const hasAudio = computed(() => audioStore.hasAudio);

// Selected track ID (for editing operations like drag, text edit, falloff)
const selectedTrackId = computed(() => {
  const sel = tracksStore.selectedTrackId;
  if (!sel || sel === 'ALL') return null;
  return sel;
});

// Extended word type carrying the source trackId
interface WordWithTrack extends Word {
  trackId: string;
}

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(0);

const selection = computed(() => selectionStore.selection);
const currentTime = computed(() => playbackStore.currentTime);
const highlightedIndices = computed(() => getHighlightedWordIndices());

// Drag state
type DragMode = 'none' | 'word' | 'global';
const dragMode = ref<DragMode>('none');
const dragWordId = ref<string | null>(null);
const dragTrackId = ref<string | null>(null);
const dragStartX = ref(0);
const dragStartOffsetMs = ref(0);
const globalDragLastX = ref(0);

// Active tracks (same logic as playback: solo+unmuted → only those, else all unmuted)
const activeTrackIds = computed((): Set<string> => {
  const tracks = tracksStore.tracks;
  const playable = tracks.filter((t: Track) =>
    !t.importStatus || t.importStatus === 'ready' || t.importStatus === 'large-file' || t.importStatus === 'caching'
  );
  const soloed = playable.filter((t: Track) => t.solo && !t.muted);
  const active = soloed.length > 0 ? soloed : playable.filter((t: Track) => !t.muted);
  return new Set(active.map((t: Track) => t.id));
});

function getTrackColor(trackId: string): string {
  const track = tracksStore.tracks.find((t: Track) => t.id === trackId);
  return track?.color ?? TRACK_COLORS[0];
}

// Show words from active tracks in the visible range
const visibleWords = computed((): WordWithTrack[] => {
  const allWords: WordWithTrack[] = [];
  const activeIds = activeTrackIds.value;
  for (const track of tracksStore.tracks) {
    if (!activeIds.has(track.id)) continue;
    const words = transcriptionStore.getWordsInRange(track.id, selection.value.start, selection.value.end);
    for (const w of words) {
      allWords.push({ ...w, trackId: track.id });
    }
  }
  allWords.sort((a, b) => a.start - b.start);
  return allWords;
});

// Check if ANY track has a transcription
const hasAnyTranscription = computed(() => {
  return tracksStore.tracks.some(t => transcriptionStore.hasTranscriptionForTrack(t.id));
});

// Density check: when words are too small to read, skip rendering them
const wordsTooSmallToRead = computed(() => {
  if (visibleWords.value.length === 0) return false;
  const range = selection.value.end - selection.value.start;
  if (range <= 0 || containerWidth.value <= 0) return false;
  const avgWordDuration = range / visibleWords.value.length;
  const avgWordPx = (avgWordDuration / range) * containerWidth.value;
  return avgWordPx < 25;
});

// rAF-throttled active word to avoid per-frame recomputation
const activeWord = ref<WordWithTrack | null>(null);
let activeWordRafId: number | null = null;

watch(currentTime, () => {
  if (activeWordRafId !== null) return;
  activeWordRafId = requestAnimationFrame(() => {
    activeWordRafId = null;
    const activeIds = activeTrackIds.value;
    let found: WordWithTrack | null = null;
    for (const track of tracksStore.tracks) {
      if (!activeIds.has(track.id)) continue;
      const word = transcriptionStore.getWordAtTime(track.id, currentTime.value);
      if (word) { found = { ...word, trackId: track.id }; break; }
    }
    activeWord.value = found;
  });
});

// Get the per-track enableFalloff (for selected track)
const enableFalloff = computed(() => {
  if (!selectedTrackId.value) return true;
  return transcriptionStore.getTranscription(selectedTrackId.value)?.enableFalloff ?? true;
});

let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;

// RAF-throttled drag state
let dragRafId: number | null = null;
let pendingDragEvent: MouseEvent | null = null;

function updateWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
  }
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

function handleWordTextUpdate(wordTrackId: string, wordId: string, newText: string) {
  transcriptionStore.updateWordText(wordTrackId, wordId, newText);
}

function handleWordDragStart(event: MouseEvent, word: WordWithTrack) {
  event.preventDefault();
  event.stopPropagation();

  useHistoryStore().pushState('Adjust word timing');
  dragMode.value = 'word';
  dragWordId.value = word.id;
  dragTrackId.value = word.trackId;
  dragStartX.value = event.clientX;
  dragStartOffsetMs.value = transcriptionStore.getWordOffset(word.trackId, word.id);

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleGlobalDragStart(event: MouseEvent) {
  event.preventDefault();
  if (!selectedTrackId.value) return;
  if (!transcriptionStore.hasTranscriptionForTrack(selectedTrackId.value)) return;

  useHistoryStore().pushState('Shift all words');
  dragMode.value = 'global';
  dragTrackId.value = selectedTrackId.value;
  globalDragLastX.value = event.clientX;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  pendingDragEvent = event;
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDrag);
  }
}

function flushDrag() {
  dragRafId = null;
  if (!pendingDragEvent) return;
  const event = pendingDragEvent;
  pendingDragEvent = null;

  if (dragMode.value === 'word' && dragWordId.value && dragTrackId.value) {
    const deltaX = event.clientX - dragStartX.value;
    const deltaMs = xToMs(deltaX);
    const newOffsetMs = dragStartOffsetMs.value + deltaMs;
    transcriptionStore.setWordOffset(dragTrackId.value, dragWordId.value, newOffsetMs);
  } else if (dragMode.value === 'global' && dragTrackId.value) {
    const deltaX = event.clientX - globalDragLastX.value;
    globalDragLastX.value = event.clientX;
    const deltaMs = xToMs(deltaX);
    transcriptionStore.shiftAllWords(dragTrackId.value, deltaMs);
  }
}

function handleMouseUp() {
  // Flush any pending RAF drag update before finalizing
  if (pendingDragEvent) flushDrag();
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }

  if (dragMode.value !== 'none' && dragTrackId.value) {
    transcriptionStore.saveTranscription(dragTrackId.value);
  }

  dragMode.value = 'none';
  dragWordId.value = null;
  dragTrackId.value = null;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}

function isWordHighlighted(word: WordWithTrack): boolean {
  // Search only highlights words in the selected track
  if (word.trackId !== selectedTrackId.value) return false;
  const allWords = transcriptionStore.getAdjustedWords(word.trackId);
  const index = allWords.findIndex((w) => w.id === word.id);
  return highlightedIndices.value.has(index);
}

function isWordBeingDragged(word: Word): boolean {
  return dragMode.value === 'word' && dragWordId.value === word.id;
}

function handleResize() {
  if (resizeRafId !== null) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    updateWidth();
  });
}

onMounted(() => {
  updateWidth();

  resizeObserver = new ResizeObserver(handleResize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (activeWordRafId !== null) {
    cancelAnimationFrame(activeWordRafId);
  }
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
  }
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
  }
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
      <!-- Normal word rendering (zoomed in enough to read) -->
      <template v-if="!wordsTooSmallToRead">
        <div
          v-for="word in visibleWords"
          :key="`${word.trackId}-${word.id}`"
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
            :track-color="getTrackColor(word.trackId)"
            @click="handleWordClick"
            @update-text="(wordId: string, text: string) => handleWordTextUpdate(word.trackId, wordId, text)"
          />
        </div>
      </template>

      <!-- Magnified active word mode (zoomed out too far to read individual words) -->
      <div v-if="wordsTooSmallToRead && activeWord" class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span class="text-sm font-mono bg-gray-900/80 px-3 py-1 rounded" :style="{ color: getTrackColor(activeWord.trackId) }">
          {{ activeWord.text }}
        </span>
      </div>
      <div v-else-if="wordsTooSmallToRead && hasAnyTranscription" class="absolute inset-0 flex items-center justify-center">
        <span class="text-[10px] text-gray-600 italic">Zoom in to see words</span>
      </div>

      <div
        v-if="!wordsTooSmallToRead && !visibleWords.length && hasAnyTranscription"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-500"
      >
        No words in this region
      </div>

      <!-- Context-aware messages when no transcription -->
      <div
        v-if="!hasAnyTranscription && !transcriptionStore.hasModel && hasAudio"
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
        v-else-if="!hasAnyTranscription && transcriptionStore.loading"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
      >
        <svg class="animate-spin h-3 w-3 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        Transcribing...
      </div>

      <div
        v-else-if="!hasAnyTranscription && transcriptionStore.error"
        class="absolute inset-0 flex items-center justify-center text-xs text-red-400 px-2"
      >
        {{ transcriptionStore.error }}
      </div>

      <div
        v-else-if="!hasAnyTranscription && !hasAudio"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-600"
      >
        Load audio to see transcription
      </div>

      <div
        v-else-if="!hasAnyTranscription"
        class="absolute inset-0 flex items-center justify-center text-xs text-gray-600"
      >
        No transcription available
      </div>
    </div>

    <!-- Control bar: falloff toggle + global drag handle -->
    <div
      v-if="hasAnyTranscription"
      class="h-5 bg-gray-800 border-t border-gray-700 flex items-center"
    >
      <!-- Falloff toggle -->
      <label
        class="flex items-center gap-1 px-2 text-[9px] text-gray-500 cursor-pointer hover:text-gray-400 select-none shrink-0"
        @click.stop
        title="When enabled, dragging a word pulls neighbors with diminishing force"
      >
        <input
          type="checkbox"
          :checked="enableFalloff"
          class="w-2.5 h-2.5 rounded border-gray-600 bg-gray-700 text-cyan-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
          @change="selectedTrackId && transcriptionStore.setEnableFalloff(selectedTrackId, ($event.target as HTMLInputElement).checked)"
          @click.stop
        />
        Pull
      </label>

      <!-- Global drag handle — shifts all words in selected track -->
      <div
        class="flex-1 h-full flex items-center justify-center cursor-ew-resize select-none group"
        :class="{ 'opacity-40': !selectedTrackId || !transcriptionStore.hasTranscriptionForTrack(selectedTrackId!) }"
        title="Drag left/right to shift all words for the selected track"
        @mousedown="handleGlobalDragStart"
      >
        <div class="flex items-center gap-0.5 text-gray-600 group-hover:text-gray-400 transition-colors">
          <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M15 19l-7-7 7-7" /></svg>
          <div class="w-4 h-1 rounded-full bg-gray-600 group-hover:bg-gray-400 transition-colors" />
          <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7" /></svg>
        </div>
      </div>

      <!-- Track name hint -->
      <span v-if="selectedTrackId" class="text-[9px] text-gray-600 px-2 shrink-0 truncate max-w-[120px]">
        {{ tracksStore.tracks.find(t => t.id === selectedTrackId)?.name }}
      </span>
    </div>
  </div>
</template>
