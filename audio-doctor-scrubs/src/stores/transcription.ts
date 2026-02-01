import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { Transcription, Word, TranscriptionProgress, SearchResult, ModelInfo, TranscriptionMetadata } from '@/shared/types';
import { useAudioStore } from './audio';
import { useSettingsStore } from './settings';
import { generateId, binarySearch } from '@/shared/utils';
import { SEARCH_MIN_WORDS, SEARCH_STOPWORDS } from '@/shared/constants';

export const useTranscriptionStore = defineStore('transcription', () => {
  const audioStore = useAudioStore();
  const settingsStore = useSettingsStore();

  const transcription = ref<Transcription | null>(null);
  const loading = ref(false);
  const progress = ref<TranscriptionProgress>({
    stage: 'loading',
    progress: 0,
    message: '',
  });
  const error = ref<string | null>(null);
  const modelPath = ref<string | null>(null);
  const modelsDirectory = ref<string | null>(null);
  const availableModels = ref<ModelInfo[]>([]);

  // Timing adjustments
  const globalOffsetMs = ref(0);
  const wordOffsetsMs = ref<Map<string, number>>(new Map());
  const hasUnsavedChanges = ref(false);
  const enableFalloff = ref(true); // Gradual pull effect for neighbors

  function getCustomPath(): string | null {
    const path = settingsStore.settings.modelsPath;
    return path && path.trim() !== '' ? path : null;
  }

  // Check if whisper model is available on store initialization
  async function checkModel(): Promise<boolean> {
    try {
      const customPath = getCustomPath();
      console.log('[Transcription] Checking for model, customPath:', customPath);
      modelPath.value = await invoke<string>('check_whisper_model', { customPath });
      console.log('[Transcription] Found model at:', modelPath.value);
      return true;
    } catch (e) {
      console.log('[Transcription] Model not found:', e);
      modelPath.value = null;
      try {
        modelsDirectory.value = await invoke<string>('get_models_directory');
        console.log('[Transcription] Default models directory:', modelsDirectory.value);
      } catch {
        modelsDirectory.value = null;
      }
      return false;
    }
  }

  async function loadAvailableModels(): Promise<void> {
    try {
      const customPath = getCustomPath();
      availableModels.value = await invoke<ModelInfo[]>('list_available_models', { customPath });
    } catch (e) {
      console.error('Failed to load available models:', e);
      availableModels.value = [];
    }
  }

  const hasModel = computed(() => modelPath.value !== null);

  const words = computed(() => transcription.value?.words ?? []);
  const fullText = computed(() => transcription.value?.fullText ?? '');
  const hasTranscription = computed(() => transcription.value !== null);

  // Get words with timing adjustments applied
  const adjustedWords = computed((): Word[] => {
    if (!transcription.value) return [];

    const globalOffsetSec = globalOffsetMs.value / 1000;

    return transcription.value.words.map((word) => {
      const individualOffsetMs = wordOffsetsMs.value.get(word.id) ?? 0;
      const totalOffsetSec = globalOffsetSec + (individualOffsetMs / 1000);

      return {
        ...word,
        start: Math.max(0, word.start + totalOffsetSec),
        end: Math.max(0, word.end + totalOffsetSec),
      };
    });
  });

  // Adjust global offset (shifts all words)
  function setGlobalOffset(offsetMs: number): void {
    globalOffsetMs.value = offsetMs;
    hasUnsavedChanges.value = true;
  }

  // Adjust individual word offset with automatic neighbor pushing and falloff
  function setWordOffset(wordId: string, offsetMs: number, pushNeighbors: boolean = true): void {
    if (!transcription.value) return;

    const allWords = transcription.value.words;
    const wordIndex = allWords.findIndex((w) => w.id === wordId);
    if (wordIndex === -1) return;

    const word = allWords[wordIndex];
    const globalOffsetSec = globalOffsetMs.value / 1000;
    const newOffsetSec = offsetMs / 1000;

    // Get the previous offset for this word to calculate delta
    const prevOffset = wordOffsetsMs.value.get(wordId) ?? 0;
    const deltaMs = offsetMs - prevOffset;

    // Calculate the new adjusted times for this word
    const newStart = word.start + globalOffsetSec + newOffsetSec;
    const newEnd = word.end + globalOffsetSec + newOffsetSec;

    // Set the offset for this word
    if (offsetMs === 0) {
      wordOffsetsMs.value.delete(wordId);
    } else {
      wordOffsetsMs.value.set(wordId, offsetMs);
    }

    // Push neighbors if enabled
    if (pushNeighbors) {
      const minGap = 0.01; // 10ms minimum gap between words
      const falloffFactor = enableFalloff.value ? 0.6 : 1.0; // 60% of movement for each neighbor
      const falloffRadius = enableFalloff.value ? 5 : 100; // How many neighbors to affect

      // Check and push previous words (if dragging left/earlier)
      if (wordIndex > 0) {
        let prevIndex = wordIndex - 1;
        let requiredEndTime = newStart - minGap;
        let distance = 1;

        while (prevIndex >= 0 && distance <= falloffRadius) {
          const prevWord = allWords[prevIndex];
          const prevCurrentOffset = wordOffsetsMs.value.get(prevWord.id) ?? 0;
          const prevAdjustedEnd = prevWord.end + globalOffsetSec + (prevCurrentOffset / 1000);

          // Apply falloff: pull neighbors with diminishing force
          if (enableFalloff.value && deltaMs < 0) {
            // Dragging left - apply falloff pull to previous words
            const pullFactor = Math.pow(falloffFactor, distance);
            const pullAmount = deltaMs * pullFactor;
            if (Math.abs(pullAmount) > 1) { // Only pull if > 1ms
              const newPrevOffset = prevCurrentOffset + pullAmount;
              wordOffsetsMs.value.set(prevWord.id, newPrevOffset);
            }
          }

          // Always prevent overlap (hard push)
          const prevUpdatedOffset = wordOffsetsMs.value.get(prevWord.id) ?? 0;
          const prevUpdatedEnd = prevWord.end + globalOffsetSec + (prevUpdatedOffset / 1000);

          if (prevUpdatedEnd > requiredEndTime) {
            // Need to push this word earlier to prevent overlap
            const pushAmount = prevUpdatedEnd - requiredEndTime;
            const newPrevOffset = prevUpdatedOffset - (pushAmount * 1000);
            wordOffsetsMs.value.set(prevWord.id, newPrevOffset);
            // Update required end time for next previous word
            const prevWordDuration = prevWord.end - prevWord.start;
            requiredEndTime = requiredEndTime - prevWordDuration - minGap;
          }

          prevIndex--;
          distance++;
        }
      }

      // Check and push next words (if dragging right/later)
      if (wordIndex < allWords.length - 1) {
        let nextIndex = wordIndex + 1;
        let requiredStartTime = newEnd + minGap;
        let distance = 1;

        while (nextIndex < allWords.length && distance <= falloffRadius) {
          const nextWord = allWords[nextIndex];
          const nextCurrentOffset = wordOffsetsMs.value.get(nextWord.id) ?? 0;
          const nextAdjustedStart = nextWord.start + globalOffsetSec + (nextCurrentOffset / 1000);

          // Apply falloff: pull neighbors with diminishing force
          if (enableFalloff.value && deltaMs > 0) {
            // Dragging right - apply falloff pull to next words
            const pullFactor = Math.pow(falloffFactor, distance);
            const pullAmount = deltaMs * pullFactor;
            if (Math.abs(pullAmount) > 1) { // Only pull if > 1ms
              const newNextOffset = nextCurrentOffset + pullAmount;
              wordOffsetsMs.value.set(nextWord.id, newNextOffset);
            }
          }

          // Always prevent overlap (hard push)
          const nextUpdatedOffset = wordOffsetsMs.value.get(nextWord.id) ?? 0;
          const nextUpdatedStart = nextWord.start + globalOffsetSec + (nextUpdatedOffset / 1000);

          if (nextUpdatedStart < requiredStartTime) {
            // Need to push this word later to prevent overlap
            const pushAmount = requiredStartTime - nextUpdatedStart;
            const newNextOffset = nextUpdatedOffset + (pushAmount * 1000);
            wordOffsetsMs.value.set(nextWord.id, newNextOffset);
            // Update required start time for next word
            const nextWordDuration = nextWord.end - nextWord.start;
            requiredStartTime = requiredStartTime + nextWordDuration + minGap;
          }

          nextIndex++;
          distance++;
        }
      }
    }

    hasUnsavedChanges.value = true;
  }

  function setEnableFalloff(enabled: boolean): void {
    enableFalloff.value = enabled;
  }

  // Update word text (for inline editing)
  function updateWordText(wordId: string, newText: string): void {
    if (!transcription.value) return;

    const word = transcription.value.words.find((w) => w.id === wordId);
    if (word) {
      word.text = newText;
      // Update full text
      transcription.value.fullText = transcription.value.words.map((w) => w.text).join(' ');
      hasUnsavedChanges.value = true;
      // Auto-save
      saveTranscription();
    }
  }

  // Get the current offset for a word
  function getWordOffset(wordId: string): number {
    return wordOffsetsMs.value.get(wordId) ?? 0;
  }

  // Clear all timing adjustments
  function clearTimingAdjustments(): void {
    globalOffsetMs.value = 0;
    wordOffsetsMs.value.clear();
    hasUnsavedChanges.value = false;
  }

  // Save transcription and timing metadata to file
  async function saveTranscription(): Promise<void> {
    if (!audioStore.currentFile || !transcription.value) return;

    const metadata: TranscriptionMetadata = {
      audioPath: audioStore.currentFile.path,
      globalOffsetMs: globalOffsetMs.value,
      wordAdjustments: Array.from(wordOffsetsMs.value.entries()).map(([wordId, offsetMs]) => ({
        wordId,
        offsetMs,
      })),
      savedAt: Date.now(),
      // Include full transcription data
      words: transcription.value.words,
      fullText: transcription.value.fullText,
      language: transcription.value.language,
    };

    try {
      await invoke('save_transcription_metadata', {
        audioPath: audioStore.currentFile.path,
        metadata,
      });
      hasUnsavedChanges.value = false;
      console.log('[Transcription] Full transcription saved');
    } catch (e) {
      console.error('[Transcription] Failed to save transcription:', e);
    }
  }

  // Alias for backwards compatibility
  async function saveTimingMetadata(): Promise<void> {
    return saveTranscription();
  }

  // Load transcription from file (returns true if found)
  async function loadExistingTranscription(): Promise<boolean> {
    if (!audioStore.currentFile) return false;

    try {
      const metadata = await invoke<TranscriptionMetadata | null>('load_transcription_metadata', {
        audioPath: audioStore.currentFile.path,
      });

      if (metadata && metadata.words && metadata.words.length > 0) {
        // Load full transcription from saved metadata
        transcription.value = {
          audioId: audioStore.currentFile.id,
          words: metadata.words,
          fullText: metadata.fullText || metadata.words.map(w => w.text).join(' '),
          language: metadata.language || 'en',
          processedAt: metadata.savedAt,
        };

        // Load timing adjustments
        globalOffsetMs.value = metadata.globalOffsetMs || 0;
        wordOffsetsMs.value.clear();
        for (const adj of metadata.wordAdjustments || []) {
          wordOffsetsMs.value.set(adj.wordId, adj.offsetMs);
        }

        console.log('[Transcription] Loaded existing transcription from file');
        return true;
      }

      // If metadata exists but no words, just load timing adjustments
      if (metadata) {
        globalOffsetMs.value = metadata.globalOffsetMs || 0;
        wordOffsetsMs.value.clear();
        for (const adj of metadata.wordAdjustments || []) {
          wordOffsetsMs.value.set(adj.wordId, adj.offsetMs);
        }
      }

      return false;
    } catch (e) {
      console.log('[Transcription] No existing transcription found:', e);
      return false;
    }
  }

  // Alias for backwards compatibility
  async function loadTimingMetadata(): Promise<void> {
    await loadExistingTranscription();
  }

  function getWordsInRange(start: number, end: number): Word[] {
    if (!transcription.value) return [];

    // Use adjusted words for range queries
    return adjustedWords.value.filter(
      (word) => word.end > start && word.start < end
    );
  }

  function getWordAtTime(time: number): Word | null {
    if (!transcription.value) return null;

    // Use adjusted words
    const adjWords = adjustedWords.value;
    const idx = binarySearch(adjWords, time, (w) => w.start);

    for (let i = Math.max(0, idx - 1); i < Math.min(adjWords.length, idx + 2); i++) {
      const word = adjWords[i];
      if (time >= word.start && time <= word.end) {
        return word;
      }
    }

    return null;
  }

  function searchWords(query: string): SearchResult[] {
    if (!transcription.value) return [];

    const queryWords = query.toLowerCase().trim().split(/\s+/);
    // Filter out stopwords when checking if we have enough meaningful words
    const meaningfulWords = queryWords.filter(w => !SEARCH_STOPWORDS.has(w));
    if (meaningfulWords.length < SEARCH_MIN_WORDS) return [];

    const results: SearchResult[] = [];
    // Use adjusted words for search
    const allWords = adjustedWords.value;
    const searchQuery = queryWords.join(' ');

    for (let i = 0; i <= allWords.length - queryWords.length; i++) {
      const windowWords = allWords.slice(i, i + queryWords.length);
      const windowText = windowWords.map((w) => w.text.toLowerCase()).join(' ');

      if (windowText.includes(searchQuery) || searchQuery.includes(windowText)) {
        results.push({
          wordIndex: i,
          word: allWords[i],
          matchStart: 0,
          matchEnd: queryWords.length,
        });
      }
    }

    return results;
  }

  // Try to load existing transcription, or run model if none exists
  async function transcribeAudio(): Promise<void> {
    if (!audioStore.currentFile) {
      error.value = 'No audio file loaded';
      return;
    }

    loading.value = true;
    error.value = null;
    progress.value = { stage: 'loading', progress: 0, message: 'Checking for existing transcription...' };

    try {
      // First, try to load existing transcription from JSON
      const hasExisting = await loadExistingTranscription();
      if (hasExisting) {
        progress.value = { stage: 'complete', progress: 100, message: 'Loaded from file' };
        loading.value = false;
        return;
      }

      // No existing transcription, need to run model
      progress.value = { stage: 'loading', progress: 5, message: 'Checking model...' };

      // Check if model is available
      const modelAvailable = await checkModel();
      if (!modelAvailable) {
        // Show custom path if configured, otherwise show default
        const customPath = getCustomPath();
        const dir = customPath || modelsDirectory.value || '~/.local/share/clip-doctor-scrubs/models';
        error.value = `Whisper model not found. Please download ggml-tiny.bin from https://huggingface.co/ggerganov/whisper.cpp/tree/main and place it in: ${dir}`;
        loading.value = false;
        return;
      }

      await runTranscription();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // Check if it's a model-not-found error
      if (errMsg.includes('not found') || errMsg.includes('model')) {
        const customPath = getCustomPath();
        const dir = customPath || modelsDirectory.value || '~/.local/share/clip-doctor-scrubs/models';
        error.value = `Whisper model not found. Download ggml-tiny.bin from huggingface.co/ggerganov/whisper.cpp and place in: ${dir}`;
      } else {
        error.value = errMsg;
      }
      throw e;
    } finally {
      loading.value = false;
    }
  }

  // Force re-transcription (ignores existing JSON, clears words and runs model fresh)
  async function reTranscribe(): Promise<void> {
    if (!audioStore.currentFile) {
      error.value = 'No audio file loaded';
      return;
    }

    loading.value = true;
    error.value = null;
    progress.value = { stage: 'loading', progress: 0, message: 'Checking model...' };

    // Clear existing transcription and timing adjustments
    transcription.value = null;
    clearTimingAdjustments();

    try {
      // Check if model is available
      const modelAvailable = await checkModel();
      if (!modelAvailable) {
        const customPath = getCustomPath();
        const dir = customPath || modelsDirectory.value || '~/.local/share/clip-doctor-scrubs/models';
        error.value = `Whisper model not found. Please download ggml-tiny.bin from https://huggingface.co/ggerganov/whisper.cpp/tree/main and place it in: ${dir}`;
        loading.value = false;
        return;
      }

      await runTranscription();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('not found') || errMsg.includes('model')) {
        const customPath = getCustomPath();
        const dir = customPath || modelsDirectory.value || '~/.local/share/clip-doctor-scrubs/models';
        error.value = `Whisper model not found. Download ggml-tiny.bin from huggingface.co/ggerganov/whisper.cpp and place in: ${dir}`;
      } else {
        error.value = errMsg;
      }
      throw e;
    } finally {
      loading.value = false;
    }
  }

  // Internal function to actually run the transcription
  async function runTranscription(): Promise<void> {
    if (!audioStore.currentFile) return;

    progress.value = { stage: 'loading', progress: 10, message: 'Preparing audio...' };
    progress.value = { stage: 'transcribing', progress: 15, message: 'Transcribing audio...' };

    const customPath = getCustomPath();
    const result = await invoke<{ words: Word[]; text: string; language: string }>(
      'transcribe_audio',
      {
        path: audioStore.currentFile.path,
        modelsPath: customPath,
      }
    );

    progress.value = { stage: 'aligning', progress: 90, message: 'Aligning words...' };

    transcription.value = {
      audioId: audioStore.currentFile.id,
      words: result.words.map((w) => ({ ...w, id: w.id || generateId() })),
      fullText: result.text,
      language: result.language,
      processedAt: Date.now(),
    };

    progress.value = { stage: 'complete', progress: 100, message: 'Complete!' };

    // Save the transcription to JSON for future loads
    await saveTranscription();
  }

  function clearTranscription(): void {
    transcription.value = null;
    error.value = null;
    progress.value = { stage: 'loading', progress: 0, message: '' };
  }

  function setMockTranscription(mockWords: Word[]): void {
    if (!audioStore.currentFile) return;

    transcription.value = {
      audioId: audioStore.currentFile.id,
      words: mockWords,
      fullText: mockWords.map((w) => w.text).join(' '),
      language: 'en',
      processedAt: Date.now(),
    };
  }

  return {
    transcription,
    loading,
    progress,
    error,
    modelPath,
    modelsDirectory,
    availableModels,
    hasModel,
    words,
    adjustedWords,
    fullText,
    hasTranscription,
    globalOffsetMs,
    hasUnsavedChanges,
    enableFalloff,
    checkModel,
    loadAvailableModels,
    getWordsInRange,
    getWordAtTime,
    searchWords,
    transcribeAudio,
    reTranscribe,
    clearTranscription,
    setMockTranscription,
    setGlobalOffset,
    setWordOffset,
    getWordOffset,
    clearTimingAdjustments,
    saveTimingMetadata,
    saveTranscription,
    loadTimingMetadata,
    loadExistingTranscription,
    setEnableFalloff,
    updateWordText,
  };
});
