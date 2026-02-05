import { computed } from 'vue';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

export function usePlayback() {
  const playbackStore = usePlaybackStore();
  const selectionStore = useSelectionStore();
  const settingsStore = useSettingsStore();

  const isPlaying = computed(() => playbackStore.isPlaying);
  const currentTime = computed(() => playbackStore.currentTime);
  const loopEnabled = computed(() => playbackStore.loopEnabled);
  const volume = computed(() => playbackStore.volume);
  const isScrubbing = computed(() => playbackStore.isScrubbing);

  const loopStart = computed(() => selectionStore.selection.start);
  const loopEnd = computed(() => selectionStore.selection.end);

  function play(): void {
    playbackStore.play();
  }

  function pause(): void {
    playbackStore.pause();
  }

  function stop(): void {
    playbackStore.stop();
  }

  function togglePlay(): void {
    playbackStore.togglePlay();
  }

  function seek(time: number): void {
    playbackStore.seek(time);
  }

  function seekToSelection(): void {
    playbackStore.seekToSelection();
  }

  function setVolume(newVolume: number): void {
    playbackStore.setVolume(newVolume);
  }

  function toggleLoop(): void {
    playbackStore.setLoopEnabled(!playbackStore.loopEnabled);
  }

  function startScrubbing(): void {
    playbackStore.startScrubbing();
  }

  function scrub(time: number): void {
    playbackStore.scrub(time);
  }

  function endScrubbing(): void {
    playbackStore.endScrubbing();
  }

  function jumpToInPoint(): void {
    const { inPoint } = selectionStore.inOutPoints;
    if (inPoint !== null) {
      seek(inPoint);
    }
  }

  function jumpToOutPoint(): void {
    const { outPoint } = selectionStore.inOutPoints;
    if (outPoint !== null) {
      seek(outPoint);
    }
  }

  return {
    isPlaying,
    currentTime,
    loopEnabled,
    volume,
    isScrubbing,
    loopStart,
    loopEnd,
    play,
    pause,
    stop,
    togglePlay,
    seek,
    seekToSelection,
    setVolume,
    toggleLoop,
    startScrubbing,
    scrub,
    endScrubbing,
    jumpToInPoint,
    jumpToOutPoint,
  };
}
