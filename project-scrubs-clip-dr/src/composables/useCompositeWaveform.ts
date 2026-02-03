import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import type { TrackClip } from '@/shared/types';

/**
 * Composable that creates a composite waveform from all tracks.
 * Tracks are merged based on their timeline position, with later tracks
 * (higher in the array) taking visual precedence where they overlap.
 * Waveform data format: min/max pairs (array[i*2]=min, array[i*2+1]=max)
 */
export function useCompositeWaveform() {
  const tracksStore = useTracksStore();

  /**
   * Add a clip's waveform to the composite at the appropriate position.
   */
  function addClipToComposite(
    composite: number[],
    clip: TrackClip,
    timelineDuration: number,
    bucketDuration: number
  ): void {
    const clipStart = clip.clipStart;
    const clipDuration = clip.duration;
    const clipEnd = clipStart + clipDuration;
    const clipWaveform = clip.waveformData;
    const clipBucketCount = clipWaveform.length / 2;

    // Calculate which composite buckets this clip covers
    const startBucket = Math.floor((clipStart / timelineDuration) * WAVEFORM_BUCKET_COUNT);
    const endBucket = Math.ceil((clipEnd / timelineDuration) * WAVEFORM_BUCKET_COUNT);

    // Map clip waveform to composite buckets
    for (let i = startBucket; i < endBucket && i < WAVEFORM_BUCKET_COUNT; i++) {
      if (i < 0) continue;

      // Calculate position within clip's waveform
      const bucketTimeStart = i * bucketDuration;
      const relativeTime = bucketTimeStart - clipStart;
      const clipProgress = relativeTime / clipDuration;

      // Map to clip's waveform bucket
      const clipBucket = Math.floor(clipProgress * clipBucketCount);

      if (clipBucket >= 0 && clipBucket < clipBucketCount) {
        const clipIdx = clipBucket * 2;
        const compositeIdx = i * 2;
        // Take min/max bounds that cover both waveforms (additive mixing)
        const clipMin = clipWaveform[clipIdx] || 0;
        const clipMax = clipWaveform[clipIdx + 1] || 0;
        const existingMin = composite[compositeIdx];
        const existingMax = composite[compositeIdx + 1];
        composite[compositeIdx] = Math.min(existingMin, clipMin);
        composite[compositeIdx + 1] = Math.max(existingMax, clipMax);
      }
    }
  }

  // Compute composite waveform data by merging all tracks
  const compositeWaveformData = computed(() => {
    const tracks = tracksStore.tracks;

    if (tracks.length === 0) {
      return [];
    }

    // Single track without clips - just return its waveform
    if (tracks.length === 1 && (!tracks[0].clips || tracks[0].clips.length === 0)) {
      return tracks[0].audioData.waveformData;
    }

    const timelineDuration = tracksStore.timelineDuration;
    if (timelineDuration <= 0) {
      return [];
    }

    // Create a composite waveform array (min/max pairs)
    const composite = new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0);
    const bucketDuration = timelineDuration / WAVEFORM_BUCKET_COUNT;

    // Process tracks in order
    for (const track of tracks) {
      // Get clips for this track (handles both multi-clip and single-buffer tracks)
      const clips = tracksStore.getTrackClips(track.id);

      // Add each clip to the composite
      for (const clip of clips) {
        addClipToComposite(composite, clip, timelineDuration, bucketDuration);
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
