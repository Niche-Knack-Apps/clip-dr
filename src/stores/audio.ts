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
  // Phase 1: metadata probe (~30ms) → track visible instantly
  // Phase 2: Rust waveform decode (background) → progressive fill-in
  // Phase 3: Browser decode via asset protocol → buffer ready for playback
  //
  // Import is "complete" when BOTH buffer AND waveform are ready.
  // Playback is enabled as soon as buffer arrives (Phase 3).
  // Transcription only starts after import is fully complete.
  // The loading flag (import button spinner) stays active until fully complete.
  async function importFile(path: string): Promise<void> {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Import file');
    loading.value = true;
    error.value = null;

    try {
      const tracksStore = useTracksStore();
      const { useSelectionStore } = await import('./selection');
      const selectionStore = useSelectionStore();
      const ctx = initAudioContext();

      const t0 = performance.now();
      const ms = () => `${(performance.now() - t0).toFixed(0)}ms`;
      console.log(`[Audio] ── Import started ──`);

      // Phase 1: Probe metadata and create track instantly
      const result = await invoke<ImportStartResult>('import_audio_start', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });

      const { sessionId, metadata, cachedWaveform, cachedDuration } = result;
      const cacheHit = !!(cachedWaveform && cachedDuration);
      console.log(`[Audio] [${ms()}] Phase 1 complete: metadata probe — ${metadata.format} ${metadata.channels}ch ${metadata.sampleRate}Hz ${metadata.duration.toFixed(1)}s${cacheHit ? ' (PEAK CACHE HIT)' : ''}`);

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
      console.log(`[Audio] [${ms()}] Track created: ${trackId.slice(0, 8)} at ${trackStart.toFixed(1)}s`);

      selectionStore.setSelection(0, tracksStore.timelineDuration);
      tracksStore.selectTrack(trackId);
      lastImportedPath.value = path;

      // ── Waveform completion tracking ──
      let waveformSettled = false;

      if (cacheHit) {
        // Peak cache hit: waveform returned inline, no background events needed
        tracksStore.finalizeImportWaveform(trackId, cachedWaveform!, cachedDuration!);
        waveformSettled = true;
        console.log(`[Audio] [${ms()}] Waveform loaded from cache (${cachedDuration!.toFixed(1)}s)`);
      }

      // Only set up listeners if waveform is NOT already settled from cache
      let resolveWaveform: (() => void) | undefined;
      const waveformDone = waveformSettled
        ? Promise.resolve()
        : new Promise<void>(resolve => { resolveWaveform = resolve; });

      let unlistenChunk: (() => void) | undefined;
      let unlistenComplete: (() => void) | undefined;
      let unlistenError: (() => void) | undefined;

      if (!waveformSettled) {
        // Phase 2: Listen for progressive waveform chunks from Rust (runs in background)
        let chunkCount = 0;
        unlistenChunk = await listen<WaveformChunkEvent>('import-waveform-chunk', (event) => {
          if (event.payload.sessionId !== sessionId) return;
          const track = tracksStore.tracks.find(t => t.id === trackId);
          if (!track) return;
          tracksStore.updateImportWaveform(trackId, event.payload);
          chunkCount++;
          if (chunkCount === 1) {
            console.log(`[Audio] [${ms()}] First waveform chunk received (progress: ${(event.payload.progress * 100).toFixed(0)}%)`);
          }
        });
        console.log(`[Audio] [${ms()}] Phase 2 listeners registered`);

        // Register both completion and error listeners simultaneously (no race condition)
        unlistenComplete = await listen<ImportCompleteEvent>('import-complete', (event) => {
          if (event.payload.sessionId !== sessionId) return;
          const track = tracksStore.tracks.find(t => t.id === trackId);
          if (track) {
            tracksStore.finalizeImportWaveform(trackId, event.payload.waveform, event.payload.actualDuration);
            console.log(`[Audio] [${ms()}] Phase 2 complete: waveform finalized (${chunkCount} chunks, duration: ${event.payload.actualDuration.toFixed(1)}s)`);
          }
          waveformSettled = true;
          resolveWaveform?.();
          unlistenChunk?.();
          unlistenComplete?.();
          unlistenError?.();
        });

        unlistenError = await listen<{ sessionId: string; error: string }>('import-error', (event) => {
          if (event.payload.sessionId !== sessionId) return;
          console.error(`[Audio] [${ms()}] Phase 2 error: ${event.payload.error}`);
          waveformSettled = true;
          resolveWaveform?.();
          unlistenChunk?.();
          unlistenComplete?.();
          unlistenError?.();
        });
      }

      // Phase 3: Browser decodes audio via asset protocol (concurrent with Phase 2)
      // Uses streaming fetch to report download progress to the UI
      let audioBuffer: AudioBuffer | null = null;
      try {
        const assetUrl = convertFileSrc(path);
        console.log(`[Audio] [${ms()}] Phase 3 started: fetching via asset protocol`);
        const response = await fetch(assetUrl);
        const contentLength = Number(response.headers.get('content-length') || 0);
        console.log(`[Audio] [${ms()}] Phase 3 response: status=${response.status}, content-length=${contentLength > 0 ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : 'unknown'}`);

        let arrayBuffer: ArrayBuffer;
        if (contentLength > 0 && response.body) {
          // Stream the response to track download progress
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let received = 0;
          let lastReportedProgress = 0;
          let progressRafId: number | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            // Report fetch progress (0-0.8 of decode phase, 0.8-1.0 reserved for decodeAudioData)
            lastReportedProgress = Math.min(received / contentLength, 1) * 0.8;

            // Throttle progress updates to one per animation frame
            if (progressRafId === null) {
              progressRafId = requestAnimationFrame(() => {
                progressRafId = null;
                tracksStore.updateImportDecodeProgress(trackId, lastReportedProgress);
              });
            }
          }
          // Ensure final fetch progress is reported
          if (progressRafId !== null) cancelAnimationFrame(progressRafId);

          console.log(`[Audio] [${ms()}] Phase 3 fetch complete: ${(received / 1024 / 1024).toFixed(1)}MB streamed`);

          // Concatenate chunks into single ArrayBuffer
          const full = new Uint8Array(received);
          let offset = 0;
          for (const chunk of chunks) {
            full.set(chunk, offset);
            offset += chunk.length;
          }
          arrayBuffer = full.buffer;
        } else {
          // No content-length (or no body stream) — fall back to simple fetch
          arrayBuffer = await response.arrayBuffer();
          console.log(`[Audio] [${ms()}] Phase 3 fetch complete: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB (non-streamed)`);
        }

        tracksStore.updateImportDecodeProgress(trackId, 0.85);
        console.log(`[Audio] [${ms()}] Phase 3 decoding audio buffer...`);
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        tracksStore.updateImportDecodeProgress(trackId, 1.0);
        console.log(`[Audio] [${ms()}] Phase 3 complete: browser decode done (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz)`);
      } catch (e) {
        console.warn(`[Audio] [${ms()}] Phase 3 failed (browser decode):`, e);
      }

      // Check track still exists (may have been deleted during decode)
      const track = tracksStore.tracks.find(t => t.id === trackId);
      if (!track) {
        console.log(`[Audio] [${ms()}] Track deleted during import, discarding`);
        // Clean up waveform listeners if still pending
        if (!waveformSettled) {
          unlistenChunk?.();
          unlistenComplete?.();
          unlistenError?.();
        }
        historyStore.endBatch();
        return;
      }

      if (audioBuffer) {
        // Set buffer immediately — track becomes playable NOW
        tracksStore.setImportBuffer(trackId, audioBuffer);
        // Position playhead at start of imported track
        const { usePlaybackStore } = await import('./playback');
        usePlaybackStore().seek(trackStart);
        // Update selection to cover full timeline with actual buffer duration
        selectionStore.setSelection(0, tracksStore.timelineDuration);
        console.log(`[Audio] [${ms()}] Buffer set — playback enabled, playhead at ${trackStart.toFixed(1)}s`);
      } else {
        // Fallback: browser couldn't decode (e.g. WMA) — use legacy monolithic load
        console.warn(`[Audio] [${ms()}] Falling back to legacy load_audio_complete...`);
        await importFileLegacy(path, trackId, ctx);
      }

      // Wait for waveform to also complete before considering import "done"
      if (!waveformSettled) {
        console.log(`[Audio] [${ms()}] Waiting for waveform to finalize...`);
        await waveformDone;
        console.log(`[Audio] [${ms()}] Waveform settled`);
      }

      // NOW import is fully complete — trigger transcription
      const { useTranscriptionStore } = await import('./transcription');
      const transcriptionStore = useTranscriptionStore();
      transcriptionStore.loadOrQueueTranscription(trackId);

      console.log(`[Audio] ── Import complete in ${((performance.now() - t0) / 1000).toFixed(2)}s ──`);
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
