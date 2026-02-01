import { computed } from 'vue';
import { useAudioStore } from '@/stores/audio';
import { useTracksStore } from '@/stores/tracks';
import { useCleaningStore } from '@/stores/cleaning';
import { useSilenceStore } from '@/stores/silence';

/**
 * Composable that provides the "effective" audio duration and waveform data.
 * When a processed track (cleaned or silence-cut) is soloed, it returns that track's
 * duration and waveform. Otherwise, it returns the full audio data.
 */
export function useEffectiveAudio() {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const cleaningStore = useCleaningStore();
  const silenceStore = useSilenceStore();

  // Get the soloed processed track (if any) for waveform display
  const soloedProcessedTrack = computed(() => {
    // Find a soloed clip track
    const soloedClip = tracksStore.clipTracks.find(t => t.solo);
    if (!soloedClip) return null;

    // Check if it has processed audio (cleaned or cut)
    const hasCleanedAudio = cleaningStore.hasCleanedAudio(soloedClip.id);
    const hasCutAudio = silenceStore.hasCutAudio(soloedClip.id);

    if (hasCleanedAudio || hasCutAudio) {
      return {
        track: soloedClip,
        isCleanedAudio: hasCleanedAudio,
        isCutAudio: hasCutAudio,
      };
    }

    return null;
  });

  // Effective duration - uses soloed processed track's duration if available
  const effectiveDuration = computed(() => {
    const processed = soloedProcessedTrack.value;
    if (processed) {
      return processed.track.end; // Track end IS the duration for processed tracks (start is 0)
    }
    return audioStore.duration;
  });

  // Effective waveform data - uses soloed processed track's waveform if available
  const effectiveWaveformData = computed(() => {
    const processed = soloedProcessedTrack.value;
    if (!processed) {
      return audioStore.currentFile?.waveformData ?? [];
    }

    if (processed.isCleanedAudio) {
      const waveform = cleaningStore.getWaveformForTrack(processed.track.id);
      if (waveform) return waveform;
    }

    if (processed.isCutAudio) {
      const waveform = silenceStore.getWaveformForTrack(processed.track.id);
      if (waveform) return waveform;
    }

    return audioStore.currentFile?.waveformData ?? [];
  });

  return {
    soloedProcessedTrack,
    effectiveDuration,
    effectiveWaveformData,
  };
}
