import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useCompositeWaveform } from './useCompositeWaveform';

/**
 * Composable that provides the "effective" audio duration and waveform data
 * based on the current track selection.
 *
 * - When a specific track is selected: returns that track's waveform and duration
 * - When 'ALL' is selected: returns composite waveform of all tracks
 * - When nothing is selected: returns empty/zero values
 */
export function useEffectiveAudio() {
  const tracksStore = useTracksStore();
  const { compositeWaveformData, compositeDuration } = useCompositeWaveform();

  // Get the currently selected track (null if 'ALL' or nothing selected)
  const selectedTrack = computed(() => {
    const track = tracksStore.selectedTrack;
    console.log('[EffectiveAudio] selectedTrack computed:', {
      selectedTrackId: tracksStore.selectedTrackId,
      trackName: track?.name ?? 'null',
      trackId: track?.id ?? 'null',
    });
    return track;
  });

  // Effective duration based on selection
  const effectiveDuration = computed(() => {
    // ALL view - return composite duration
    if (tracksStore.selectedTrackId === 'ALL') {
      return compositeDuration.value;
    }

    // Specific track selected
    const track = selectedTrack.value;
    if (track) {
      return track.duration;
    }

    // No selection - return timeline duration if we have tracks, else 0
    return tracksStore.timelineDuration;
  });

  // Effective waveform data based on selection
  const effectiveWaveformData = computed(() => {
    // ALL view - return composite waveform
    if (tracksStore.selectedTrackId === 'ALL') {
      console.log('[EffectiveAudio] waveform: ALL view, using composite');
      return compositeWaveformData.value;
    }

    // Specific track selected
    const track = selectedTrack.value;
    if (track) {
      console.log('[EffectiveAudio] waveform: specific track', track.name, 'id:', track.id, 'waveform length:', track.audioData.waveformData.length);
      return track.audioData.waveformData;
    }

    // No selection but have tracks - return first track's waveform
    if (tracksStore.tracks.length > 0) {
      console.log('[EffectiveAudio] waveform: no selection, using first track:', tracksStore.tracks[0].name);
      return tracksStore.tracks[0].audioData.waveformData;
    }

    console.log('[EffectiveAudio] waveform: no tracks, returning empty');
    return [];
  });

  // Get the effective track start time (for positioning playhead correctly)
  const effectiveTrackStart = computed(() => {
    // ALL view or no specific track - start at 0
    if (tracksStore.selectedTrackId === 'ALL') {
      return 0;
    }

    // Specific track selected - return its start position
    const track = selectedTrack.value;
    if (track) {
      return track.trackStart;
    }

    return 0;
  });

  // Get the effective end time
  const effectiveTrackEnd = computed(() => {
    // ALL view - return timeline end
    if (tracksStore.selectedTrackId === 'ALL') {
      return tracksStore.timelineDuration;
    }

    // Specific track selected
    const track = selectedTrack.value;
    if (track) {
      return track.trackStart + track.duration;
    }

    return tracksStore.timelineDuration;
  });

  // Check if we're in ALL view mode
  const isAllView = computed(() => tracksStore.selectedTrackId === 'ALL');

  // Get the color for the current selection
  const effectiveColor = computed(() => {
    const track = selectedTrack.value;
    if (track) {
      return track.color;
    }
    // Default cyan for ALL view or no selection
    return '#00d4ff';
  });

  return {
    selectedTrack,
    effectiveDuration,
    effectiveWaveformData,
    effectiveTrackStart,
    effectiveTrackEnd,
    effectiveColor,
    isAllView,
  };
}
