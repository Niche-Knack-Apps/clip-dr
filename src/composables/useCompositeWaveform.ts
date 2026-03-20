import { computed, ref, shallowRef } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useUIStore } from '@/stores/ui';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { TRACK_COLORS } from '@/shared/types';
import type { TrackClip, WaveformLayer, WaveformLayerClip, Track } from '@/shared/types';
import { isTrackPlayable, filterActiveTracks } from '@/shared/utils';

/**
 * Composable that creates a composite waveform from all tracks.
 * Tracks are merged based on their timeline position, with later tracks
 * (higher in the array) taking visual precedence where they overlap.
 * Waveform data format: min/max pairs (array[i*2]=min, array[i*2+1]=max)
 */
export function useCompositeWaveform() {
  const tracksStore = useTracksStore();
  const uiStore = useUIStore();

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

  // Version hash tracking waveform data and clip spatial identity
  // (invalidates when clips move, are added/removed, or change source offset)
  // Includes syncEpoch so rendering-relevant mutations always bust the cache.
  const waveformVersion = computed(() =>
    `e${tracksStore.syncEpoch}|` +
    tracksStore.tracks.map(t =>
      tracksStore.getTrackClips(t.id).map(c =>
        `${c.id}:${c.clipStart}:${c.duration}:${c.sourceOffset ?? 'na'}:${c.waveformData.length}`
      ).join(',')
    ).join('|')
  );

  // Cache for composite during drag — waveform data doesn't meaningfully change during position-only drag
  const cachedComposite = shallowRef<number[]>([]);
  const cachedCompositeVersion = ref<string>('');

  // Compute composite waveform data by merging all tracks
  const compositeWaveformData = computed(() => {
    const tracks = tracksStore.tracks;
    const version = waveformVersion.value;

    // During trim, freeze composite entirely (clip props change per frame but we want stable display)
    if (uiStore.activeTrimEdge !== null && cachedComposite.value.length > 0) {
      return cachedComposite.value;
    }
    // During drag, return cached composite if waveform data content hasn't changed
    if (tracksStore.activeDrag && version === cachedCompositeVersion.value && cachedComposite.value.length > 0) {
      return cachedComposite.value;
    }

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

    // Update cache
    cachedComposite.value = composite;
    cachedCompositeVersion.value = version;

    return composite;
  });

  // Cache for layers during trim — avoid re-rendering per frame
  const cachedLayers = shallowRef<WaveformLayer[]>([]);
  const cachedLayersVersion = ref<string>('');

  // Per-track waveform layers with solo/mute filtering
  const waveformLayers = computed((): WaveformLayer[] => {
    const tracks = tracksStore.tracks;
    if (tracks.length === 0) return [];

    // During trim, freeze layers entirely (clip props change per frame but we want stable display)
    if (uiStore.activeTrimEdge !== null && cachedLayers.value.length > 0) {
      return cachedLayers.value;
    }

    const timelineDuration = tracksStore.timelineDuration;
    if (timelineDuration <= 0) return [];

    // DUP-07: use canonical solo/mute filter (same logic as playback/export)
    const playable = tracks.filter((t: Track) => isTrackPlayable(t.importStatus));
    const active = filterActiveTracks(playable);

    if (active.length === 0) return [];

    const bucketDuration = timelineDuration / WAVEFORM_BUCKET_COUNT;
    const layers: WaveformLayer[] = [];

    for (const track of active) {
      // Single track with no clips: build position-aware bucket array
      // (avoids raw waveform stretching to full timeline width when trackStart > 0)
      if (!track.clips || track.clips.length === 0) {
        const trackBuckets = new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0);
        const pseudoClip: TrackClip = {
          id: `${track.id}-layer`,
          buffer: null,
          waveformData: track.audioData.waveformData,
          clipStart: track.trackStart,
          duration: track.duration,
          sourceFile: track.sourcePath || track.cachedAudioPath || undefined,
          sourceOffset: 0,
        };
        addClipToComposite(trackBuckets, pseudoClip, timelineDuration, bucketDuration);
        // Build clips array for hi-res rendering (buffer or peak tiles)
        const singleClips: WaveformLayerClip[] | undefined =
          track.audioData.buffer
            ? [{
                clipStart: track.trackStart,
                duration: track.duration,
                sourceOffset: 0,
                buffer: track.audioData.buffer,
              }]
            : undefined;
        layers.push({
          trackId: track.id,
          color: track.color,
          waveformData: trackBuckets,
          trackStart: track.trackStart,
          duration: track.duration,
          sourcePath: track.sourcePath,
          hasPeakPyramid: track.hasPeakPyramid,
          clips: singleClips,
        });
        continue;
      }

      // Multi-clip track: build per-track bucket array
      const trackBuckets = new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0);
      const clips = tracksStore.getTrackClips(track.id);
      for (const clip of clips) {
        addClipToComposite(trackBuckets, clip, timelineDuration, bucketDuration);
      }

      // Build WaveformLayerClip array for ALL multi-clip tracks:
      // EDL clips have sourceFile; small-file clips have buffer
      const layerClips: WaveformLayerClip[] = [];
      let hasAnyHiRes = false;
      for (const c of track.clips!) {
        if (c.buffer) {
          // Small-file clip: hi-res from AudioBuffer (shared ref, not cloned)
          layerClips.push({
            clipStart: c.clipStart,
            duration: c.duration,
            sourceOffset: c.sourceOffset ?? 0,
            buffer: c.buffer,
          });
          hasAnyHiRes = true;
        } else if (c.sourceFile) {
          // EDL clip: peak tiles from Rust
          layerClips.push({
            clipStart: c.clipStart,
            duration: c.duration,
            sourceFile: c.sourceFile,
            pyramidSourceFile: track.sourcePath,
            sourceOffset: c.sourceOffset ?? 0,
          });
          hasAnyHiRes = true;
        }
      }

      const isEDL = layerClips.length > 0 && layerClips.every(c => c.sourceFile);

      layers.push({
        trackId: track.id,
        color: track.color,
        waveformData: trackBuckets,
        trackStart: track.trackStart,
        duration: track.duration,
        sourcePath: track.sourcePath,
        hasPeakPyramid: isEDL ? true : track.hasPeakPyramid,
        clips: hasAnyHiRes ? layerClips : undefined,
      });
    }

    // Deduplicate layer colors — reassign duplicates from unused TRACK_COLORS
    const usedColors = new Set<string>();
    for (const layer of layers) {
      if (usedColors.has(layer.color)) {
        const unused = TRACK_COLORS.find(c => !usedColors.has(c));
        if (unused) layer.color = unused;
      }
      usedColors.add(layer.color);
    }

    // Update layer cache
    cachedLayers.value = layers;
    cachedLayersVersion.value = waveformVersion.value;

    return layers;
  });

  // Compute composite duration (same as timeline duration)
  const compositeDuration = computed(() => tracksStore.timelineDuration);

  return {
    compositeWaveformData,
    compositeDuration,
    waveformLayers,
  };
}
