import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { VadResult, VadOptions, SpeechSegment } from '@/shared/types';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';

export const useVadStore = defineStore('vad', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();

  const result = ref<VadResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const speechTracksCreated = ref(false);

  const options = ref<VadOptions>({
    energyThreshold: 0.15,
    minSegmentDuration: 0.1,
    frameSizeMs: 30,
    padding: 0.15,
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
    if (!audioStore.currentFile) {
      error.value = 'No audio file loaded';
      return;
    }

    loading.value = true;
    error.value = null;

    try {
      const vadResult = await invoke<VadResult>('detect_speech_segments', {
        path: audioStore.currentFile.path,
        options: options.value,
      });

      result.value = vadResult;
      speechTracksCreated.value = false;
      console.log('VAD result:', vadResult);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to detect silence';
      console.error('VAD error:', e);
    } finally {
      loading.value = false;
    }
  }

  function createSpeechTracks(): void {
    if (!result.value || speechSegments.value.length === 0) {
      error.value = 'No speech segments detected';
      return;
    }

    // Remove any existing speech tracks first
    if (speechTracksCreated.value) {
      tracksStore.deleteSpeechSegmentTracks();
    }

    // Create tracks for each speech segment
    const segments = speechSegments.value.map((seg) => ({
      start: seg.start,
      end: seg.end,
    }));

    tracksStore.createSpeechSegmentTracks(segments);
    speechTracksCreated.value = true;

    console.log(`Created ${segments.length} speech segment tracks`);
  }

  function removeSpeechTracks(): void {
    tracksStore.deleteSpeechSegmentTracks();
    speechTracksCreated.value = false;
  }

  function setOptions(newOptions: Partial<VadOptions>): void {
    options.value = { ...options.value, ...newOptions };
  }

  function clear(): void {
    if (speechTracksCreated.value) {
      tracksStore.deleteSpeechSegmentTracks();
    }
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
    detectSilence,
    createSpeechTracks,
    removeSpeechTracks,
    setOptions,
    clear,
  };
});
