import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { AudioLoadResult } from '@/shared/types';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { getFileName } from '@/shared/utils';
import { useTracksStore } from './tracks';

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

  // Import a file and create a track from it
  async function importFile(path: string): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
      const ctx = initAudioContext();

      console.log('Loading audio (single-pass)...');
      const startTime = performance.now();

      const result = await invoke<AudioLoadResult>('load_audio_complete', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });

      const loadTime = performance.now() - startTime;
      console.log(`Audio loaded in ${(loadTime / 1000).toFixed(2)}s`);
      console.log('Metadata:', result.metadata);
      console.log('Waveform buckets:', result.waveform.length);
      console.log('Channels:', result.channels.length, 'x', result.channels[0]?.length ?? 0, 'samples');

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

      // Copy pre-deinterleaved channel data directly
      for (let channel = 0; channel < metadata.channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        const sourceData = channels[channel];

        if (!sourceData || sourceData.length === 0) {
          console.error('[Audio] Channel', channel, 'has no data!');
          continue;
        }

        const float32Data = sourceData instanceof Float32Array
          ? sourceData
          : new Float32Array(sourceData);

        channelData.set(float32Data);
      }

      console.log('[Audio] Buffer created, duration:', buffer.duration, 'channels:', buffer.numberOfChannels, 'sampleRate:', buffer.sampleRate);

      lastImportedPath.value = path;

      // Create a track from the imported audio
      const tracksStore = useTracksStore();
      const { useSelectionStore } = await import('./selection');
      const selectionStore = useSelectionStore();

      const fileName = getFileName(path);
      tracksStore.createTrackFromBuffer(buffer, waveformData, fileName, 0, path);

      selectionStore.resetSelection();

      console.log('Audio ready for playback');

      // Auto-trigger transcription in background (fire-and-forget)
      autoTranscribe();
    } catch (e) {
      console.error('Load error:', e);
      error.value = e instanceof Error ? e.message : 'Failed to load audio file';
      throw e;
    } finally {
      loading.value = false;
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

  async function autoTranscribe(): Promise<void> {
    const { useTranscriptionStore } = await import('./transcription');
    const transcriptionStore = useTranscriptionStore();

    const hasModel = await transcriptionStore.checkModel();
    if (!hasModel) {
      console.log('Whisper model not found, skipping auto-transcription');
      return;
    }

    transcriptionStore.transcribeAudio().catch((e: Error) => {
      console.error('Auto-transcription failed:', e);
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
