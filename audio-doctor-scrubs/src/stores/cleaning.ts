import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { CleaningOptions, CleanResult, Track } from '@/shared/types';
import { DEFAULT_CLEANING_OPTIONS, CLEANING_PRESETS, WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useVadStore } from './vad';
import { generateId } from '@/shared/utils';

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
    return audioStore.currentFile !== null && tracksStore.selectedTrack !== null;
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
    if (!audioStore.currentFile || !tracksStore.selectedTrack) {
      error.value = 'No track selected';
      return null;
    }

    const sourceTrack = tracksStore.selectedTrack;
    loading.value = true;
    error.value = null;

    try {
      // Get temp path for output
      const outputPath = await invoke<string>('get_temp_audio_path');

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

      // Call backend to clean audio
      const result = await invoke<CleanResult>('clean_audio', {
        sourcePath: audioStore.currentFile.path,
        outputPath,
        startTime: sourceTrack.start,
        endTime: sourceTrack.end,
        options: backendOptions,
        silenceSegments: silenceSegments.length > 0 ? silenceSegments : null,
      });

      lastResult.value = result;

      // Load the cleaned audio file into a buffer
      const cleanedAudioEntry = await loadCleanedAudio(result.outputPath);

      // Create a new track for the cleaned audio
      const cleanedTrack = createCleanedTrack(sourceTrack, result, cleanedAudioEntry);

      // Store the cleaned audio data mapped to the new track's ID
      cleanedAudioFiles.value.set(cleanedTrack.id, cleanedAudioEntry);

      // MUTE the source track (non-destructive)
      tracksStore.setTrackMuted(sourceTrack.id, true);

      console.log('Audio cleaned successfully:', result);
      return cleanedTrack;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to clean audio';
      console.error('Cleaning error:', e);
      return null;
    } finally {
      loading.value = false;
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

  function createCleanedTrack(
    sourceTrack: Track,
    result: CleanResult,
    cleanedAudio: CleanedAudioEntry
  ): Track {
    // Generate cleaned track name
    const cleanedName = `Cleaned ${sourceTrack.name}`;

    const cleanedTrack: Track = {
      id: generateId(),
      name: cleanedName,
      audioId: sourceTrack.audioId, // Reference same base audio for timeline positioning
      type: 'clip',
      start: sourceTrack.start,
      end: sourceTrack.end,
      trackStart: sourceTrack.trackStart,
      muted: false,
      solo: false,
      volume: 1,
    };

    // Add to tracks store
    tracksStore.addTrack(cleanedTrack);

    // Select the new cleaned track
    tracksStore.selectedTrackId = cleanedTrack.id;

    return cleanedTrack;
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
    if (!audioStore.currentFile) {
      throw new Error('No audio file loaded');
    }

    const freq = await invoke<number>('detect_mains_freq', {
      sourcePath: audioStore.currentFile.path,
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
