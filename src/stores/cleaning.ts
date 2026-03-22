import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeTempFile } from '@/shared/fs-utils';
import type { CleaningOptions, CleanResult, Track } from '@/shared/types';
import { loadAudioFromFile } from '@/shared/audio-utils';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { DEFAULT_CLEANING_OPTIONS, CLEANING_PRESETS, WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useVadStore } from './vad';
import { useHistoryStore } from './history';
import { usePlaybackStore } from './playback';
import { useUIStore } from './ui';
import { renderTrackToTempWav } from '@/services/track-render';

interface CleanedAudioEntry {
  path: string;
  buffer: AudioBuffer;
  waveformData: number[];
  duration: number;
  sampleRate: number;
}

export const useCleaningStore = defineStore('cleaning', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const vadStore = useVadStore();

  const options = ref<CleaningOptions>({ ...DEFAULT_CLEANING_OPTIONS });
  const selectedPreset = ref<string | null>('podcast');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastResult = ref<CleanResult | null>(null);

  // Map of trackId -> cleaned audio data
  const cleanedAudioFiles = ref<Map<string, CleanedAudioEntry>>(new Map());

  const presets = computed(() => CLEANING_PRESETS);

  const canClean = computed(() => {
    return tracksStore.hasAudio && (tracksStore.selectedTrack !== null || tracksStore.selectedClip !== null);
  });

  function setOptions(newOptions: Partial<CleaningOptions>): void {
    options.value = { ...options.value, ...newOptions };
    // Clear preset selection when options are manually changed
    selectedPreset.value = null;
  }

  function applyPreset(presetId: string): void {
    const preset = CLEANING_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      options.value = { ...DEFAULT_CLEANING_OPTIONS, ...preset.options };
      selectedPreset.value = presetId;
    }
  }

  function resetToDefaults(): void {
    options.value = { ...DEFAULT_CLEANING_OPTIONS };
    selectedPreset.value = 'podcast';
  }


  async function cleanSelectedTrack(): Promise<Track | null> {
    // Check for selected clip first (clip-level cleaning)
    const selectedClipInfo = tracksStore.selectedClip;

    if (!tracksStore.hasAudio || (!tracksStore.selectedTrack && !selectedClipInfo)) {
      error.value = 'No track selected';
      return null;
    }
    if (loading.value) {
      useUIStore().showToast('Cleaning already in progress.', 'warn');
      return null;
    }

    const historyStore = useHistoryStore();
    historyStore.beginBatch('Clean track');

    const sourceTrack = selectedClipInfo
      ? tracksStore.getTrackById(selectedClipInfo.trackId)!
      : tracksStore.selectedTrack!;
    const cleaningClip = selectedClipInfo?.clip ?? null;

    loading.value = true;
    error.value = null;

    try {
      console.log('[Clean] Starting clean for', cleaningClip ? `clip in track: ${sourceTrack.name}` : `track: ${sourceTrack.name}`);

      let sourcePath: string;
      let cleanDuration: number;
      let cleanStartTime = 0;

      if (cleaningClip) {
        // Clip-level cleaning
        if (cleaningClip.sourceFile) {
          sourcePath = cleaningClip.sourceFile;
          cleanStartTime = cleaningClip.sourceOffset ?? 0;
          cleanDuration = cleaningClip.duration;
          console.log('[Clean] Using clip sourceFile:', sourcePath, 'offset:', cleanStartTime);
        } else if (cleaningClip.buffer) {
          const wavData = await encodeWavFloat32InWorker(cleaningClip.buffer);
          sourcePath = await writeTempFile(`clean_clip_${Date.now()}.wav`, wavData);
          cleanDuration = cleaningClip.duration;
          console.log('[Clean] Using clip buffer, temp file:', sourcePath);
        } else {
          error.value = 'Cannot clean: clip has no audio data';
          loading.value = false;
          return null;
        }
      } else if (sourceTrack.sourcePath && !sourceTrack.audioData.buffer) {
        // For tracks with sourcePath but no AudioBuffer (large files),
        // pass sourcePath directly to Rust — no need to encode to temp WAV
        sourcePath = sourceTrack.sourcePath;
        cleanDuration = sourceTrack.duration;
        console.log('[Clean] Using source path directly (large file):', sourcePath);
      } else {
        // Render track's arranged content (respects clips, not full source).
        // Uses the same renderTrackToTempWav pipeline as transcription —
        // handles both in-memory buffers and EDL/large-file tracks.
        try {
          const { path } = await renderTrackToTempWav(sourceTrack.id);
          sourcePath = path;
          cleanDuration = sourceTrack.duration;
          console.log('[Clean] Rendered track to temp WAV:', sourcePath);
        } catch (renderErr) {
          const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
          error.value = `Cannot render track for cleaning: ${msg}`;
          console.log('[Clean] Render failed for track:', sourceTrack.name, renderErr);
          useUIStore().showToast('Cannot clean: failed to render track audio', 'error');
          loading.value = false;
          return null;
        }
      }

      // Get temp path for output
      const outputPath = await invoke<string>('get_temp_audio_path');
      console.log('[Clean] Temp output path:', outputPath);

      // Collect silence segments from VAD if available (only for whole-track cleaning)
      const silenceSegments = cleaningClip ? [] : vadStore.silenceSegments.map((seg) => ({
        start: seg.start,
        end: seg.end,
      }));

      // Convert options to backend format
      const backendOptions = {
        highpassEnabled: options.value.highpassEnabled,
        highpassFreq: options.value.highpassFreq,
        lowpassEnabled: options.value.lowpassEnabled,
        lowpassFreq: options.value.lowpassFreq,
        notchEnabled: options.value.notchEnabled,
        mainsFrequency: options.value.mainsFrequency,
        notchHarmonics: options.value.notchHarmonics,
        spectralEnabled: options.value.spectralEnabled,
        noiseReductionDb: options.value.noiseReductionDb,
        neuralEnabled: options.value.neuralEnabled,
        neuralStrength: options.value.neuralStrength,
        expanderEnabled: options.value.expanderEnabled,
        expanderThresholdDb: options.value.expanderThresholdDb,
        expanderRatio: options.value.expanderRatio,
        dynamicsEnabled: options.value.dynamicsEnabled,
        dynamicsThresholdDb: options.value.dynamicsThresholdDb,
        dynamicsRatio: options.value.dynamicsRatio,
      };

      console.log('[Clean] Calling backend clean_audio...');
      const result = await invoke<CleanResult>('clean_audio', {
        sourcePath,
        outputPath,
        startTime: cleanStartTime,
        endTime: cleanStartTime + cleanDuration,
        options: backendOptions,
        silenceSegments: silenceSegments.length > 0 ? silenceSegments : null,
      });
      console.log(`[Clean] Backend result: duration=${result.duration?.toFixed(2)}s, path=${result.outputPath}`);

      lastResult.value = result;

      console.log('[Clean] Loading cleaned audio buffer...');
      // Load the cleaned audio file into a buffer
      const cleanedAudioEntry = await loadCleanedAudio(result.outputPath);
      console.log('[Clean] Loaded cleaned audio, duration:', cleanedAudioEntry.duration);

      console.log('[Clean] Creating new track...');
      // Create a new track for the cleaned audio, with sourcePath so Rust playback works
      const cleanedName = cleaningClip ? `Cleaned Clip` : `Cleaned ${sourceTrack.name}`;
      const trackStart = cleaningClip ? cleaningClip.clipStart : sourceTrack.trackStart;
      const cleanedTrack = await tracksStore.createTrackFromBuffer(
        cleanedAudioEntry.buffer,
        cleanedAudioEntry.waveformData,
        cleanedName,
        trackStart,
        result.outputPath
      );
      console.log('[Clean] Created track:', cleanedTrack.id, cleanedTrack.name);

      // Store the cleaned audio data mapped to the new track's ID
      // Create a new Map to trigger Vue reactivity
      const newMap = new Map(cleanedAudioFiles.value);
      newMap.set(cleanedTrack.id, cleanedAudioEntry);
      cleanedAudioFiles.value = newMap;
      console.log('[Clean] Mapped cleaned audio to track ID:', cleanedTrack.id);

      // Solo the cleaned track so only it plays (auto-mutes others;
      // un-soloing later restores user-muted state via autoMuted flag)
      console.log('[Clean] Soloing cleaned track:', cleanedTrack.id);
      tracksStore.setTrackSolo(cleanedTrack.id, true);

      // Reposition playhead to start of cleaned track
      const playbackStore = usePlaybackStore();
      await playbackStore.seek(Math.max(0, cleanedTrack.trackStart));

      console.log('[Clean] Audio cleaned successfully, new track added');
      console.log('[Clean] Total tracks now:', tracksStore.tracks.length);
      console.log('[Clean] All track names:', tracksStore.tracks.map(t => t.name).join(', '));
      return cleanedTrack;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      error.value = errorMsg;
      console.log('[Clean] Cleaning error:', errorMsg);
      useUIStore().showToast(`Cleaning failed: ${errorMsg}`, 'error');
      return null;
    } finally {
      loading.value = false;
      historyStore.endBatch();
    }
  }

  // DUP-02: use shared loadAudioFromFile utility
  async function loadCleanedAudio(path: string): Promise<CleanedAudioEntry> {
    const ctx = audioStore.getAudioContext();
    return loadAudioFromFile(path, ctx);
  }

  // Get the audio buffer for a track (returns cleaned buffer if available)
  function getBufferForTrack(trackId: string): AudioBuffer | null {
    const cleanedEntry = cleanedAudioFiles.value.get(trackId);
    if (cleanedEntry) {
      return cleanedEntry.buffer;
    }
    return null;
  }

  // Get waveform data for a track (returns cleaned waveform if available)
  function getWaveformForTrack(trackId: string): number[] | null {
    const cleanedEntry = cleanedAudioFiles.value.get(trackId);
    if (cleanedEntry) {
      return cleanedEntry.waveformData;
    }
    return null;
  }

  // Check if a track has cleaned audio
  function hasCleanedAudio(trackId: string): boolean {
    return cleanedAudioFiles.value.has(trackId);
  }

  async function detectMainsFrequency(): Promise<number> {
    const sourcePath = audioStore.lastImportedPath;
    if (!sourcePath) {
      throw new Error('No audio file loaded');
    }

    const freq = await invoke<number>('detect_mains_freq', {
      sourcePath,
    });

    return freq;
  }

  function clear(): void {
    error.value = null;
    lastResult.value = null;
  }

  // Clear all cleaned audio data (e.g., when loading a new file)
  function clearCleanedAudio(): void {
    cleanedAudioFiles.value.clear();
  }

  return {
    options,
    selectedPreset,
    loading,
    error,
    lastResult,
    presets,
    canClean,
    cleanedAudioFiles,
    setOptions,
    applyPreset,
    resetToDefaults,
    cleanSelectedTrack,
    detectMainsFrequency,
    getBufferForTrack,
    getWaveformForTrack,
    hasCleanedAudio,
    clear,
    clearCleanedAudio,
  };
});
