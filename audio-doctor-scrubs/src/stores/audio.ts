import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { AudioFile, AudioLoadResult } from '@/shared/types';
import { generateId } from '@/shared/utils';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';

export const useAudioStore = defineStore('audio', () => {
  const currentFile = ref<AudioFile | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const audioBuffer = ref<AudioBuffer | null>(null);
  const audioContext = ref<AudioContext | null>(null);

  const hasFile = computed(() => currentFile.value !== null);
  const duration = computed(() => currentFile.value?.duration ?? 0);
  const fileName = computed(() => currentFile.value?.name ?? '');

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

  async function loadFile(path: string): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
      const ctx = initAudioContext();

      // Single-pass loading: decode once, get metadata + waveform + samples together
      // This is 3x faster than separate calls for long files
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

      // Copy pre-deinterleaved channel data directly (much faster than JS deinterleaving)
      for (let channel = 0; channel < metadata.channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        const sourceData = channels[channel];

        // Validate source data
        if (!sourceData || sourceData.length === 0) {
          console.error('[Audio] Channel', channel, 'has no data!');
          continue;
        }

        // Convert to Float32Array if needed (Rust sends number[])
        const float32Data = sourceData instanceof Float32Array
          ? sourceData
          : new Float32Array(sourceData);

        // Use set() for fast typed array copy
        channelData.set(float32Data);

        // Verify data was copied correctly
        let maxSample = 0;
        for (let i = 0; i < Math.min(1000, channelData.length); i++) {
          maxSample = Math.max(maxSample, Math.abs(channelData[i]));
        }
        console.log('[Audio] Channel', channel, 'max amplitude (first 1000):', maxSample, 'length:', channelData.length);
      }

      audioBuffer.value = buffer;
      console.log('[Audio] Buffer created, duration:', buffer.duration, 'channels:', buffer.numberOfChannels, 'sampleRate:', buffer.sampleRate);

      currentFile.value = {
        id: generateId(),
        path,
        name: path.split(/[/\\]/).pop() || path,
        duration: metadata.duration,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        waveformData,
        loadedAt: Date.now(),
      };

      console.log('Audio ready for playback');

      // Initialize tracks and selection
      const { useTracksStore } = await import('./tracks');
      const { useSelectionStore } = await import('./selection');
      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();
      tracksStore.initMainTrack();
      selectionStore.resetSelection();

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

  function unloadFile(): void {
    currentFile.value = null;
    audioBuffer.value = null;
    error.value = null;
    // Clear tracks and cleaned audio when unloading
    import('./tracks').then(({ useTracksStore }) => {
      useTracksStore().clearTracks();
    });
    import('./cleaning').then(({ useCleaningStore }) => {
      useCleaningStore().clearCleanedAudio();
    });
  }

  function getAudioBuffer(): AudioBuffer | null {
    return audioBuffer.value;
  }

  function getAudioContext(): AudioContext {
    return initAudioContext();
  }

  async function autoTranscribe(): Promise<void> {
    const { useTranscriptionStore } = await import('./transcription');
    const transcriptionStore = useTranscriptionStore();

    // Check if model exists first
    const hasModel = await transcriptionStore.checkModel();
    if (!hasModel) {
      // Model not found, skip silently - WordTimeline will show message
      console.log('Whisper model not found, skipping auto-transcription');
      return;
    }

    // Fire-and-forget transcription (non-blocking)
    transcriptionStore.transcribeAudio().catch((e: Error) => {
      console.error('Auto-transcription failed:', e);
    });
  }

  return {
    currentFile,
    loading,
    error,
    hasFile,
    duration,
    fileName,
    loadFile,
    unloadFile,
    getAudioBuffer,
    getAudioContext,
    resumeAudioContext,
  };
});
