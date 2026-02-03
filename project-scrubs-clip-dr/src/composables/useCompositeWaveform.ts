import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';

/**
 * Composable that creates a composite waveform from all tracks.
 * Tracks are merged based on their timeline position, with later tracks
 * (higher in the array) taking visual precedence where they overlap.
 * Waveform data format: min/max pairs (array[i*2]=min, array[i*2+1]=max)
 */
export function useCompositeWaveform() {
  const tracksStore = useTracksStore();

  // Compute composite waveform data by merging all tracks
  const compositeWaveformData = computed(() => {
    const tracks = tracksStore.tracks;

    if (tracks.length === 0) {
      return [];
    }

    // Single track - just return its waveform
    if (tracks.length === 1) {
      return tracks[0].audioData.waveformData;
    }

    const timelineDuration = tracksStore.timelineDuration;
    if (timelineDuration <= 0) {
      return [];
    }

    // Create a composite waveform array (min/max pairs)
    const composite = new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0);
    const bucketDuration = timelineDuration / WAVEFORM_BUCKET_COUNT;

    // Process tracks in order (later tracks override earlier ones in overlaps)
    for (const track of tracks) {
      const trackWaveform = track.audioData.waveformData;
      const trackStart = track.trackStart;
      const trackDuration = track.duration;
      const trackEnd = trackStart + trackDuration;
      const trackBucketCount = trackWaveform.length / 2; // min/max pairs

      // Calculate which buckets this track covers
      const startBucket = Math.floor((trackStart / timelineDuration) * WAVEFORM_BUCKET_COUNT);
      const endBucket = Math.ceil((trackEnd / timelineDuration) * WAVEFORM_BUCKET_COUNT);

      // Map track waveform to composite buckets
      for (let i = startBucket; i < endBucket && i < WAVEFORM_BUCKET_COUNT; i++) {
        if (i < 0) continue;

        // Calculate position within track's waveform
        const bucketTimeStart = i * bucketDuration;
        const relativeTime = bucketTimeStart - trackStart;
        const trackProgress = relativeTime / trackDuration;

        // Map to track's waveform bucket (min/max pair index)
        const trackBucket = Math.floor(trackProgress * trackBucketCount);

        if (trackBucket >= 0 && trackBucket < trackBucketCount) {
          const trackIdx = trackBucket * 2;
          const compositeIdx = i * 2;
          // Take min/max bounds that cover both waveforms (additive mixing)
          const trackMin = trackWaveform[trackIdx] || 0;
          const trackMax = trackWaveform[trackIdx + 1] || 0;
          const existingMin = composite[compositeIdx];
          const existingMax = composite[compositeIdx + 1];
          composite[compositeIdx] = Math.min(existingMin, trackMin);
          composite[compositeIdx + 1] = Math.max(existingMax, trackMax);
        }
      }
    }

    return composite;
  });

  // Compute composite duration (same as timeline duration)
  const compositeDuration = computed(() => tracksStore.timelineDuration);

  return {
    compositeWaveformData,
    compositeDuration,
  };
}
