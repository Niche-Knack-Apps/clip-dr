import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useCompositeWaveform } from './useCompositeWaveform';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import type { Track } from '@/shared/types';

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

  /**
   * Composite clip waveforms into a single waveform with gaps.
   * This handles multi-clip tracks where audio was cut.
   */
  function compositeClipWaveforms(track: Track): number[] {

    const clips = tracksStore.getTrackClips(track.id);
    if (clips.length === 0) return [];

    // If only one clip and it starts at track start, just return its waveform
    if (clips.length === 1 && Math.abs(clips[0].clipStart - track.trackStart) < 0.001) {
      return clips[0].waveformData;
    }

    // Multiple clips or clips with gaps - need to composite
    // Find the span of all clips relative to track start
    const trackStart = track.trackStart;
    const trackDuration = track.duration;

    if (trackDuration <= 0) return [];

    // Create output waveform (min/max pairs)
    const result: number[] = new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0);
    const bucketDuration = trackDuration / WAVEFORM_BUCKET_COUNT;

    for (const clip of clips) {
      // Calculate where this clip sits relative to track start
      const clipRelativeStart = clip.clipStart - trackStart;
      const clipBucketCount = clip.waveformData.length / 2;
      const clipBucketDuration = clip.duration / clipBucketCount;

      // For each bucket in the output, check if it overlaps with this clip
      for (let i = 0; i < WAVEFORM_BUCKET_COUNT; i++) {
        const bucketStart = i * bucketDuration;
        const bucketEnd = bucketStart + bucketDuration;

        // Check if this bucket overlaps with the clip
        const clipEnd = clipRelativeStart + clip.duration;
        if (bucketEnd <= clipRelativeStart || bucketStart >= clipEnd) {
          continue; // No overlap
        }

        // Find the corresponding bucket(s) in the clip's waveform
        const clipBucketStart = Math.floor((bucketStart - clipRelativeStart) / clipBucketDuration);
        const clipBucketEnd = Math.ceil((bucketEnd - clipRelativeStart) / clipBucketDuration);

        // Clamp to valid range
        const startIdx = Math.max(0, clipBucketStart);
        const endIdx = Math.min(clipBucketCount, clipBucketEnd);

        // Blend the clip's waveform values into this bucket
        let minVal = result[i * 2];
        let maxVal = result[i * 2 + 1];

        for (let j = startIdx; j < endIdx; j++) {
          const clipMin = clip.waveformData[j * 2];
          const clipMax = clip.waveformData[j * 2 + 1];
          minVal = Math.min(minVal, clipMin);
          maxVal = Math.max(maxVal, clipMax);
        }

        result[i * 2] = minVal;
        result[i * 2 + 1] = maxVal;
      }
    }

    return result;
  }

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
      // Check if track has multiple clips (from cut operation)
      if (track.clips && track.clips.length > 0) {
        console.log('[EffectiveAudio] waveform: track with clips', track.name, 'clips:', track.clips.length);
        return compositeClipWaveforms(track);
      }
      console.log('[EffectiveAudio] waveform: specific track', track.name, 'id:', track.id, 'waveform length:', track.audioData.waveformData.length);
      return track.audioData.waveformData;
    }

    // No selection but have tracks - return first track's waveform
    if (tracksStore.tracks.length > 0) {
      const firstTrack = tracksStore.tracks[0];
      if (firstTrack.clips && firstTrack.clips.length > 0) {
        console.log('[EffectiveAudio] waveform: no selection, using first track with clips:', firstTrack.name);
        return compositeClipWaveforms(firstTrack);
      }
      console.log('[EffectiveAudio] waveform: no selection, using first track:', firstTrack.name);
      return firstTrack.audioData.waveformData;
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
