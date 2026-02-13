import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AudioLoadResult, ImportStartResult, WaveformChunkEvent, ImportCompleteEvent } from '@/shared/types';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { getFileName } from '@/shared/utils';
import { useTracksStore } from './tracks';
import { useHistoryStore } from './history';

export const useAudioStore = defineStore('audio', () => {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const audioContext = ref<AudioContext | null>(null);

  // Track the last imported file path for reference
  const lastImportedPath = ref<string | null>(null);

  function initAudioContext() {
    if (!audioContext.value) {
      audioContext.value = new AudioContext();
    }
    return audioContext.value;
  }

  async function resumeAudioContext(): Promise<void> {
    const ctx = initAudioContext();
    if (ctx.state === 'suspended') {
      console.log('Resuming suspended AudioContext...');
      await ctx.resume();
      console.log('AudioContext resumed, state:', ctx.state);
    }
  }

  function getAudioContext(): AudioContext {
    return initAudioContext();
  }

  // Import a file using progressive three-phase approach
  async function importFile(path: string): Promise<void> {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Import file');
    error.value = null;

    try {
      const tracksStore = useTracksStore();
      const { useSelectionStore } = await import('./selection');
      const selectionStore = useSelectionStore();
      const ctx = initAudioContext();

      const startTime = performance.now();
      console.log('[Audio] Starting progressive import...');

      // Phase 1: Probe metadata and create track instantly
      const result = await invoke<ImportStartResult>('import_audio_start', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });

      const { sessionId, metadata } = result;
      console.log(`[Audio] Phase 1 done in ${(performance.now() - startTime).toFixed(0)}ms — metadata:`, metadata);

      const fileName = getFileName(path);
      const trackStart = tracksStore.timelineDuration;
      const newTrack = tracksStore.createImportingTrack(
        fileName,
        metadata,
        trackStart,
        sessionId,
        path,
      );
      const trackId = newTrack.id;

      selectionStore.resetSelection();
      tracksStore.selectTrack(trackId);
      lastImportedPath.value = path;

      // Phase 2: Listen for progressive waveform chunks from Rust
      const unlistenChunk = await listen<WaveformChunkEvent>('import-waveform-chunk', (event) => {
        if (event.payload.sessionId !== sessionId) return;
        // Check track still exists (may have been undone/deleted)
        const track = tracksStore.tracks.find(t => t.id === trackId);
        if (!track) return;
        tracksStore.updateImportWaveform(trackId, event.payload);
      });

      const waveformDone = new Promise<void>((resolve, reject) => {
        let unlistenComplete: (() => void) | null = null;
        let unlistenError: (() => void) | null = null;

        const cleanup = () => {
          unlistenComplete?.();
          unlistenError?.();
        };

        listen<ImportCompleteEvent>('import-complete', (event) => {
          if (event.payload.sessionId !== sessionId) return;
          const track = tracksStore.tracks.find(t => t.id === trackId);
          if (track) {
            tracksStore.finalizeImportWaveform(trackId, event.payload.waveform, event.payload.actualDuration);
          }
          cleanup();
          resolve();
        }).then(fn => { unlistenComplete = fn; });

        listen<{ sessionId: string; error: string }>('import-error', (event) => {
          if (event.payload.sessionId !== sessionId) return;
          cleanup();
          reject(new Error(event.payload.error));
        }).then(fn => { unlistenError = fn; });
      });

      // Phase 3: Browser decodes audio via asset protocol (concurrent with Phase 2)
      const browserDecodePromise = (async () => {
        try {
          const assetUrl = convertFileSrc(path);
          console.log('[Audio] Phase 3: fetching via asset protocol:', assetUrl);
          const response = await fetch(assetUrl);
          const arrayBuffer = await response.arrayBuffer();
          console.log(`[Audio] Phase 3: fetched ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB, decoding...`);
          const buffer = await ctx.decodeAudioData(arrayBuffer);
          console.log(`[Audio] Phase 3: browser decode done, duration: ${buffer.duration.toFixed(2)}s`);
          return buffer;
        } catch (e) {
          console.warn('[Audio] Phase 3 failed (browser decode), will fall back to legacy:', e);
          return null;
        }
      })();

      // Wait for both phases to complete
      const [, audioBuffer] = await Promise.all([waveformDone, browserDecodePromise]);
      unlistenChunk();

      // Check track still exists
      const track = tracksStore.tracks.find(t => t.id === trackId);
      if (!track) {
        console.log('[Audio] Track was deleted during import, discarding');
        historyStore.endBatch();
        return;
      }

      if (audioBuffer) {
        // Success: set the browser-decoded buffer
        tracksStore.setImportBuffer(trackId, audioBuffer);
        const totalTime = performance.now() - startTime;
        console.log(`[Audio] Progressive import complete in ${(totalTime / 1000).toFixed(2)}s`);
      } else {
        // Fallback: browser couldn't decode (e.g. WMA) — use legacy monolithic load
        console.warn('[Audio] Falling back to legacy load_audio_complete...');
        await importFileLegacy(path, trackId, ctx);
      }

      // Now that audio is fully loaded, trigger transcription
      const { useTranscriptionStore } = await import('./transcription');
      const transcriptionStore = useTranscriptionStore();
      transcriptionStore.loadOrQueueTranscription(trackId);

      console.log('[Audio] Audio ready for playback');
    } catch (e) {
      console.error('[Audio] Import error:', e);
      error.value = e instanceof Error ? e.message : 'Failed to load audio file';
      throw e;
    } finally {
      loading.value = false;
      historyStore.endBatch();
    }
  }

  // Legacy fallback: monolithic load via Rust IPC (for formats browser can't decode)
  async function importFileLegacy(path: string, trackId: string, ctx: AudioContext): Promise<void> {
    const tracksStore = useTracksStore();

    console.log('[Audio] Legacy loading audio (single-pass)...');
    const startTime = performance.now();

    const result = await invoke<AudioLoadResult>('load_audio_complete', {
      path,
      bucketCount: WAVEFORM_BUCKET_COUNT,
    });

    const loadTime = performance.now() - startTime;
    console.log(`[Audio] Legacy load in ${(loadTime / 1000).toFixed(2)}s`);

    const { metadata, waveform: waveformData, channels } = result;

    if (!metadata.sampleRate || !metadata.channels || metadata.sampleRate <= 0 || metadata.channels <= 0) {
      throw new Error('Invalid audio metadata');
    }

    if (channels.length === 0 || channels[0].length === 0) {
      throw new Error('No audio data loaded');
    }

    const samplesPerChannel = channels[0].length;

    const buffer = ctx.createBuffer(
      metadata.channels,
      samplesPerChannel,
      metadata.sampleRate
    );

    for (let channel = 0; channel < metadata.channels; channel++) {
      const channelData = buffer.getChannelData(channel);
      const sourceData = channels[channel];
      if (!sourceData || sourceData.length === 0) continue;
      const float32Data = sourceData instanceof Float32Array
        ? sourceData
        : new Float32Array(sourceData);
      channelData.set(float32Data);
    }

    // Update the track with the final waveform and buffer
    tracksStore.finalizeImportWaveform(trackId, waveformData, buffer.duration);
    tracksStore.setImportBuffer(trackId, buffer);
  }

  function unloadAll(): void {
    lastImportedPath.value = null;
    error.value = null;
    // Clear tracks and cleaned audio
    useTracksStore().clearTracks();
    import('./cleaning').then(({ useCleaningStore }) => {
      useCleaningStore().clearCleanedAudio();
    });
  }

  // Computed: Check if any audio is loaded (delegates to tracks store)
  const hasAudio = computed(() => {
    return useTracksStore().hasAudio;
  });

  // Computed: Get timeline duration from tracks
  const duration = computed(() => {
    return useTracksStore().timelineDuration;
  });

  return {
    loading,
    error,
    lastImportedPath,
    hasAudio,
    duration,
    importFile,
    unloadAll,
    getAudioContext,
    resumeAudioContext,
  };
});
