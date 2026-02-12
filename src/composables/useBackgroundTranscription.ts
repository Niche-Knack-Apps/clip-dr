import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { remove } from '@tauri-apps/plugin-fs';
import type { Word } from '@/shared/types';
import { generateId } from '@/shared/utils';
import { useSettingsStore } from '@/stores/settings';

interface RecordingChunk {
  path: string;
  sample_rate: number;
  channels: number;
  offset_seconds: number;
  duration_seconds: number;
}

const CHUNK_INTERVAL_MS = 8000;

export interface BackgroundTranscriptionOptions {
  onChunkTranscribed?: (newWords: Word[]) => void;
}

export function useBackgroundTranscription(options: BackgroundTranscriptionOptions = {}) {
  const backgroundWords = ref<Word[]>([]);
  const isTranscribing = ref(false);
  const backgroundTranscriptionActive = ref(false);

  let chunkTimer: number | null = null;
  let transcriptionInProgress = false;

  async function processChunk(): Promise<void> {
    if (transcriptionInProgress || !backgroundTranscriptionActive.value) return;

    transcriptionInProgress = true;
    isTranscribing.value = true;

    let chunkPath: string | null = null;
    try {
      // Fetch audio chunk (Rust writes temp WAV and returns path + metadata)
      const chunk = await invoke<RecordingChunk>('get_recording_chunk');
      chunkPath = chunk.path;

      // Transcribe the chunk
      const settingsStore = useSettingsStore();
      const modelsPath = settingsStore.settings.modelsPath || null;

      const result = await invoke<{ words: Word[]; text: string; language: string }>(
        'transcribe_audio',
        { path: chunk.path, modelsPath },
      );

      // Clean up temp chunk file after transcription
      remove(chunk.path).catch(() => {});

      // Recording may have stopped while transcription was in progress
      if (!backgroundTranscriptionActive.value) return;

      // Offset word timestamps by the chunk's position in the recording
      const offsetWords = result.words.map(w => ({
        ...w,
        id: w.id || generateId(),
        start: w.start + chunk.offset_seconds,
        end: w.end + chunk.offset_seconds,
      }));

      backgroundWords.value = [...backgroundWords.value, ...offsetWords];

      // Notify caller of new words (used for auto-timemark trigger phrase detection)
      if (options.onChunkTranscribed && offsetWords.length > 0) {
        options.onChunkTranscribed(offsetWords);
      }

      console.log(
        `[BackgroundTranscription] Chunk at ${chunk.offset_seconds.toFixed(1)}s: ` +
        `${offsetWords.length} words (total: ${backgroundWords.value.length})`,
      );
    } catch (e) {
      // Clean up temp file even on error
      if (chunkPath) remove(chunkPath).catch(() => {});
      const msg = String(e);
      // Silently skip expected non-error cases
      if (!msg.includes('No new audio data') && !msg.includes('No recording in progress')) {
        console.warn('[BackgroundTranscription] Chunk error:', msg);
      }
    } finally {
      transcriptionInProgress = false;
      isTranscribing.value = false;
    }
  }

  function startBackgroundTranscription(): void {
    if (backgroundTranscriptionActive.value) return;

    backgroundWords.value = [];
    backgroundTranscriptionActive.value = true;
    transcriptionInProgress = false;

    chunkTimer = window.setInterval(processChunk, CHUNK_INTERVAL_MS);
    console.log('[BackgroundTranscription] Started');
  }

  function stopBackgroundTranscription(): Word[] {
    if (chunkTimer !== null) {
      clearInterval(chunkTimer);
      chunkTimer = null;
    }

    backgroundTranscriptionActive.value = false;
    transcriptionInProgress = false;
    isTranscribing.value = false;

    const words = [...backgroundWords.value];
    console.log(`[BackgroundTranscription] Stopped with ${words.length} words`);
    return words;
  }

  return {
    backgroundWords,
    isTranscribing,
    backgroundTranscriptionActive,
    startBackgroundTranscription,
    stopBackgroundTranscription,
  };
}
