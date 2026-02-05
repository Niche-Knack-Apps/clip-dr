import { ref, computed } from 'vue';
import { useTranscriptionStore } from '@/stores/transcription';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import type { SearchResult } from '@/shared/types';
import { debounce } from '@/shared/utils';
import { SEARCH_STOPWORDS, SEARCH_MIN_WORDS } from '@/shared/constants';

export function useSearch() {
  const transcriptionStore = useTranscriptionStore();
  const tracksStore = useTracksStore();
  const selectionStore = useSelectionStore();
  const playbackStore = usePlaybackStore();

  const query = ref('');
  const results = ref<SearchResult[]>([]);
  const currentResultIndex = ref(0);
  const isSearching = ref(false);

  const hasResults = computed(() => results.value.length > 0);
  const currentResult = computed(() =>
    hasResults.value ? results.value[currentResultIndex.value] : null
  );
  const resultCount = computed(() => results.value.length);

  // Padding around the matched phrase (in seconds)
  const SELECTION_PADDING = 0.5;

  function getSelectedTrackId(): string | null {
    const sel = tracksStore.selectedTrackId;
    if (!sel || sel === 'ALL') return null;
    return sel;
  }

  const performSearch = debounce(() => {
    const trackId = getSelectedTrackId();
    if (!trackId) {
      results.value = [];
      isSearching.value = false;
      return;
    }

    const queryWords = query.value.trim().split(/\s+/).filter(Boolean);
    const wordCount = queryWords.length;
    const meaningfulWords = queryWords.filter(w => !SEARCH_STOPWORDS.has(w.toLowerCase()));

    if (meaningfulWords.length >= SEARCH_MIN_WORDS) {
      results.value = transcriptionStore.searchWords(trackId, query.value);
      currentResultIndex.value = 0;

      if (results.value.length > 0) {
        navigateToResult(0, wordCount);
      }
    } else {
      results.value = [];
    }

    isSearching.value = false;
  }, 300);

  function search(searchQuery: string): void {
    query.value = searchQuery;
    isSearching.value = true;
    performSearch();
  }

  function clear(): void {
    query.value = '';
    results.value = [];
    currentResultIndex.value = 0;
    isSearching.value = false;
  }

  function navigateToResult(index: number, matchedWordCount?: number): void {
    if (index < 0 || index >= results.value.length) return;

    const trackId = getSelectedTrackId();
    if (!trackId) return;

    currentResultIndex.value = index;
    const result = results.value[index];
    const allWords = transcriptionStore.getAdjustedWords(trackId);

    const wordCount = matchedWordCount ?? result.matchEnd;

    const startWord = result.word;
    const startTime = startWord.start;

    const lastWordIndex = result.wordIndex + wordCount - 1;
    const endWord = lastWordIndex < allWords.length ? allWords[lastWordIndex] : startWord;
    const endTime = endWord.end;

    const paddedStart = Math.max(0, startTime - SELECTION_PADDING);
    const paddedEnd = endTime + SELECTION_PADDING;
    selectionStore.setSelection(paddedStart, paddedEnd);

    playbackStore.seek(startTime);
  }

  function nextResult(): void {
    if (!hasResults.value) return;

    const nextIndex = (currentResultIndex.value + 1) % results.value.length;
    navigateToResult(nextIndex);
  }

  function previousResult(): void {
    if (!hasResults.value) return;

    const prevIndex =
      currentResultIndex.value === 0
        ? results.value.length - 1
        : currentResultIndex.value - 1;
    navigateToResult(prevIndex);
  }

  function getHighlightedWordIndices(): Set<number> {
    const indices = new Set<number>();
    const trackId = getSelectedTrackId();
    if (!trackId) return indices;

    const allWords = transcriptionStore.getAdjustedWords(trackId);

    for (const result of results.value) {
      for (let i = 0; i < result.matchEnd; i++) {
        const wordIdx = result.wordIndex + i;
        if (wordIdx < allWords.length) {
          indices.add(wordIdx);
        }
      }
    }
    return indices;
  }

  return {
    query,
    results,
    currentResultIndex,
    isSearching,
    hasResults,
    currentResult,
    resultCount,
    search,
    clear,
    navigateToResult,
    nextResult,
    previousResult,
    getHighlightedWordIndices,
  };
}
