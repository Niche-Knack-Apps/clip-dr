import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import type { TrackTranscription, TranscriptionJob, Word, TranscriptionProgress, SearchResult, ModelInfo, TranscriptionMetadata } from '@/shared/types';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSettingsStore } from './settings';
import { generateId, binarySearch } from '@/shared/utils';
import { SEARCH_MIN_WORDS, SEARCH_STOPWORDS } from '@/shared/constants';
import { useHistoryStore } from './history';

// Helper to encode AudioBuffer to WAV format
function encodeWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeWavString(view, 8, 'WAVE');

  // fmt chunk
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeWavString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and write samples
  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Uint8Array(arrayBuffer);
}

function writeWavString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export const useTranscriptionStore = defineStore('transcription', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const settingsStore = useSettingsStore();

  // ─── Per-track transcriptions (Map<trackId, TrackTranscription>) ───
  const transcriptions = ref<Map<string, TrackTranscription>>(new Map());

  // ─── Background job queue ───
  const jobQueue = ref<TranscriptionJob[]>([]);
  let processorRunning = false;

  // ─── Global state ───
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

  function getCustomPath(): string | null {
    const path = settingsStore.settings.modelsPath;
    return path && path.trim() !== '' ? path : null;
  }

  // ─── Model checking ───
  async function checkModel(): Promise<boolean> {
    try {
      const customPath = getCustomPath();
      modelPath.value = await invoke<string>('check_whisper_model', { customPath });
      return true;
    } catch (e) {
      modelPath.value = null;
      try {
        modelsDirectory.value = await invoke<string>('get_models_directory');
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

  // ─── Debug: log Map state ───
  function logMapState(context: string): void {
    const keys = Array.from(transcriptions.value.keys());
    const sizes = keys.map(k => {
      const t = transcriptions.value.get(k);
      return `${k.slice(0, 8)}(${t?.words.length ?? 0}w)`;
    });
    console.log(`[Transcription][MAP] ${context} — ${keys.length} entries: [${sizes.join(', ')}]`);
  }

  // ─── Per-track getters ───
  function hasTranscriptionForTrack(trackId: string): boolean {
    return transcriptions.value.has(trackId);
  }

  function getTranscription(trackId: string): TrackTranscription | undefined {
    return transcriptions.value.get(trackId);
  }

  // Backwards-compat computed: true if the selected track has a transcription
  const hasTranscription = computed(() => {
    const sel = tracksStore.selectedTrackId;
    if (!sel || sel === 'ALL') return false;
    return transcriptions.value.has(sel);
  });

  // ─── Adjusted words (applies trackStart + wordOffsets) ───
  function getAdjustedWords(trackId: string): Word[] {
    const t = transcriptions.value.get(trackId);
    if (!t) return [];

    const track = tracksStore.tracks.find(tr => tr.id === trackId);
    const trackOffset = track?.trackStart ?? 0;

    return t.words.map((word) => {
      const individualOffsetMs = t.wordOffsets.get(word.id) ?? 0;
      const totalOffsetSec = individualOffsetMs / 1000;

      return {
        ...word,
        start: Math.max(0, word.start + trackOffset + totalOffsetSec),
        end: Math.max(0, word.end + trackOffset + totalOffsetSec),
      };
    });
  }

  // Backwards-compat computed for selected track
  const adjustedWords = computed((): Word[] => {
    const sel = tracksStore.selectedTrackId;
    if (!sel || sel === 'ALL') return [];
    return getAdjustedWords(sel);
  });

  // ─── Word offset (drag) with neighbor pushing/falloff ───
  function setWordOffset(trackId: string, wordId: string, offsetMs: number, pushNeighbors: boolean = true): void {
    const t = transcriptions.value.get(trackId);
    if (!t) return;

    const allWords = t.words;
    const wordIndex = allWords.findIndex((w) => w.id === wordId);
    if (wordIndex === -1) return;

    const word = allWords[wordIndex];
    const newOffsetSec = offsetMs / 1000;

    // Get the previous offset for this word to calculate delta
    const prevOffset = t.wordOffsets.get(wordId) ?? 0;
    const deltaMs = offsetMs - prevOffset;

    // Calculate the new adjusted times for this word
    const newStart = word.start + newOffsetSec;
    const newEnd = word.end + newOffsetSec;

    // Set the offset for this word
    if (offsetMs === 0) {
      t.wordOffsets.delete(wordId);
    } else {
      t.wordOffsets.set(wordId, offsetMs);
    }

    // Push neighbors if enabled
    if (pushNeighbors) {
      const minGap = 0.01;
      const falloffFactor = t.enableFalloff ? 0.6 : 1.0;
      const falloffRadius = t.enableFalloff ? 5 : 100;

      // Check and push previous words
      if (wordIndex > 0) {
        let prevIndex = wordIndex - 1;
        let requiredEndTime = newStart - minGap;
        let distance = 1;

        while (prevIndex >= 0 && distance <= falloffRadius) {
          const prevWord = allWords[prevIndex];
          const prevCurrentOffset = t.wordOffsets.get(prevWord.id) ?? 0;

          if (t.enableFalloff && deltaMs < 0) {
            const pullFactor = Math.pow(falloffFactor, distance);
            const pullAmount = deltaMs * pullFactor;
            if (Math.abs(pullAmount) > 1) {
              const newPrevOffset = prevCurrentOffset + pullAmount;
              t.wordOffsets.set(prevWord.id, newPrevOffset);
            }
          }

          const prevUpdatedOffset = t.wordOffsets.get(prevWord.id) ?? 0;
          const prevUpdatedEnd = prevWord.end + (prevUpdatedOffset / 1000);

          if (prevUpdatedEnd > requiredEndTime) {
            const pushAmount = prevUpdatedEnd - requiredEndTime;
            const newPrevOffset = prevUpdatedOffset - (pushAmount * 1000);
            t.wordOffsets.set(prevWord.id, newPrevOffset);
            const prevWordDuration = prevWord.end - prevWord.start;
            requiredEndTime = requiredEndTime - prevWordDuration - minGap;
          }

          prevIndex--;
          distance++;
        }
      }

      // Check and push next words
      if (wordIndex < allWords.length - 1) {
        let nextIndex = wordIndex + 1;
        let requiredStartTime = newEnd + minGap;
        let distance = 1;

        while (nextIndex < allWords.length && distance <= falloffRadius) {
          const nextWord = allWords[nextIndex];
          const nextCurrentOffset = t.wordOffsets.get(nextWord.id) ?? 0;

          if (t.enableFalloff && deltaMs > 0) {
            const pullFactor = Math.pow(falloffFactor, distance);
            const pullAmount = deltaMs * pullFactor;
            if (Math.abs(pullAmount) > 1) {
              const newNextOffset = nextCurrentOffset + pullAmount;
              t.wordOffsets.set(nextWord.id, newNextOffset);
            }
          }

          const nextUpdatedOffset = t.wordOffsets.get(nextWord.id) ?? 0;
          const nextUpdatedStart = nextWord.start + (nextUpdatedOffset / 1000);

          if (nextUpdatedStart < requiredStartTime) {
            const pushAmount = requiredStartTime - nextUpdatedStart;
            const newNextOffset = nextUpdatedOffset + (pushAmount * 1000);
            t.wordOffsets.set(nextWord.id, newNextOffset);
            const nextWordDuration = nextWord.end - nextWord.start;
            requiredStartTime = requiredStartTime + nextWordDuration + minGap;
          }

          nextIndex++;
          distance++;
        }
      }
    }
  }

  function setEnableFalloff(trackId: string, enabled: boolean): void {
    const t = transcriptions.value.get(trackId);
    if (t) t.enableFalloff = enabled;
  }

  // ─── Word text editing ───
  function updateWordText(trackId: string, wordId: string, newText: string): void {
    const t = transcriptions.value.get(trackId);
    if (!t) return;

    const word = t.words.find((w) => w.id === wordId);
    if (word) {
      useHistoryStore().pushState('Edit word');
      word.text = newText;
      t.fullText = t.words.map((w) => w.text).join(' ');
      saveTranscription(trackId);
    }
  }

  // ─── Word offset getter ───
  function getWordOffset(trackId: string, wordId: string): number {
    return transcriptions.value.get(trackId)?.wordOffsets.get(wordId) ?? 0;
  }

  // ─── Range/time queries ───
  function getWordsInRange(trackId: string, start: number, end: number): Word[] {
    const adjWords = getAdjustedWords(trackId);
    return adjWords.filter((word) => word.end > start && word.start < end);
  }

  function getWordAtTime(trackId: string, time: number): Word | null {
    const adjWords = getAdjustedWords(trackId);
    if (adjWords.length === 0) return null;

    const idx = binarySearch(adjWords, time, (w) => w.start);

    for (let i = Math.max(0, idx - 1); i < Math.min(adjWords.length, idx + 2); i++) {
      const word = adjWords[i];
      if (time >= word.start && time <= word.end) {
        return word;
      }
    }

    return null;
  }

  // ─── Search ───
  function searchWords(trackId: string, query: string): SearchResult[] {
    const adjWords = getAdjustedWords(trackId);
    if (adjWords.length === 0) return [];

    const queryWords = query.toLowerCase().trim().split(/\s+/);
    const meaningfulWords = queryWords.filter(w => !SEARCH_STOPWORDS.has(w));
    if (meaningfulWords.length < SEARCH_MIN_WORDS) return [];

    const results: SearchResult[] = [];
    const searchQuery = queryWords.join(' ');

    for (let i = 0; i <= adjWords.length - queryWords.length; i++) {
      const windowWords = adjWords.slice(i, i + queryWords.length);
      const windowText = windowWords.map((w) => w.text.toLowerCase()).join(' ');

      if (windowText.includes(searchQuery) || searchQuery.includes(windowText)) {
        results.push({
          wordIndex: i,
          word: adjWords[i],
          matchStart: 0,
          matchEnd: queryWords.length,
        });
      }
    }

    return results;
  }

  // ─── Cut/delete adjustments ───

  /** Remove words in [cutStart, cutEnd] and shift remaining words left by the gap duration */
  function adjustForCut(trackId: string, cutStart: number, cutEnd: number): void {
    const t = transcriptions.value.get(trackId);
    if (!t) return;

    const gapDuration = cutEnd - cutStart;
    if (gapDuration <= 0) return;

    const track = tracksStore.tracks.find(tr => tr.id === trackId);
    const trackOffset = track?.trackStart ?? 0;

    // Build set of word IDs to remove (words entirely within the cut region)
    const idsToRemove = new Set<string>();
    for (const w of t.words) {
      const offsetMs = t.wordOffsets.get(w.id) ?? 0;
      const adjStart = w.start + trackOffset + offsetMs / 1000;
      const adjEnd = w.end + trackOffset + offsetMs / 1000;
      if (adjStart >= cutStart && adjEnd <= cutEnd) {
        idsToRemove.add(w.id);
      }
    }

    // Filter out removed words and shift remaining ones
    const newWords = t.words
      .filter(w => !idsToRemove.has(w.id))
      .map(w => {
        const offsetMs = t.wordOffsets.get(w.id) ?? 0;
        const adjStart = w.start + trackOffset + offsetMs / 1000;

        if (adjStart >= cutEnd) {
          // Word is after the cut - shift its base timing left
          return {
            ...w,
            start: w.start - gapDuration,
            end: w.end - gapDuration,
          };
        }
        return w;
      });

    // Clear per-word offsets for removed words
    for (const id of idsToRemove) {
      t.wordOffsets.delete(id);
    }

    t.words = newWords;
    t.fullText = newWords.map(w => w.text).join(' ');

    console.log(`[Transcription] adjustForCut(${trackId}): removed ${idsToRemove.size} words, shifted remaining left by ${gapDuration.toFixed(2)}s`);
  }

  /** Remove words in [deleteStart, deleteEnd] without shifting (gap left in place) */
  function adjustForDelete(trackId: string, deleteStart: number, deleteEnd: number): void {
    const t = transcriptions.value.get(trackId);
    if (!t) return;

    const track = tracksStore.tracks.find(tr => tr.id === trackId);
    const trackOffset = track?.trackStart ?? 0;

    const idsToRemove = new Set<string>();
    for (const w of t.words) {
      const offsetMs = t.wordOffsets.get(w.id) ?? 0;
      const adjStart = w.start + trackOffset + offsetMs / 1000;
      const adjEnd = w.end + trackOffset + offsetMs / 1000;
      if (adjStart >= deleteStart && adjEnd <= deleteEnd) {
        idsToRemove.add(w.id);
      }
    }

    for (const id of idsToRemove) {
      t.wordOffsets.delete(id);
    }

    t.words = t.words.filter(w => !idsToRemove.has(w.id));
    t.fullText = t.words.map(w => w.text).join(' ');

    console.log(`[Transcription] adjustForDelete(${trackId}): removed ${idsToRemove.size} words`);
  }

  /** Remove an entire track's transcription */
  function removeTranscription(trackId: string): void {
    console.log(`[Transcription][MAP] removeTranscription(${trackId.slice(0, 8)})`);
    logMapState('BEFORE removeTranscription');
    transcriptions.value.delete(trackId);
    logMapState('AFTER removeTranscription');
    // Also remove any pending jobs for this track
    jobQueue.value = jobQueue.value.filter(j => j.trackId !== trackId);
  }

  // ─── Background job queue ───

  function queueTranscription(trackId: string, priority: 'high' | 'normal' = 'normal'): void {
    // Skip if already queued or running for this track
    const existing = jobQueue.value.find(j => j.trackId === trackId && (j.status === 'queued' || j.status === 'running'));
    if (existing) {
      console.log(`[Transcription] Already queued/running for track ${trackId}, skipping`);
      return;
    }

    const job: TranscriptionJob = {
      id: generateId(),
      trackId,
      priority,
      status: 'queued',
      progress: 0,
    };

    jobQueue.value = [...jobQueue.value, job];
    console.log(`[Transcription] Queued transcription for track ${trackId} (${priority})`);
    kickProcessor();
  }

  function kickProcessor(): void {
    if (processorRunning) return;
    processNextJob();
  }

  async function processNextJob(): Promise<void> {
    // Pick highest priority, oldest job
    const pending = jobQueue.value
      .filter(j => j.status === 'queued')
      .sort((a, b) => {
        if (a.priority === 'high' && b.priority !== 'high') return -1;
        if (b.priority === 'high' && a.priority !== 'high') return 1;
        return 0; // preserve insertion order
      });

    if (pending.length === 0) {
      processorRunning = false;
      loading.value = false;
      return;
    }

    processorRunning = true;
    const job = pending[0];
    job.status = 'running';
    jobQueue.value = [...jobQueue.value]; // trigger reactivity

    // Update global loading state if this is the selected track
    if (job.trackId === tracksStore.selectedTrackId) {
      loading.value = true;
      error.value = null;
    }

    try {
      await runTranscriptionForTrack(job.trackId);
      job.status = 'complete';
      job.progress = 100;
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
      console.error(`[Transcription] Job failed for track ${job.trackId}:`, e);
      if (job.trackId === tracksStore.selectedTrackId) {
        error.value = job.error;
      }
    }

    jobQueue.value = [...jobQueue.value];

    // Update loading state
    if (job.trackId === tracksStore.selectedTrackId) {
      loading.value = false;
    }

    // Process next
    processNextJob();
  }

  // ─── Load or queue ───

  async function loadOrQueueTranscription(trackId: string): Promise<void> {
    logMapState(`loadOrQueueTranscription(${trackId.slice(0, 8)})`);

    // Already have it in memory?
    if (transcriptions.value.has(trackId)) {
      console.log(`[Transcription] Already in memory for track ${trackId.slice(0, 8)}, skipping`);
      return;
    }

    // Try to load from disk
    const loaded = await loadTranscriptionFromDisk(trackId);
    if (loaded) {
      logMapState(`AFTER disk load for ${trackId.slice(0, 8)}`);
      return;
    }

    // Queue for background transcription
    queueTranscription(trackId, 'high');
  }

  // ─── Disk persistence ───

  function getTrackPath(trackId: string): string | null {
    const track = tracksStore.tracks.find(t => t.id === trackId);
    return track?.sourcePath ?? audioStore.lastImportedPath;
  }

  async function saveTranscription(trackId: string): Promise<void> {
    const audioPath = getTrackPath(trackId);
    const t = transcriptions.value.get(trackId);
    if (!audioPath || !t) return;

    const metadata: TranscriptionMetadata = {
      audioPath,
      globalOffsetMs: 0, // No longer used, kept for backwards compat
      wordAdjustments: Array.from(t.wordOffsets.entries()).map(([wordId, offsetMs]) => ({
        wordId,
        offsetMs,
      })),
      savedAt: Date.now(),
      words: t.words,
      fullText: t.fullText,
      language: t.language,
    };

    try {
      await invoke('save_transcription_metadata', {
        audioPath,
        metadata,
      });
      console.log(`[Transcription] Saved transcription for track ${trackId}`);
    } catch (e) {
      console.error('[Transcription] Failed to save transcription:', e);
    }
  }

  async function loadTranscriptionFromDisk(trackId: string): Promise<boolean> {
    const audioPath = getTrackPath(trackId);
    if (!audioPath) return false;

    try {
      const metadata = await invoke<TranscriptionMetadata | null>('load_transcription_metadata', {
        audioPath,
      });

      if (metadata && metadata.words && metadata.words.length > 0) {
        const wordOffsets = new Map<string, number>();
        for (const adj of metadata.wordAdjustments || []) {
          wordOffsets.set(adj.wordId, adj.offsetMs);
        }

        logMapState(`BEFORE disk load set(${trackId.slice(0, 8)})`);
        transcriptions.value.set(trackId, {
          trackId,
          words: metadata.words,
          fullText: metadata.fullText || metadata.words.map(w => w.text).join(' '),
          language: metadata.language || 'en',
          processedAt: metadata.savedAt,
          wordOffsets,
          enableFalloff: true,
        });
        logMapState(`AFTER disk load set(${trackId.slice(0, 8)})`);

        console.log(`[Transcription] Loaded from disk for track ${trackId}`);
        return true;
      }

      return false;
    } catch (e) {
      console.log(`[Transcription] No existing transcription for track ${trackId}:`, e);
      return false;
    }
  }

  // ─── Core transcription runner ───

  async function runTranscriptionForTrack(trackId: string): Promise<void> {
    const track = tracksStore.tracks.find(t => t.id === trackId);
    if (!track) throw new Error(`Track ${trackId} not found`);

    // Update progress for this job
    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'loading', progress: 5, message: 'Checking model...' };
    }

    const modelAvailable = await checkModel();
    if (!modelAvailable) {
      const customPath = getCustomPath();
      const dir = customPath || modelsDirectory.value || '~/.local/share/clip-doctor-scrubs/models';
      throw new Error(`Whisper model not found. Download ggml-tiny.bin from huggingface.co/ggerganov/whisper.cpp and place in: ${dir}`);
    }

    // Decide: use source file or mix from buffer
    const audioPath = track.sourcePath;
    const hasClips = track.clips && track.clips.length > 0;

    if (audioPath && !hasClips) {
      // Simple case: transcribe from file
      await runTranscriptionFromFile(trackId, audioPath);
    } else {
      // Multi-clip or no source file: mix and transcribe from buffer
      await runTranscriptionFromBuffer(trackId);
    }
  }

  async function runTranscriptionFromFile(trackId: string, audioPath: string): Promise<void> {
    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'transcribing', progress: 15, message: 'Transcribing audio...' };
    }

    const customPath = getCustomPath();
    const result = await invoke<{ words: Word[]; text: string; language: string }>(
      'transcribe_audio',
      {
        path: audioPath,
        modelsPath: customPath,
      }
    );

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'aligning', progress: 90, message: 'Aligning words...' };
    }

    logMapState(`BEFORE set in runTranscriptionFromFile(${trackId.slice(0, 8)})`);
    transcriptions.value.set(trackId, {
      trackId,
      words: result.words.map((w) => ({ ...w, id: w.id || generateId() })),
      fullText: result.text,
      language: result.language,
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });
    logMapState(`AFTER set in runTranscriptionFromFile(${trackId.slice(0, 8)})`);

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'complete', progress: 100, message: 'Complete!' };
    }

    await saveTranscription(trackId);
  }

  // Mix track clips into a single buffer for transcription
  function mixTrackClipsToBuffer(trackId: string): AudioBuffer | null {
    const clips = tracksStore.getTrackClips(trackId);
    if (clips.length === 0) return null;

    const audioContext = audioStore.getAudioContext();

    let timelineStart = Infinity;
    let timelineEnd = 0;
    let sampleRate = 44100;

    for (const clip of clips) {
      timelineStart = Math.min(timelineStart, clip.clipStart);
      timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
      sampleRate = clip.buffer.sampleRate;
    }

    const totalDuration = timelineEnd - timelineStart;
    const totalSamples = Math.ceil(totalDuration * sampleRate);
    const numChannels = Math.max(...clips.map(c => c.buffer.numberOfChannels));

    const mixedBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);

    for (const clip of clips) {
      const startSample = Math.floor((clip.clipStart - timelineStart) * sampleRate);

      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);

        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            outputData[startSample + i] += inputData[i];
          }
        }
      }
    }

    return mixedBuffer;
  }

  async function runTranscriptionFromBuffer(trackId: string): Promise<void> {
    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'loading', progress: 10, message: 'Preparing audio...' };
    }

    const mixedBuffer = mixTrackClipsToBuffer(trackId);
    if (!mixedBuffer) throw new Error('No audio clips to transcribe');

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'loading', progress: 20, message: 'Encoding audio...' };
    }

    const wavData = encodeWav(mixedBuffer);

    const tempFileName = `transcribe_buffer_${Date.now()}.wav`;
    await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
    const tempDirPath = await tempDir();
    const tempPath = `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${tempFileName}`;

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'transcribing', progress: 30, message: 'Transcribing audio...' };
    }

    const customPath = getCustomPath();
    const result = await invoke<{ words: Word[]; text: string; language: string }>(
      'transcribe_audio',
      {
        path: tempPath,
        modelsPath: customPath,
      }
    );

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'aligning', progress: 90, message: 'Aligning words...' };
    }

    logMapState(`BEFORE set in runTranscriptionFromBuffer(${trackId.slice(0, 8)})`);
    transcriptions.value.set(trackId, {
      trackId,
      words: result.words.map((w) => ({ ...w, id: w.id || generateId() })),
      fullText: result.text,
      language: result.language,
      processedAt: Date.now(),
      wordOffsets: new Map(),
      enableFalloff: true,
    });
    logMapState(`AFTER set in runTranscriptionFromBuffer(${trackId.slice(0, 8)})`);

    if (trackId === tracksStore.selectedTrackId) {
      progress.value = { stage: 'complete', progress: 100, message: 'Complete!' };
    }

    await saveTranscription(trackId);
  }

  // ─── Exposed return ───
  return {
    transcriptions,
    jobQueue,
    // Per-track getters
    hasTranscriptionForTrack,
    getTranscription,
    getAdjustedWords,
    getWordsInRange,
    getWordAtTime,
    // Backwards-compat computeds (operate on selected track)
    hasTranscription,
    adjustedWords,
    // Actions
    queueTranscription,
    loadOrQueueTranscription,
    removeTranscription,
    // Word editing
    setWordOffset,
    updateWordText,
    getWordOffset,
    setEnableFalloff,
    // Search
    searchWords,
    // Adjustment
    adjustForCut,
    adjustForDelete,
    // Persistence
    saveTranscription,
    // Model
    checkModel,
    loadAvailableModels,
    hasModel,
    modelPath,
    modelsDirectory,
    availableModels,
    // Misc
    loading,
    progress,
    error,
  };
});
