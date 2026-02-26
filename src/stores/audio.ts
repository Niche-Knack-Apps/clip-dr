import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImportStartResult, WaveformChunkEvent, ImportCompleteEvent } from '@/shared/types';
import { WAVEFORM_BUCKET_COUNT, LARGE_FILE_PCM_THRESHOLD } from '@/shared/constants';
import { getFileName } from '@/shared/utils';
import { useTracksStore } from './tracks';
import { useHistoryStore } from './history';

// ── Global waveform event routing ────────────────────────────────────
// Persistent listeners registered once, routing events by sessionId.
// Eliminates the race condition where Rust emits events before per-import
// await listen() calls finish registering.

interface WaveformSessionCallbacks {
  onChunk: (event: WaveformChunkEvent) => void;
  onComplete: (event: ImportCompleteEvent) => void;
  onError: (error: string) => void;
}

const waveformSessions = new Map<string, WaveformSessionCallbacks>();
let globalWaveformListenersReady = false;

// Buffer for events that arrive before session callbacks are registered.
// The WAV mmap fast path in Rust can complete and emit import-complete
// before the frontend's invoke() returns and registers the session callbacks.
const pendingWaveformEvents = new Map<string, {
  chunks: WaveformChunkEvent[];
  complete?: ImportCompleteEvent;
  error?: string;
}>();

function ensureGlobalWaveformListeners(): void {
  if (globalWaveformListenersReady) return;
  globalWaveformListenersReady = true;

  listen<WaveformChunkEvent>('import-waveform-chunk', (event) => {
    const cb = waveformSessions.get(event.payload.sessionId);
    if (cb) {
      cb.onChunk(event.payload);
    } else {
      let pending = pendingWaveformEvents.get(event.payload.sessionId);
      if (!pending) { pending = { chunks: [] }; pendingWaveformEvents.set(event.payload.sessionId, pending); }
      pending.chunks.push(event.payload);
    }
  });

  listen<ImportCompleteEvent>('import-complete', (event) => {
    const cb = waveformSessions.get(event.payload.sessionId);
    if (cb) {
      cb.onComplete(event.payload);
      waveformSessions.delete(event.payload.sessionId);
    } else {
      let pending = pendingWaveformEvents.get(event.payload.sessionId);
      if (!pending) { pending = { chunks: [] }; pendingWaveformEvents.set(event.payload.sessionId, pending); }
      pending.complete = event.payload;
    }
  });

  listen<{ sessionId: string; error: string }>('import-error', (event) => {
    const cb = waveformSessions.get(event.payload.sessionId);
    if (cb) {
      cb.onError(event.payload.error);
      waveformSessions.delete(event.payload.sessionId);
    } else {
      let pending = pendingWaveformEvents.get(event.payload.sessionId);
      if (!pending) { pending = { chunks: [] }; pendingWaveformEvents.set(event.payload.sessionId, pending); }
      pending.error = event.payload.error;
    }
  });
}

// Register session callbacks AND replay any buffered events
function registerWaveformSession(sessionId: string, callbacks: WaveformSessionCallbacks): void {
  waveformSessions.set(sessionId, callbacks);

  const pending = pendingWaveformEvents.get(sessionId);
  if (pending) {
    pendingWaveformEvents.delete(sessionId);
    for (const chunk of pending.chunks) {
      callbacks.onChunk(chunk);
    }
    if (pending.error) {
      callbacks.onError(pending.error);
      waveformSessions.delete(sessionId);
    } else if (pending.complete) {
      callbacks.onComplete(pending.complete);
      waveformSessions.delete(sessionId);
    }
  }
}

