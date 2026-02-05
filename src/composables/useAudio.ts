import { computed } from 'vue';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useTracksStore } from '@/stores/tracks';

export function useAudio() {
  const audioStore = useAudioStore();
  const playbackStore = usePlaybackStore();
  const selectionStore = useSelectionStore();
  const tracksStore = useTracksStore();

  // Use tracks store to determine if we have audio
  const hasFile = computed(() => tracksStore.hasAudio);
  const isPlaying = computed(() => playbackStore.isPlaying);
  const currentTime = computed(() => playbackStore.currentTime);
  const duration = computed(() => tracksStore.timelineDuration);
  // Get fileName from first track if available
  const fileName = computed(() => {
    if (tracksStore.tracks.length > 0) {
      return tracksStore.tracks[0].name;
    }
    return '';
  });
  const loading = computed(() => audioStore.loading);

  async function loadFile(path: string): Promise<void> {
    // Use the new importFile method which creates a track
    await audioStore.importFile(path);
    selectionStore.resetSelection();
    // Transcription is now triggered per-track by EditorView's selectedTrackId watcher
  }

  function unloadFile(): void {
    playbackStore.stop();
    audioStore.unloadAll();
    selectionStore.resetSelection();
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
