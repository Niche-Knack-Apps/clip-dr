import { computed } from 'vue';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useTracksStore } from '@/stores/tracks';
import { useTranscriptionStore } from '@/stores/transcription';

export function useAudio() {
  const audioStore = useAudioStore();
  const playbackStore = usePlaybackStore();
  const selectionStore = useSelectionStore();
  const tracksStore = useTracksStore();
  const transcriptionStore = useTranscriptionStore();

  const hasFile = computed(() => audioStore.hasFile);
  const isPlaying = computed(() => playbackStore.isPlaying);
  const currentTime = computed(() => playbackStore.currentTime);
  const duration = computed(() => audioStore.duration);
  const fileName = computed(() => audioStore.fileName);
  const loading = computed(() => audioStore.loading);

  async function loadFile(path: string): Promise<void> {
    await audioStore.loadFile(path);
    selectionStore.resetSelection();
    tracksStore.initMainTrack();
    transcriptionStore.clearTranscription();

    // Start transcription in background (non-blocking)
    transcriptionStore.transcribeAudio().catch((e) => {
      console.warn('Background transcription failed:', e);
    });
  }

  function unloadFile(): void {
    playbackStore.stop();
    audioStore.unloadFile();
    selectionStore.resetSelection();
    tracksStore.clearTracks();
    transcriptionStore.clearTranscription();
  }

  async function play(): Promise<void> {
    await playbackStore.play();
  }

  function pause(): void {
    playbackStore.pause();
  }

  async function togglePlay(): Promise<void> {
    await playbackStore.togglePlay();
  }

  async function seek(time: number): Promise<void> {
    await playbackStore.seek(time);
  }

  function setVolume(volume: number): void {
    playbackStore.setVolume(volume);
  }

  return {
    hasFile,
    isPlaying,
    currentTime,
    duration,
    fileName,
    loading,
    loadFile,
    unloadFile,
    play,
    pause,
    togglePlay,
    seek,
    setVolume,
  };
}