export const useAudioStore = defineStore('audio', () => {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const audioContext = ref<AudioContext | null>(null);

  // Track the last imported file path for reference
  const lastImportedPath = ref<string | null>(null);

  // Listen for peak pyramid completion from Rust
  listen<{ sourcePath: string }>('peak-pyramid-ready', (event) => {
    const tracksStore = useTracksStore();
    const track = tracksStore.tracks.find(t => t.sourcePath === event.payload.sourcePath);
    if (track) {
      tracksStore.setHasPeakPyramid(track.id);
      console.log(`[Audio] Peak pyramid ready for track: ${track.name}`);
    }
  });

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

      // Ensure global waveform listeners exist before any Rust events can fire
      ensureGlobalWaveformListeners();

      // Phase 1: Probe metadata and create track instantly
      const result = await invoke<ImportStartResult>('import_audio_start', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });

      const { sessionId, metadata, cachedWaveform, cachedDuration, hasPeakPyramid } = result;
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

      // Set pyramid flag immediately if Rust reported it exists on disk.
      // This avoids the race condition where the peak-pyramid-ready event
      // fires before the track is created in the frontend.
      if (hasPeakPyramid) {
        tracksStore.setHasPeakPyramid(trackId);
      }

      selectionStore.setSelection(0, tracksStore.timelineDuration);
      tracksStore.selectTrack(trackId);
      lastImportedPath.value = path;

      // Check if file is too large for browser decode
      const estimatedPcm = metadata.duration * metadata.sampleRate * metadata.channels * 4;
      const isLargeFile = estimatedPcm > LARGE_FILE_PCM_THRESHOLD;
      if (isLargeFile) {
        console.warn(`[Audio] [${ms()}] File too large for browser decode: ${(estimatedPcm / 1024 / 1024).toFixed(0)}MB estimated PCM (threshold: ${(LARGE_FILE_PCM_THRESHOLD / 1024 / 1024).toFixed(0)}MB)`);
      }

      // Set up listeners for background cache decode events (large files)
      let unlistenCacheProgress: (() => void) | undefined;
      let unlistenCacheReady: (() => void) | undefined;

      if (isLargeFile) {
        unlistenCacheProgress = await listen<{ trackId: string; progress: number }>('audio-cache-progress', (event) => {
          if (event.payload.trackId !== trackId) return;
          tracksStore.updateImportDecodeProgress(trackId, event.payload.progress);
        });

        unlistenCacheReady = await listen<{ trackId: string; cachedPath: string }>('audio-cache-ready', (event) => {
          if (event.payload.trackId !== trackId) return;
          console.log(`[Audio] [${ms()}] Cache ready for ${trackId}: ${event.payload.cachedPath}`);
          tracksStore.setCachedAudioPath(trackId, event.payload.cachedPath);
          // If track is currently loaded in playback engine, hot-swap stream → mmap
          invoke('playback_swap_to_cache', { trackId, cachedPath: event.payload.cachedPath })
            .catch(e => console.warn('[Audio] swap_to_cache:', e));
          unlistenCacheProgress?.();
          unlistenCacheReady?.();
        });
      }

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

      if (!waveformSettled) {
        // Phase 2: Register callbacks synchronously via global listeners (no await gap = no race)
        let chunkCount = 0;
        registerWaveformSession(sessionId, {
          onChunk: (payload) => {
            const track = tracksStore.tracks.find(t => t.id === trackId);
            if (!track) return;
            tracksStore.updateImportWaveform(trackId, payload);
            chunkCount++;
            if (chunkCount === 1) {
              console.log(`[Audio] [${ms()}] First waveform chunk received (progress: ${(payload.progress * 100).toFixed(0)}%)`);
            }
          },
          onComplete: (payload) => {
            const track = tracksStore.tracks.find(t => t.id === trackId);
            if (track) {
              tracksStore.finalizeImportWaveform(trackId, payload.waveform, payload.actualDuration);
              console.log(`[Audio] [${ms()}] Phase 2 complete: waveform finalized (${chunkCount} chunks, duration: ${payload.actualDuration.toFixed(1)}s)`);
            }
            waveformSettled = true;
            resolveWaveform?.();
          },
          onError: (errorMsg) => {
            console.error(`[Audio] [${ms()}] Phase 2 error: ${errorMsg}`);
            waveformSettled = true;
            resolveWaveform?.();
          },
        });
        console.log(`[Audio] [${ms()}] Phase 2 callbacks registered (global listeners)`);
      }

      // Phase 3: Browser decodes audio via asset protocol (concurrent with Phase 2)
      // Skipped for large files to avoid WebView OOM crashes
      let audioBuffer: AudioBuffer | null = null;
      if (isLargeFile) {
        // Skip browser decode — mark as large-file then start background cache
        tracksStore.setImportLargeFile(trackId);
        tracksStore.setImportCaching(trackId);
        console.log(`[Audio] [${ms()}] Phase 3 skipped: file too large for browser decode`);
        console.log(`[Audio] [${ms()}] Background cache started via prepare_audio_cache`);
        invoke('prepare_audio_cache', { path, trackId })
          .catch(e => console.error('[Audio] prepare_audio_cache failed:', e));
      } else {
        // Uses streaming fetch to report download progress to the UI
        try {
          const assetUrl = convertFileSrc(path);
          console.log(`[Audio] [${ms()}] Phase 3 started: fetching via asset protocol`);
          const response = await fetch(assetUrl);
          if (!response.ok) {
            throw new Error(`Asset protocol returned HTTP ${response.status} for ${path}`);
          }
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

          if (arrayBuffer.byteLength === 0) {
            throw new Error('Asset protocol returned empty response body');
          }

          tracksStore.updateImportDecodeProgress(trackId, 0.85);
          console.log(`[Audio] [${ms()}] Phase 3 decoding audio buffer...`);
          audioBuffer = await Promise.race([
            ctx.decodeAudioData(arrayBuffer),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('decodeAudioData timed out after 30s')), 30_000)
            ),
          ]);
          tracksStore.updateImportDecodeProgress(trackId, 1.0);
          console.log(`[Audio] [${ms()}] Phase 3 complete: browser decode done (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz)`);
        } catch (e) {
          console.warn(`[Audio] [${ms()}] Phase 3 failed (browser decode):`, e);
        }
      }

      // Check track still exists (may have been deleted during decode)
      const track = tracksStore.tracks.find(t => t.id === trackId);
      if (!track) {
        console.log(`[Audio] [${ms()}] Track deleted during import, discarding`);
        // Clean up waveform session if still pending
        if (!waveformSettled) {
          waveformSessions.delete(sessionId);
        }
        // Clean up cache listeners
        unlistenCacheProgress?.();
        unlistenCacheReady?.();
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

        // Proactively cache compressed formats for smooth Rust mmap playback
        const fmt = metadata.format.toLowerCase();
        const isCompressed = fmt !== 'wav' && fmt !== 'wave' && fmt !== 'rf64';
        if (isCompressed) {
          if (!unlistenCacheReady) {
            unlistenCacheReady = await listen<{ trackId: string; cachedPath: string }>('audio-cache-ready', (event) => {
              if (event.payload.trackId !== trackId) return;
              console.log(`[Audio] [${ms()}] Cache ready for ${trackId}: ${event.payload.cachedPath}`);
              tracksStore.setCachedAudioPath(trackId, event.payload.cachedPath);
              invoke('playback_swap_to_cache', { trackId, cachedPath: event.payload.cachedPath })
                .catch(e => console.warn('[Audio] swap_to_cache:', e));
              unlistenCacheProgress?.();
              unlistenCacheReady?.();
            });
          }
          invoke('prepare_audio_cache', { path, trackId })
            .catch(e => console.error('[Audio] prepare_audio_cache failed:', e));
        }
      } else if (isLargeFile) {
        // Large file: playback through Rust streaming decode — position playhead
        const { usePlaybackStore } = await import('./playback');
        usePlaybackStore().seek(trackStart);
        selectionStore.setSelection(0, tracksStore.timelineDuration);
        console.log(`[Audio] [${ms()}] Large file ready for Rust playback, playhead at ${trackStart.toFixed(1)}s`);
      } else {
        // Browser couldn't decode (e.g. WMA) — use Rust streaming pipeline
        console.warn(`[Audio] [${ms()}] Browser decode failed, using Rust streaming pipeline`);

        // Set up cache listeners if not already done (they were only set up for isLargeFile)
        if (!unlistenCacheProgress) {
          unlistenCacheProgress = await listen<{ trackId: string; progress: number }>('audio-cache-progress', (event) => {
            if (event.payload.trackId !== trackId) return;
            tracksStore.updateImportDecodeProgress(trackId, event.payload.progress);
          });
        }
        if (!unlistenCacheReady) {
          unlistenCacheReady = await listen<{ trackId: string; cachedPath: string }>('audio-cache-ready', (event) => {
            if (event.payload.trackId !== trackId) return;
            console.log(`[Audio] [${ms()}] Cache ready for ${trackId}: ${event.payload.cachedPath}`);
            tracksStore.setCachedAudioPath(trackId, event.payload.cachedPath);
            invoke('playback_swap_to_cache', { trackId, cachedPath: event.payload.cachedPath })
              .catch(e => console.warn('[Audio] swap_to_cache:', e));
            unlistenCacheProgress?.();
            unlistenCacheReady?.();
          });
        }

        tracksStore.setImportLargeFile(trackId);
        tracksStore.setImportCaching(trackId);
        invoke('prepare_audio_cache', { path, trackId })
          .catch(e => console.error('[Audio] prepare_audio_cache failed:', e));

        const { usePlaybackStore } = await import('./playback');
        usePlaybackStore().seek(trackStart);
        selectionStore.setSelection(0, tracksStore.timelineDuration);
      }

      // Wait for waveform to also complete before considering import "done"
      if (!waveformSettled) {
        console.log(`[Audio] [${ms()}] Waiting for waveform to finalize...`);
        await waveformDone;
        console.log(`[Audio] [${ms()}] Waveform settled`);
      }

      // NOW waveform is settled — load cached transcription or defer auto-transcription
      const { useTranscriptionStore } = await import('./transcription');
      const transcriptionStore = useTranscriptionStore();

      // Always try to load cached transcription from disk (free, no CPU cost)
      const loadedFromDisk = await transcriptionStore.loadTranscriptionFromDisk(trackId);
      if (!loadedFromDisk) {
        // Check if auto-transcription is enabled in settings
        const { useSettingsStore } = await import('./settings');
        const settingsStore = useSettingsStore();

        if (!settingsStore.settings.autoTranscribe) {
          console.log(`[Audio] Auto-transcription disabled (use toolbar button)`);
        } else if (metadata.duration >= 900) {
          console.log(`[Audio] Skipping auto-transcription: duration ${metadata.duration.toFixed(0)}s >= 900s (use toolbar button)`);
        } else {
          // Auto-transcribe short files, but only after fully ready (peaks + cache done)
          const currentTrack = tracksStore.tracks.find(t => t.id === trackId);
          const isFullyReady = currentTrack &&
            (currentTrack.importStatus === 'ready' || currentTrack.importStatus === 'large-file') &&
            currentTrack.hasPeakPyramid === true;

          if (isFullyReady) {
            transcriptionStore.queueTranscription(trackId, 'high');
          } else {
            // Defer until track is fully ready (peaks built, audio cached)
            console.log(`[Audio] Deferring auto-transcription until fully ready (importStatus=${currentTrack?.importStatus}, hasPeakPyramid=${currentTrack?.hasPeakPyramid})`);

            const stopWatch = watch(
              () => {
                const t = tracksStore.tracks.find(t => t.id === trackId);
                if (!t) return null; // Track deleted
                return {
                  importStatus: t.importStatus,
                  hasPeakPyramid: t.hasPeakPyramid,
                };
              },
              (val) => {
                if (!val) {
                  console.log(`[Audio] Track ${trackId.slice(0, 8)} deleted, cancelling deferred transcription`);
                  stopWatch();
                  return;
                }
                if ((val.importStatus === 'ready' || val.importStatus === 'large-file') && val.hasPeakPyramid) {
                  console.log(`[Audio] Track ${trackId.slice(0, 8)} fully ready, starting auto-transcription`);
                  stopWatch();
                  transcriptionStore.queueTranscription(trackId, 'high');
                }
              },
            );

            // Safety timeout: stop watching after 2 minutes
            setTimeout(() => {
              stopWatch();
              console.log(`[Audio] Auto-transcription defer timeout for ${trackId.slice(0, 8)}`);
            }, 120_000);
          }
        }
      }

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
