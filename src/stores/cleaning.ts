import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import type { CleaningOptions, CleanResult, Track } from '@/shared/types';
import { encodeWav, mixTrackClipsToBuffer } from '@/shared/audio-utils';
import { DEFAULT_CLEANING_OPTIONS, CLEANING_PRESETS, WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useVadStore } from './vad';
import { useHistoryStore } from './history';

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
    return tracksStore.hasAudio && tracksStore.selectedTrack !== null;
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

  // Mix track clips into a single buffer
  function mixClipsForTrack(trackId: string): AudioBuffer | null {
    const clips = tracksStore.getTrackClips(trackId);
    return mixTrackClipsToBuffer(clips, audioStore.getAudioContext());
  }

  async function cleanSelectedTrack(): Promise<Track | null> {
    if (!tracksStore.hasAudio || !tracksStore.selectedTrack) {
      error.value = 'No track selected';
      return null;
    }

    const historyStore = useHistoryStore();
    historyStore.beginBatch('Clean track');

    const sourceTrack = tracksStore.selectedTrack;

    loading.value = true;
    error.value = null;

    try {
      console.log('[Clean] Starting clean for track:', sourceTrack.name);

      let sourcePath: string;
      let cleanDuration: number;

      // For tracks with sourcePath but no AudioBuffer (large files),
      // pass sourcePath directly to Rust — no need to encode to temp WAV
      if (sourceTrack.sourcePath && !sourceTrack.audioData.buffer) {
        sourcePath = sourceTrack.sourcePath;
        cleanDuration = sourceTrack.duration;
        console.log('[Clean] Using source path directly (large file):', sourcePath);
      } else {
        // Get current buffer state (clips mixed together)
        const mixedBuffer = mixClipsForTrack(sourceTrack.id);
        if (!mixedBuffer) {
          error.value = 'Cannot clean: no audio clips available';
          loading.value = false;
          return null;
        }

        // Encode to WAV and write to temp file
        const wavData = encodeWav(mixedBuffer);
        const sourceFileName = `clean_source_${Date.now()}.wav`;
        await writeFile(sourceFileName, wavData, { baseDir: BaseDirectory.Temp });
        const tempDirPath = await tempDir();
        sourcePath = `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${sourceFileName}`;
        cleanDuration = mixedBuffer.duration;

        console.log('[Clean] Using current buffer state, temp file:', sourcePath);
      }

      // Get temp path for output
      const outputPath = await invoke<string>('get_temp_audio_path');
      console.log('[Clean] Temp output path:', outputPath);

      // Collect silence segments from VAD if available
      const silenceSegments = vadStore.silenceSegments.map((seg) => ({
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
      };

      console.log('[Clean] Calling backend clean_audio...');
      const result = await invoke<CleanResult>('clean_audio', {
        sourcePath,
        outputPath,
        startTime: 0,
        endTime: cleanDuration,
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
      // Create a new track for the cleaned audio
      const cleanedName = `Cleaned ${sourceTrack.name}`;
      const cleanedTrack = tracksStore.createTrackFromBuffer(
        cleanedAudioEntry.buffer,
        cleanedAudioEntry.waveformData,
        cleanedName,
        0
      );
      console.log('[Clean] Created track:', cleanedTrack.id, cleanedTrack.name);

      // Store the cleaned audio data mapped to the new track's ID
      // Create a new Map to trigger Vue reactivity
      const newMap = new Map(cleanedAudioFiles.value);
      newMap.set(cleanedTrack.id, cleanedAudioEntry);
      cleanedAudioFiles.value = newMap;
      console.log('[Clean] Mapped cleaned audio to track ID:', cleanedTrack.id);

      // MUTE the source track (non-destructive)
      console.log('[Clean] Muting source track:', sourceTrack.id, sourceTrack.name);
      tracksStore.setTrackMuted(sourceTrack.id, true);
      console.log('[Clean] Source track muted state:', tracksStore.tracks.find(t => t.id === sourceTrack.id)?.muted);

      console.log('[Clean] Audio cleaned successfully, new track added');
      console.log('[Clean] Total tracks now:', tracksStore.tracks.length);
      console.log('[Clean] All track names:', tracksStore.tracks.map(t => t.name).join(', '));
      return cleanedTrack;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      error.value = errorMsg;
      console.error('[Clean] Cleaning error:', e);
      return null;
    } finally {
      loading.value = false;
      historyStore.endBatch();
    }
  }

  async function loadCleanedAudio(path: string): Promise<CleanedAudioEntry> {
    const ctx = audioStore.getAudioContext();

    // Load audio metadata
    const metadata = await invoke<{ duration: number; sampleRate: number; channels: number }>(
      'get_audio_metadata',
      { path }
    );

    // Load waveform data
    const waveformData = await invoke<number[]>('extract_waveform', {
      path,
      bucketCount: WAVEFORM_BUCKET_COUNT,
    });

    // Load audio buffer
    const audioData = await invoke<number[]>('load_audio_buffer', { path });

    const float32Data = new Float32Array(audioData);
    const samplesPerChannel = Math.floor(float32Data.length / metadata.channels);

    const buffer = ctx.createBuffer(
      metadata.channels,
      samplesPerChannel,
      metadata.sampleRate
    );

    for (let channel = 0; channel < metadata.channels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = float32Data[i * metadata.channels + channel];
      }
    }

    return {
      path,
      buffer,
      waveformData,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
    };
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
