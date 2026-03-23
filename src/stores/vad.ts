import { defineStore } from 'pinia';
import { ref, shallowRef, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { VadResult, VadOptions } from '@/shared/types';
import { useTracksStore } from './tracks';
import { renderTrackToTempWav } from '@/services/track-render';

export type VadPresetName = 'gentle' | 'moderate' | 'aggressive';

export interface VadPreset {
  name: VadPresetName;
  label: string;
  description: string;
  options: VadOptions;
}

export const VAD_PRESETS: VadPreset[] = [
  {
    name: 'gentle',
    label: 'Gentle',
    description: 'Podcast / studio — keeps more audio',
    options: {
      energyThreshold: 0.08,
      minSegmentDuration: 0.1,
      frameSizeMs: 30,
      padding: 0.2,
      minSilenceDuration: 0.5,
    },
  },
  {
    name: 'moderate',
    label: 'Moderate',
    description: 'Balanced — good for most audio',
    options: {
      energyThreshold: 0.15,
      minSegmentDuration: 0.1,
      frameSizeMs: 30,
      padding: 0.15,
      minSilenceDuration: 0.3,
    },
  },
  {
    name: 'aggressive',
    label: 'Aggressive',
    description: 'Noisy audio — removes more silence',
    options: {
      energyThreshold: 0.25,
      minSegmentDuration: 0.1,
      frameSizeMs: 30,
      padding: 0.1,
      minSilenceDuration: 0.2,
    },
  },
];

export const useVadStore = defineStore('vad', () => {
  const tracksStore = useTracksStore();

  const result = shallowRef<VadResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const speechTracksCreated = ref(false);
  const activePreset = ref<VadPresetName>('moderate');

  const options = ref<VadOptions>({
    energyThreshold: 0.15,
    minSegmentDuration: 0.1,
    frameSizeMs: 30,
    padding: 0.15,
    minSilenceDuration: 0.3,
  });

  const hasResult = computed(() => result.value !== null);
  const speechSegments = computed(() => result.value?.speechSegments ?? []);
  const silenceSegments = computed(() => result.value?.silenceSegments ?? []);
  const totalSpeechDuration = computed(() => result.value?.totalSpeechDuration ?? 0);
  const totalSilenceDuration = computed(() => result.value?.totalSilenceDuration ?? 0);

  const silencePercentage = computed(() => {
    if (!result.value) return 0;
    const total = result.value.totalSpeechDuration + result.value.totalSilenceDuration;
    if (total <= 0) return 0;
    return (result.value.totalSilenceDuration / total) * 100;
  });


  async function detectSilence(): Promise<void> {
    const selectedTrack = tracksStore.selectedTrack;
    const trackId = selectedTrack?.id;

    if (!trackId) {
      error.value = 'Select a track to detect silence';
      return;
    }
    console.log(`[VAD] Selected track: id=${trackId}, name="${selectedTrack?.name}", duration=${selectedTrack?.duration?.toFixed(2)}s`);

    loading.value = true;
    error.value = null;

    try {
      // Render track content to temp WAV (handles both buffered and EDL tracks)
      const { path: tempPath } = await renderTrackToTempWav(trackId);
      console.log('[VAD] Detecting from rendered track content, temp file:', tempPath);

      const vadResult = await invoke<VadResult>('detect_speech_segments', {
        path: tempPath,
        options: options.value,
      });

      result.value = vadResult;
      speechTracksCreated.value = false;
      console.log(`[VAD] Result: ${vadResult.segments?.length ?? 0} segments, ${vadResult.speechSegments?.length ?? 0} speech, ${vadResult.silenceSegments?.length ?? 0} silence, speech: ${vadResult.totalSpeechDuration?.toFixed(1)}s, silence: ${vadResult.totalSilenceDuration?.toFixed(1)}s`);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to detect silence';
      console.error('VAD error:', e);
    } finally {
      loading.value = false;
    }
  }

  function createSpeechTracks(): void {
    // Speech segments are now visualized via silence overlays, not separate tracks.
    if (!result.value || speechSegments.value.length === 0) {
      error.value = 'No speech segments detected';
      return;
    }
    speechTracksCreated.value = true;
    console.log(`[VAD] createSpeechTracks: ${speechSegments.value.length} segments (visualized via overlays)`);
  }

  function removeSpeechTracks(): void {
    speechTracksCreated.value = false;
  }

  function setOptions(newOptions: Partial<VadOptions>): void {
    options.value = { ...options.value, ...newOptions };
    // If manually adjusting options, mark preset as no longer matching
    const match = VAD_PRESETS.find(p =>
      p.options.energyThreshold === options.value.energyThreshold &&
      p.options.padding === options.value.padding &&
      p.options.minSilenceDuration === options.value.minSilenceDuration &&
      p.options.frameSizeMs === options.value.frameSizeMs
    );
    activePreset.value = match?.name ?? 'moderate';
  }

  function setPreset(presetName: VadPresetName): void {
    const preset = VAD_PRESETS.find(p => p.name === presetName);
    if (preset) {
      activePreset.value = presetName;
      options.value = { ...preset.options };
    }
  }

  function clear(): void {
    result.value = null;
    error.value = null;
    speechTracksCreated.value = false;
  }

  return {
    result,
    loading,
    error,
    options,
    hasResult,
    speechSegments,
    silenceSegments,
    totalSpeechDuration,
    totalSilenceDuration,
    silencePercentage,
    speechTracksCreated,
    activePreset,
    detectSilence,
    createSpeechTracks,
    removeSpeechTracks,
    setOptions,
    setPreset,
    clear,
  };
});
