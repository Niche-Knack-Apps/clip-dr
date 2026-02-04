import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Track, TrackAudioData, TrackClip, ViewMode } from '@/shared/types';
import { TRACK_COLORS } from '@/shared/types';
import { generateId } from '@/shared/utils';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';

export const useTracksStore = defineStore('tracks', () => {
  const tracks = ref<Track[]>([]);
  // 'ALL' means composite view (default), string means specific track, null means nothing selected
  const selectedTrackId = ref<string | 'ALL' | null>('ALL');
  const viewMode = ref<ViewMode>('all');

  // Track color counter for automatic color assignment
  let colorIndex = 0;

  function getNextColor(): string {
    const color = TRACK_COLORS[colorIndex % TRACK_COLORS.length];
    colorIndex++;
    return color;
  }

  // Computed: Get selected track (null if 'ALL' or no selection)
  const selectedTrack = computed(() => {
    if (selectedTrackId.value === 'ALL' || selectedTrackId.value === null) {
      return null;
    }
    return tracks.value.find((t) => t.id === selectedTrackId.value) ?? null;
  });

  // Computed: Timeline duration is the max end time of all tracks
  const timelineDuration = computed(() => {
    if (tracks.value.length === 0) return 0;
    return Math.max(...tracks.value.map((t) => t.trackStart + t.duration));
  });

  // Computed: Check if any track has audio loaded
  const hasAudio = computed(() => tracks.value.length > 0);

  // Generate waveform data from AudioBuffer (min/max pairs format)
  function generateWaveformFromBuffer(buffer: AudioBuffer, bucketCount: number = WAVEFORM_BUCKET_COUNT): number[] {
    const channelData = buffer.getChannelData(0);
    const samplesPerBucket = Math.ceil(channelData.length / bucketCount);
    const waveform: number[] = [];

    for (let i = 0; i < bucketCount; i++) {
      const start = i * samplesPerBucket;
      const end = Math.min(start + samplesPerBucket, channelData.length);

      let min = 0;
      let max = 0;
      for (let j = start; j < end; j++) {
        const sample = channelData[j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      // Push min/max pair - this is the format expected by useWaveform.ts
      waveform.push(min, max);
    }

    return waveform;
  }

  // Create a new track from an AudioBuffer
  function createTrackFromBuffer(
    buffer: AudioBuffer,
    waveformData: number[] | null,
    name: string,
    trackStart: number = 0,
    sourcePath?: string
  ): Track {
    // Generate waveform if not provided
    const waveform = waveformData ?? generateWaveformFromBuffer(buffer);

    const audioData: TrackAudioData = {
      buffer,
      waveformData: waveform,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
    };

    const track: Track = {
      id: generateId(),
      name,
      audioData,
      trackStart,
      duration: buffer.duration,
      color: getNextColor(),
      muted: false,
      solo: false,
      volume: 1,
      sourcePath,
    };

    tracks.value = [...tracks.value, track];
    console.log('[Tracks] Created track:', track.name, 'duration:', track.duration, 'at:', track.trackStart, 'source:', sourcePath);

    return track;
  }

  // Delete a track
  function deleteTrack(trackId: string): void {
    const index = tracks.value.findIndex((t) => t.id === trackId);
    if (index === -1) return;

    tracks.value = tracks.value.filter((t) => t.id !== trackId);
    console.log('[Tracks] Deleted track:', trackId);

    // Update selection if needed
    if (selectedTrackId.value === trackId) {
      selectedTrackId.value = 'ALL';
      viewMode.value = 'all';
    }
  }

  // Select a track or 'ALL' for composite view
  function selectTrack(trackId: string | 'ALL'): void {
    selectedTrackId.value = trackId;
    viewMode.value = trackId === 'ALL' ? 'all' : 'selected';
    console.log('[Tracks] Selected:', trackId);
  }

  function setTrackMuted(trackId: string, muted: boolean): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.muted = muted;
    }
  }

  function setTrackSolo(trackId: string, solo: boolean): void {
    // Exclusive solo - de-solo all other tracks when enabling
    tracks.value = tracks.value.map((t) => {
      if (t.id === trackId) {
        return { ...t, solo };
      }
      if (solo && t.solo) {
        return { ...t, solo: false };
      }
      return t;
    });
  }

  function setTrackVolume(trackId: string, volume: number): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.volume = Math.max(0, Math.min(1, volume));
    }
  }

  function renameTrack(trackId: string, name: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.name = name;
    }
  }

  function clearTracks(): void {
    tracks.value = [];
    selectedTrackId.value = 'ALL';
    viewMode.value = 'all';
    colorIndex = 0;
  }

  function reorderTrack(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= tracks.value.length) return;
    if (toIndex < 0 || toIndex >= tracks.value.length) return;
    if (fromIndex === toIndex) return;

    const newTracks = [...tracks.value];
    const [movedTrack] = newTracks.splice(fromIndex, 1);
    newTracks.splice(toIndex, 0, movedTrack);
    tracks.value = newTracks;
  }

  // Get tracks that are active (playing) at a given time
  function getActiveTracksAtTime(time: number): Track[] {
    return tracks.value.filter((track) => {
      if (track.muted) return false;

      const hasSolo = tracks.value.some((t) => t.solo);
      if (hasSolo && !track.solo) return false;

      const trackEnd = track.trackStart + track.duration;
      return time >= track.trackStart && time < trackEnd;
    });
  }

  // Get the audio buffer for a specific track
  function getBufferForTrack(trackId: string): AudioBuffer | null {
    const track = tracks.value.find((t) => t.id === trackId);
    return track?.audioData.buffer ?? null;
  }

  // Get waveform data for a specific track
  function getWaveformForTrack(trackId: string): number[] | null {
    const track = tracks.value.find((t) => t.id === trackId);
    return track?.audioData.waveformData ?? null;
  }

  // Move a track to a new position on the timeline
  function setTrackStart(trackId: string, newStart: number): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.trackStart = Math.max(0, newStart);
    }
  }

  // Create tracks for speech segments (VAD results)
  // Note: This creates visual markers/tracks for detected speech regions
  function createSpeechSegmentTracks(segments: Array<{ start: number; end: number }>): void {
    // In the new track-centric model, we don't create separate tracks for speech segments
    // Instead, the silence overlays in the UI handle visualization
    // This function is kept for backwards compatibility but logs a warning
    console.log('[Tracks] createSpeechSegmentTracks called with', segments.length, 'segments');
    console.log('[Tracks] Speech segments are now visualized via silence overlays, not separate tracks');
  }

  // Delete all tracks tagged as speech segments
  function deleteSpeechSegmentTracks(): void {
    const speechTracks = tracks.value.filter(t => t.tag === 'speech-segment');
    if (speechTracks.length > 0) {
      tracks.value = tracks.value.filter(t => t.tag !== 'speech-segment');
      console.log('[Tracks] Deleted', speechTracks.length, 'speech segment tracks');
    }
  }

  // Append audio to the end of an existing track
  function appendAudioToTrack(
    trackId: string,
    buffer: AudioBuffer,
    audioContext: AudioContext
  ): boolean {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) {
      console.error('[Tracks] Track not found:', trackId);
      return false;
    }

    const existingBuffer = track.audioData.buffer;

    // Handle sample rate mismatch by using the existing track's sample rate
    // The buffer should already be at the correct sample rate from clipboard
    if (buffer.sampleRate !== existingBuffer.sampleRate) {
      console.warn('[Tracks] Sample rate mismatch:', buffer.sampleRate, 'vs', existingBuffer.sampleRate);
      // For now, proceed anyway - in production you'd want to resample
    }

    // Create new combined buffer
    const newLength = existingBuffer.length + buffer.length;
    const numChannels = Math.max(existingBuffer.numberOfChannels, buffer.numberOfChannels);

    const newBuffer = audioContext.createBuffer(
      numChannels,
      newLength,
      existingBuffer.sampleRate
    );

    // Copy existing audio then new audio for each channel
    for (let ch = 0; ch < numChannels; ch++) {
      const newChannelData = newBuffer.getChannelData(ch);

      // Copy existing data
      if (ch < existingBuffer.numberOfChannels) {
        newChannelData.set(existingBuffer.getChannelData(ch), 0);
      }

      // Copy new data
      if (ch < buffer.numberOfChannels) {
        newChannelData.set(buffer.getChannelData(ch), existingBuffer.length);
      }
    }

    // Regenerate waveform from the combined buffer to maintain consistent bucket count
    const newWaveformData = generateWaveformFromBuffer(newBuffer);

    // Update track - need to replace the entire track object to trigger reactivity
    const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
    if (trackIndex !== -1) {
      tracks.value[trackIndex] = {
        ...track,
        audioData: {
          buffer: newBuffer,
          waveformData: newWaveformData,
          sampleRate: newBuffer.sampleRate,
          channels: newBuffer.numberOfChannels,
        },
        duration: newBuffer.duration,
      };
      // Trigger reactivity by reassigning the array
      tracks.value = [...tracks.value];
    }

    console.log(`[Tracks] Appended ${buffer.duration.toFixed(2)}s to track ${track.name}, new duration: ${newBuffer.duration.toFixed(2)}s`);
    return true;
  }

  // Move track audio from one track to another at specified position
  function moveTrackToTrack(
    sourceTrackId: string,
    targetTrackId: string,
    newTrackStart: number,
    audioContext: AudioContext
  ): boolean {
    if (sourceTrackId === targetTrackId) {
      // Just update position
      setTrackStart(sourceTrackId, newTrackStart);
      return true;
    }

    const sourceTrack = tracks.value.find((t) => t.id === sourceTrackId);
    const targetTrack = tracks.value.find((t) => t.id === targetTrackId);

    if (!sourceTrack || !targetTrack) {
      console.error('[Tracks] Source or target track not found');
      return false;
    }

    // For now, moving to another track means merging at the target's end
    // The source track gets deleted and its audio appends to target
    const success = appendAudioToTrack(
      targetTrackId,
      sourceTrack.audioData.buffer,
      audioContext
    );

    if (success) {
      // Delete the source track
      deleteTrack(sourceTrackId);
      console.log(`[Tracks] Moved audio from ${sourceTrack.name} to ${targetTrack.name}`);
    }

    return success;
  }

  // Cut a region from a track, creating clips for the remaining audio
  // Returns the cut audio as a buffer (for clipboard) or null if cut failed
  function cutRegionFromTrack(
    trackId: string,
    inPoint: number,
    outPoint: number,
    audioContext: AudioContext
  ): { buffer: AudioBuffer; waveformData: number[] } | null {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) {
      console.error('[Tracks] Track not found:', trackId);
      return null;
    }

    // Convert timeline coordinates to track-relative
    const trackStart = track.trackStart;
    const relativeIn = inPoint - trackStart;
    const relativeOut = outPoint - trackStart;

    // Clamp to track bounds
    const cutStart = Math.max(0, relativeIn);
    const cutEnd = Math.min(track.duration, relativeOut);

    if (cutEnd <= cutStart) {
      console.log('[Tracks] Nothing to cut - region outside track bounds');
      return null;
    }

    const buffer = track.audioData.buffer;
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;

    const cutStartSample = Math.floor(cutStart * sampleRate);
    const cutEndSample = Math.floor(cutEnd * sampleRate);

    // Extract the cut region for clipboard
    const cutLength = cutEndSample - cutStartSample;
    const cutBuffer = audioContext.createBuffer(channels, cutLength, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const sourceData = buffer.getChannelData(ch);
      const destData = cutBuffer.getChannelData(ch);
      for (let i = 0; i < cutLength; i++) {
        destData[i] = sourceData[cutStartSample + i];
      }
    }
    const cutWaveform = generateWaveformFromBuffer(cutBuffer);

    // Check what remains
    const hasAudioBefore = cutStart > 0.001; // More than 1ms
    const hasAudioAfter = cutEnd < track.duration - 0.001;

    if (!hasAudioBefore && !hasAudioAfter) {
      // Entire track was cut - delete it
      deleteTrack(trackId);
      console.log('[Tracks] Entire track cut, deleted');
      return { buffer: cutBuffer, waveformData: cutWaveform };
    }

    // Create clips for remaining audio
    const newClips: TrackClip[] = [];

    if (hasAudioBefore) {
      // Create clip for audio before cut
      const beforeLength = cutStartSample;
      const beforeBuffer = audioContext.createBuffer(channels, beforeLength, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const sourceData = buffer.getChannelData(ch);
        const destData = beforeBuffer.getChannelData(ch);
        for (let i = 0; i < beforeLength; i++) {
          destData[i] = sourceData[i];
        }
      }
      newClips.push({
        id: generateId(),
        buffer: beforeBuffer,
        waveformData: generateWaveformFromBuffer(beforeBuffer),
        clipStart: trackStart,
        duration: beforeBuffer.duration,
      });
    }

    if (hasAudioAfter) {
      // Create clip for audio after cut
      const afterStartSample = cutEndSample;
      const afterLength = buffer.length - afterStartSample;
      const afterBuffer = audioContext.createBuffer(channels, afterLength, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const sourceData = buffer.getChannelData(ch);
        const destData = afterBuffer.getChannelData(ch);
        for (let i = 0; i < afterLength; i++) {
          destData[i] = sourceData[afterStartSample + i];
        }
      }
      // Position after clip at the cut point (where the cut region ended)
      newClips.push({
        id: generateId(),
        buffer: afterBuffer,
        waveformData: generateWaveformFromBuffer(afterBuffer),
        clipStart: trackStart + cutEnd,
        duration: afterBuffer.duration,
      });
    }

    // Update the track with clips
    const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
    if (trackIndex !== -1) {
      // Calculate new track duration (span from first clip start to last clip end)
      const firstClipStart = Math.min(...newClips.map(c => c.clipStart));
      const lastClipEnd = Math.max(...newClips.map(c => c.clipStart + c.duration));

      tracks.value[trackIndex] = {
        ...track,
        clips: newClips,
        trackStart: firstClipStart,
        duration: lastClipEnd - firstClipStart,
      };
      tracks.value = [...tracks.value];
    }

    console.log(`[Tracks] Cut ${(cutEnd - cutStart).toFixed(2)}s from track, created ${newClips.length} clips`);
    return { buffer: cutBuffer, waveformData: cutWaveform };
  }

  // Get all clips for a track (returns single-element array if no clips defined)
  function getTrackClips(trackId: string): TrackClip[] {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) return [];

    if (track.clips && track.clips.length > 0) {
      return track.clips;
    }

    // Convert single audioData to a clip for uniform handling
    return [{
      id: track.id + '-main',
      buffer: track.audioData.buffer,
      waveformData: track.audioData.waveformData,
      clipStart: track.trackStart,
      duration: track.duration,
    }];
  }

  // Snap threshold in seconds (clips snap when within this distance)
  const SNAP_THRESHOLD = 0.1;

  // Calculate snapped position for a clip, preventing overlap with other clips
  function getSnappedClipPosition(
    trackId: string,
    clipId: string,
    desiredStart: number,
    clipDuration: number,
    snapEnabled: boolean
  ): number {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) return Math.max(0, desiredStart);

    // Get all other clips in the same track
    const allClips = getTrackClips(trackId);
    const otherClips = allClips.filter((c) => c.id !== clipId);

    if (otherClips.length === 0) {
      return Math.max(0, desiredStart);
    }

    const desiredEnd = desiredStart + clipDuration;
    let snappedStart = desiredStart;

    // Sort other clips by position
    const sortedClips = [...otherClips].sort((a, b) => a.clipStart - b.clipStart);

    if (snapEnabled) {
      // Check for snap points at edges of other clips
      for (const other of sortedClips) {
        const otherEnd = other.clipStart + other.duration;

        // Snap to end of other clip (our start aligns with their end)
        if (Math.abs(desiredStart - otherEnd) < SNAP_THRESHOLD) {
          snappedStart = otherEnd;
          break;
        }

        // Snap to start of other clip (our end aligns with their start)
        if (Math.abs(desiredEnd - other.clipStart) < SNAP_THRESHOLD) {
          snappedStart = other.clipStart - clipDuration;
          break;
        }

        // Snap our start to their start
        if (Math.abs(desiredStart - other.clipStart) < SNAP_THRESHOLD) {
          snappedStart = other.clipStart;
          break;
        }
      }
    }

    // Only prevent overlap when snap is enabled
    // When snap is disabled, allow clips to overlap freely
    if (snapEnabled) {
      const snappedEnd = snappedStart + clipDuration;

      for (const other of sortedClips) {
        const otherEnd = other.clipStart + other.duration;

        // Check if we would overlap
        if (snappedStart < otherEnd && snappedEnd > other.clipStart) {
          // We overlap - push to nearest edge
          const distToSnapBefore = Math.abs(snappedStart - otherEnd);
          const distToSnapAfter = Math.abs(snappedEnd - other.clipStart);

          if (distToSnapBefore <= distToSnapAfter) {
            // Snap to just after this clip
            snappedStart = otherEnd;
          } else {
            // Snap to just before this clip
            snappedStart = other.clipStart - clipDuration;
          }
        }
      }
    }

    return Math.max(0, snappedStart);
  }

  // Update a specific clip's position within a track
  // Note: This only updates the clip position, not track bounds (to avoid zoom changes during drag)
  function setClipStart(trackId: string, clipId: string, newClipStart: number, snapEnabled: boolean = false): void {
    const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
    if (trackIndex === -1) return;

    const track = tracks.value[trackIndex];

    // Handle single-clip track (no clips array)
    if (!track.clips || track.clips.length === 0) {
      // For tracks without clips array, clipId is "trackId-main"
      if (clipId === track.id + '-main') {
        // For single-clip tracks, snap is handled differently (snap to other tracks' clips)
        // For now, just constrain to >= 0
        track.trackStart = Math.max(0, newClipStart);
        // Trigger reactivity
        tracks.value = [...tracks.value];
      }
      return;
    }

    // Find the clip being moved
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex === -1) return;

    const clip = track.clips[clipIndex];

    // Calculate snapped position (with overlap prevention)
    const snappedStart = getSnappedClipPosition(
      trackId,
      clipId,
      newClipStart,
      clip.duration,
      snapEnabled
    );

    // Only update the clip's position, don't recalculate track bounds
    // This prevents timeline duration from changing during drag
    track.clips[clipIndex] = {
      ...track.clips[clipIndex],
      clipStart: snappedStart,
    };

    // Trigger reactivity
    tracks.value = [...tracks.value];
  }

  // Finalize clip positions and recalculate track bounds after drag ends
  function finalizeClipPositions(trackId: string): void {
    const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
    if (trackIndex === -1) return;

    const track = tracks.value[trackIndex];
    if (!track.clips || track.clips.length === 0) return;

    // Recalculate track bounds based on all clips
    const firstClipStart = Math.min(...track.clips.map(c => c.clipStart));
    const lastClipEnd = Math.max(...track.clips.map(c => c.clipStart + c.duration));

    tracks.value[trackIndex] = {
      ...track,
      trackStart: firstClipStart,
      duration: lastClipEnd - firstClipStart,
    };

    // Trigger reactivity
    tracks.value = [...tracks.value];
  }

  return {
    tracks,
    selectedTrackId,
    viewMode,
    selectedTrack,
    timelineDuration,
    hasAudio,
    createTrackFromBuffer,
    deleteTrack,
    selectTrack,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
    renameTrack,
    clearTracks,
    reorderTrack,
    getActiveTracksAtTime,
    getBufferForTrack,
    getWaveformForTrack,
    setTrackStart,
    generateWaveformFromBuffer,
    createSpeechSegmentTracks,
    deleteSpeechSegmentTracks,
    appendAudioToTrack,
    moveTrackToTrack,
    cutRegionFromTrack,
    getTrackClips,
    setClipStart,
    finalizeClipPositions,
  };
});
