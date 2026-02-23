import { defineStore } from 'pinia';
import { ref, shallowRef, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import type { VadResult, VadOptions } from '@/shared/types';
import { encodeWav, mixTrackClipsToBuffer } from '@/shared/audio-utils';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';

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
  const audioStore = useAudioStore();
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

  // Mix track clips into a single buffer
  function mixClipsForTrack(trackId: string): AudioBuffer | null {
    const clips = tracksStore.getTrackClips(trackId);
    return mixTrackClipsToBuffer(clips, audioStore.getAudioContext());
  }

  async function detectSilence(): Promise<void> {
    const selectedTrack = tracksStore.selectedTrack;
    const trackId = selectedTrack?.id || tracksStore.tracks[0]?.id;

    if (!trackId) {
      error.value = 'No audio file loaded. Select a track.';
      return;
    }
    console.log('[VAD] Detecting silence for track:', selectedTrack?.name);

    loading.value = true;
    error.value = null;

    try {
      // Get current buffer state (clips mixed together)
      const mixedBuffer = mixClipsForTrack(trackId);
      if (!mixedBuffer) {
        error.value = 'No audio clips to analyze';
        return;
      }

      // Encode to WAV and write to temp file
      const wavData = encodeWav(mixedBuffer);
      const tempFileName = `vad_buffer_${Date.now()}.wav`;
      await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
      const tempDirPath = await tempDir();
      const tempPath = `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${tempFileName}`;

      console.log('[VAD] Detecting from current buffer state, temp file:', tempPath);

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
    activePreset,
    detectSilence,
    createSpeechTracks,
    removeSpeechTracks,
    setOptions,
    setPreset,
    clear,
  };
});
