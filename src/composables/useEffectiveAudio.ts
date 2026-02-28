import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useCompositeWaveform } from './useCompositeWaveform';

/**
 * Composable that provides the "effective" audio duration and waveform data.
 *
 * Always returns composite (all-tracks) waveform and timeline-absolute coordinates
 * so the playhead stays perfectly synchronized across all views.
 * Track selection only affects the selection window position, not the waveform data.
 */
export function useEffectiveAudio() {
  const tracksStore = useTracksStore();
  const { compositeWaveformData, compositeDuration, waveformLayers } = useCompositeWaveform();

  const selectedTrack = computed(() => tracksStore.selectedTrack);

  // Always return composite (all-tracks) duration
  const effectiveDuration = computed(() => compositeDuration.value);

  // Always return composite (all-tracks) waveform
  const effectiveWaveformData = computed(() => compositeWaveformData.value);

  // Always 0 - coordinate system is always timeline-absolute
  const effectiveTrackStart = computed(() => 0);

  // Always full timeline end
  const effectiveTrackEnd = computed(() => tracksStore.timelineDuration);

  // Color of selected track (or default cyan for ALL/no selection)
  const effectiveColor = computed(() => {
    const track = selectedTrack.value;
    return track ? track.color : '#00d4ff';
  });

  return {
    selectedTrack,
    effectiveDuration,
    effectiveWaveformData,
    effectiveTrackStart,
    effectiveTrackEnd,
    effectiveColor,
    waveformLayers,
  };
}
