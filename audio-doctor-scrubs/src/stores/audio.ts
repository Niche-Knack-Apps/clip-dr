import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { AudioFile, AudioMetadata } from '@/shared/types';
import { generateId } from '@/shared/utils';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useTranscriptionStore } from './transcription';
import { useCleaningStore } from './cleaning';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';

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

      console.log('Loading audio metadata...');
      const metadata = await invoke<AudioMetadata>('get_audio_metadata', { path });
      console.log('Metadata:', metadata);

      if (!metadata.sampleRate || !metadata.channels || metadata.sampleRate <= 0 || metadata.channels <= 0) {
        throw new Error('Invalid audio metadata');
      }

      console.log('Extracting waveform...');
      const waveformData = await invoke<number[]>('extract_waveform', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });
      console.log('Waveform buckets:', waveformData.length);

      console.log('Loading audio buffer...');
      const audioData = await invoke<number[]>('load_audio_buffer', { path });
      console.log('Audio samples:', audioData.length);

      if (audioData.length === 0) {
        throw new Error('No audio data loaded');
      }

      const float32Data = new Float32Array(audioData);
      const samplesPerChannel = Math.floor(float32Data.length / metadata.channels);

      if (samplesPerChannel <= 0) {
        throw new Error('Invalid audio buffer size');
      }

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

      audioBuffer.value = buffer;

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

      console.log('Audio loaded successfully');

      // Initialize tracks and selection
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
    const tracksStore = useTracksStore();
    const cleaningStore = useCleaningStore();
    tracksStore.clearTracks();
    cleaningStore.clearCleanedAudio();
  }

  function getAudioBuffer(): AudioBuffer | null {
    return audioBuffer.value;
  }

  function getAudioContext(): AudioContext {
    return initAudioContext();
  }

  async function autoTranscribe(): Promise<void> {
    const transcriptionStore = useTranscriptionStore();

    // Check if model exists first
    const hasModel = await transcriptionStore.checkModel();
    if (!hasModel) {
      // Model not found, skip silently - WordTimeline will show message
      console.log('Whisper model not found, skipping auto-transcription');
      return;
    }

    // Fire-and-forget transcription (non-blocking)
    transcriptionStore.transcribeAudio().catch((e) => {
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
