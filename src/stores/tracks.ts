import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Track, TrackAudioData, TrackClip, ViewMode, ImportStatus, WaveformChunkEvent, VolumeAutomationPoint } from '@/shared/types';
import { TRACK_COLORS } from '@/shared/types';
import { generateId, binarySearch } from '@/shared/utils';
import { WAVEFORM_BUCKET_COUNT, MAX_VOLUME_LINEAR } from '@/shared/constants';
import { useHistoryStore } from './history';
import { useTranscriptionStore } from './transcription';

export const useTracksStore = defineStore('tracks', () => {
  const tracks = ref<Track[]>([]);
  // 'ALL' means composite view (default), string means specific track, null means nothing selected
  const selectedTrackId = ref<string | 'ALL' | null>('ALL');
  const viewMode = ref<ViewMode>('all');

  // Selected clip within a track (for segment operations)
  const selectedClipId = ref<string | null>(null);

  // Pending drag position for single-clip tracks — decoupled from track.trackStart
  // to prevent timelineDuration from changing during drag (which causes clip resizing)
  const activeDrag = ref<{ trackId: string; position: number } | null>(null);

  // Minimum timeline duration floor — prevents timeline from shrinking when dragging left.
  // Gets expanded when dragging right, only resets when user manually zooms.
  const minTimelineDuration = ref(0);

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
  // Uses minTimelineDuration as a floor to prevent shrinking when dragging clips left
  const timelineDuration = computed(() => {
    if (tracks.value.length === 0) return minTimelineDuration.value;
    const actualDuration = Math.max(...tracks.value.map((t) => t.trackStart + t.duration));
    return Math.max(actualDuration, minTimelineDuration.value);
  });

  // Computed: Check if any track has audio loaded
  const hasAudio = computed(() => tracks.value.length > 0);

  // Computed: Get selected clip info (searches all tracks)
  const selectedClip = computed(() => {
    if (!selectedClipId.value) return null;
    for (const track of tracks.value) {
      const clips = getTrackClips(track.id);
      const clip = clips.find(c => c.id === selectedClipId.value);
      if (clip) return { trackId: track.id, clip };
    }
    return null;
  });

  function selectClip(trackId: string, clipId: string): void {
    selectedClipId.value = clipId;
    console.log('[Tracks] Selected clip:', clipId, 'in track:', trackId);
  }

  function clearClipSelection(): void {
    selectedClipId.value = null;
  }

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
    useHistoryStore().pushState('Add track');
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
    useHistoryStore().pushState('Delete track');

    // Remove associated transcription
    useTranscriptionStore().removeTranscription(trackId);

    tracks.value = tracks.value.filter((t) => t.id !== trackId);
    console.log('[Tracks] Deleted track:', trackId);

    // Update selection: pick an adjacent track, or fall back to 'ALL' if none remain
    if (selectedTrackId.value === trackId) {
      if (tracks.value.length > 0) {
        const newIndex = Math.min(index, tracks.value.length - 1);
        selectedTrackId.value = tracks.value[newIndex].id;
        viewMode.value = 'selected';
      } else {
        selectedTrackId.value = 'ALL';
        viewMode.value = 'all';
      }
    }
  }

  // Clear a track's audio data but keep the empty track shell
  function clearTrackAudio(trackId: string): void {
    const index = tracks.value.findIndex((t) => t.id === trackId);
    if (index === -1) return;
    useHistoryStore().pushState('Clear track audio');

    const track = tracks.value[index];
    tracks.value[index] = {
      ...track,
      audioData: { buffer: null, waveformData: [], sampleRate: track.audioData.sampleRate, channels: track.audioData.channels },
      clips: undefined,
      duration: 0,
    };
    tracks.value = [...tracks.value];
    console.log('[Tracks] Cleared audio from track:', trackId);
  }

  // Select a track or 'ALL' for composite view
  function selectTrack(trackId: string | 'ALL'): void {
    selectedTrackId.value = trackId;
    selectedClipId.value = null;
    viewMode.value = trackId === 'ALL' ? 'all' : 'selected';
    console.log('[Tracks] Selected:', trackId);
  }

  function setTrackMuted(trackId: string, muted: boolean): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      useHistoryStore().pushState('Toggle mute');
      track.muted = muted;
    }
  }

  function setTrackSolo(trackId: string, solo: boolean): void {
    useHistoryStore().pushState('Toggle solo');
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
      useHistoryStore().pushState('Set volume');
      track.volume = Math.max(0, Math.min(MAX_VOLUME_LINEAR, volume));
    }
  }

  function renameTrack(trackId: string, name: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      useHistoryStore().pushState('Rename track');
      track.name = name;
    }
  }

  function clearTracks(): void {
    useHistoryStore().pushState('Clear all');
    tracks.value = [];
    selectedTrackId.value = 'ALL';
    viewMode.value = 'all';
    colorIndex = 0;
  }

  function reorderTrack(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= tracks.value.length) return;
    if (toIndex < 0 || toIndex >= tracks.value.length) return;
    if (fromIndex === toIndex) return;

    useHistoryStore().pushState('Reorder track');
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
    useHistoryStore().pushState('Append audio');

    const existingBuffer = track.audioData.buffer;

    // Empty track — just set the new buffer directly
    if (!existingBuffer) {
      const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
      if (trackIndex !== -1) {
        const newWaveformData = generateWaveformFromBuffer(buffer);
        tracks.value[trackIndex] = {
          ...track,
          audioData: {
            buffer,
            waveformData: newWaveformData,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
          },
          duration: buffer.duration,
        };
        tracks.value = [...tracks.value];
      }
      console.log(`[Tracks] Set audio on empty track ${track.name}, duration: ${buffer.duration.toFixed(2)}s`);
      return true;
    }

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
    if (!sourceTrack.audioData.buffer) {
      console.log('[Tracks] Source track is empty, nothing to move');
      return false;
    }
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
    audioContext: AudioContext,
    keepTrack = false
  ): { buffer: AudioBuffer; waveformData: number[] } | null {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) {
      console.error('[Tracks] Track not found:', trackId);
      return null;
    }
    useHistoryStore().pushState('Cut region');

    // ── Multi-clip track: process each clip individually ──
    if (track.clips && track.clips.length > 0) {
      return cutRegionFromClips(track, trackId, inPoint, outPoint, audioContext, keepTrack);
    }

    // ── Single-buffer track (original path) ──
    if (!track.audioData.buffer) return null; // Empty track, nothing to cut

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
      if (keepTrack) {
        // Clear audio but preserve the empty track shell
        const trackIndex = tracks.value.findIndex(t => t.id === trackId);
        if (trackIndex !== -1) {
          tracks.value[trackIndex] = {
            ...track,
            audioData: { buffer: null, waveformData: [], sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels },
            clips: undefined,
            duration: 0,
          };
          tracks.value = [...tracks.value];
        }
        console.log('[Tracks] Entire track cut, kept empty');
      } else {
        deleteTrack(trackId);
        console.log('[Tracks] Entire track cut, deleted');
      }
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

  // Cut a region from a multi-clip track, operating on each clip's own buffer
  function cutRegionFromClips(
    track: Track,
    trackId: string,
    inPoint: number,
    outPoint: number,
    audioContext: AudioContext,
    keepTrack = false
  ): { buffer: AudioBuffer; waveformData: number[] } | null {
    const clips = track.clips!;
    const newClips: TrackClip[] = [];
    const cutContributions: { buffer: AudioBuffer; offsetInRegion: number }[] = [];
    let maxChannels = 1;
    let sampleRate = 44100;

    for (const clip of clips) {
      const clipEnd = clip.clipStart + clip.duration;

      // No overlap — keep clip unchanged
      if (clip.clipStart >= outPoint || clipEnd <= inPoint) {
        newClips.push(clip);
        continue;
      }

      const buf = clip.buffer;
      if (!buf) continue; // Skip large-file clips without buffers
      sampleRate = buf.sampleRate;
      maxChannels = Math.max(maxChannels, buf.numberOfChannels);

      // Calculate overlap in timeline coordinates
      const overlapStart = Math.max(clip.clipStart, inPoint);
      const overlapEnd = Math.min(clipEnd, outPoint);

      // Convert to clip-relative sample positions
      const relOverlapStart = overlapStart - clip.clipStart;
      const relOverlapEnd = overlapEnd - clip.clipStart;
      const oStartSample = Math.floor(relOverlapStart * buf.sampleRate);
      const oEndSample = Math.floor(relOverlapEnd * buf.sampleRate);

      // Extract the overlapping portion for the cut buffer
      const oLength = oEndSample - oStartSample;
      if (oLength > 0) {
        const oBuf = audioContext.createBuffer(buf.numberOfChannels, oLength, buf.sampleRate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const src = buf.getChannelData(ch);
          const dest = oBuf.getChannelData(ch);
          for (let i = 0; i < oLength; i++) dest[i] = src[oStartSample + i];
        }
        cutContributions.push({ buffer: oBuf, offsetInRegion: overlapStart - inPoint });
      }

      // Keep audio BEFORE the cut region (if any)
      if (oStartSample > 0) {
        const beforeBuf = audioContext.createBuffer(buf.numberOfChannels, oStartSample, buf.sampleRate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const src = buf.getChannelData(ch);
          const dest = beforeBuf.getChannelData(ch);
          for (let i = 0; i < oStartSample; i++) dest[i] = src[i];
        }
        newClips.push({
          id: generateId(),
          buffer: beforeBuf,
          waveformData: generateWaveformFromBuffer(beforeBuf),
          clipStart: clip.clipStart,
          duration: beforeBuf.duration,
        });
      }

      // Keep audio AFTER the cut region (if any)
      const afterStart = oEndSample;
      const afterLen = buf.length - afterStart;
      if (afterLen > 0) {
        const afterBuf = audioContext.createBuffer(buf.numberOfChannels, afterLen, buf.sampleRate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const src = buf.getChannelData(ch);
          const dest = afterBuf.getChannelData(ch);
          for (let i = 0; i < afterLen; i++) dest[i] = src[afterStart + i];
        }
        newClips.push({
          id: generateId(),
          buffer: afterBuf,
          waveformData: generateWaveformFromBuffer(afterBuf),
          clipStart: overlapEnd,
          duration: afterBuf.duration,
        });
      }
    }

    if (cutContributions.length === 0) return null;

    // Mix all cut portions into a single buffer
    const cutDuration = outPoint - inPoint;
    const totalSamples = Math.ceil(cutDuration * sampleRate);
    const mixedCut = audioContext.createBuffer(maxChannels, totalSamples, sampleRate);
    for (const { buffer, offsetInRegion } of cutContributions) {
      const offsetSamples = Math.floor(offsetInRegion * sampleRate);
      for (let ch = 0; ch < maxChannels; ch++) {
        const dest = mixedCut.getChannelData(ch);
        const srcCh = Math.min(ch, buffer.numberOfChannels - 1);
        const src = buffer.getChannelData(srcCh);
        for (let i = 0; i < src.length && (offsetSamples + i) < totalSamples; i++) {
          dest[offsetSamples + i] += src[i];
        }
      }
    }
    const cutWaveform = generateWaveformFromBuffer(mixedCut);

    // Update track with remaining clips
    const trackIndex = tracks.value.findIndex(t => t.id === trackId);
    if (trackIndex === -1) return { buffer: mixedCut, waveformData: cutWaveform };

    if (newClips.length === 0) {
      if (keepTrack) {
        // Clear audio but preserve the empty track shell
        if (trackIndex !== -1) {
          tracks.value[trackIndex] = {
            ...track,
            audioData: { buffer: null, waveformData: [], sampleRate, channels: maxChannels },
            clips: undefined,
            duration: 0,
          };
          tracks.value = [...tracks.value];
        }
        console.log('[Tracks] All clips cut from track, kept empty');
      } else {
        deleteTrack(trackId);
        console.log('[Tracks] All clips cut from track, deleted');
      }
      return { buffer: mixedCut, waveformData: cutWaveform };
    }

    const firstClipStart = Math.min(...newClips.map(c => c.clipStart));
    const lastClipEnd = Math.max(...newClips.map(c => c.clipStart + c.duration));

    tracks.value[trackIndex] = {
      ...track,
      clips: newClips,
      trackStart: firstClipStart,
      duration: lastClipEnd - firstClipStart,
    };
    tracks.value = [...tracks.value];

    console.log(`[Tracks] Cut region from ${clips.length} clips, ${newClips.length} clips remain`);
    return { buffer: mixedCut, waveformData: cutWaveform };
  }

  // Get all clips for a track (returns single-element array if no clips defined)
  function getTrackClips(trackId: string): TrackClip[] {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track) return [];

    if (track.clips && track.clips.length > 0) {
      return track.clips;
    }

    // During initial import phases, don't return a clip — the import waveform canvas handles rendering
    if (track.importStatus === 'importing' || track.importStatus === 'decoding') return [];

    // Need either a buffer OR waveform data with valid duration to render a clip
    const hasRenderableData = !!track.audioData.buffer
      || (track.audioData.waveformData.length > 0 && track.duration > 0);
    if (!hasRenderableData) return [];

    // Convert single audioData to a clip for uniform handling
    // Use activeDrag position if this track is being dragged, so clip moves visually
    const clipStart = (activeDrag.value?.trackId === track.id)
      ? activeDrag.value.position
      : track.trackStart;

    return [{
      id: track.id + '-main',
      buffer: track.audioData.buffer,  // null for large files
      waveformData: track.audioData.waveformData,
      clipStart,
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
        const newPosition = Math.max(0, newClipStart);
        // Write to activeDrag instead of track.trackStart so timelineDuration
        // stays stable during drag (prevents all clips from resizing)
        activeDrag.value = { trackId: track.id, position: newPosition };
        // Expand minTimelineDuration if dragging extends the timeline
        const newExtent = newPosition + track.duration;
        if (newExtent > minTimelineDuration.value) {
          minTimelineDuration.value = newExtent;
        }
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

    // Expand minTimelineDuration if dragging extends the timeline
    const newExtent = snappedStart + clip.duration;
    if (newExtent > minTimelineDuration.value) {
      minTimelineDuration.value = newExtent;
    }

    // Trigger reactivity
    tracks.value = [...tracks.value];
  }

  // Slide tracks left to fill a gap. Handles both whole tracks after the gap
  // and clips within tracks that span the gap.
  function slideTracksLeft(gapStart: number, gapDuration: number): void {
    if (gapDuration <= 0) return;
    useHistoryStore().pushState('Slide tracks');
    tracks.value = tracks.value.map(t => {
      const trackEnd = t.trackStart + t.duration;

      if (t.trackStart >= gapStart) {
        // Entire track is at/after the gap - shift everything left
        const newTrackStart = Math.max(0, t.trackStart - gapDuration);
        const newClips = t.clips?.map(c => ({
          ...c,
          clipStart: Math.max(0, c.clipStart - gapDuration),
        }));
        return { ...t, trackStart: newTrackStart, clips: newClips };
      } else if (t.clips && t.clips.length > 0 && trackEnd > gapStart) {
        // Track spans the gap - shift only clips at/after gapStart
        const newClips = t.clips.map(c => {
          if (c.clipStart >= gapStart) {
            return { ...c, clipStart: Math.max(0, c.clipStart - gapDuration) };
          }
          return c;
        });
        // Recalculate track bounds
        const firstClipStart = Math.min(...newClips.map(c => c.clipStart));
        const lastClipEnd = Math.max(...newClips.map(c => c.clipStart + c.duration));
        return {
          ...t,
          clips: newClips,
          trackStart: firstClipStart,
          duration: lastClipEnd - firstClipStart,
        };
      }
      return t;
    });
  }

  // Ripple delete: cut [inPoint, outPoint] from ALL tracks and close the gap
  function rippleDeleteRegion(
    inPoint: number,
    outPoint: number,
    audioContext: AudioContext
  ): { buffers: AudioBuffer[]; waveforms: number[][] } {
    useHistoryStore().pushState('Ripple delete');
    const gapDuration = outPoint - inPoint;
    const cutResults: { buffers: AudioBuffer[]; waveforms: number[][] } = {
      buffers: [],
      waveforms: [],
    };

    // Step 1: Cut the region from every track that overlaps [inPoint, outPoint]
    const trackIds = tracks.value.map(t => t.id);
    for (const trackId of trackIds) {
      const track = tracks.value.find(t => t.id === trackId);
      if (!track) continue;

      const trackEnd = track.trackStart + track.duration;
      // Check overlap
      if (track.trackStart >= outPoint || trackEnd <= inPoint) continue;

      const result = cutRegionFromTrack(trackId, inPoint, outPoint, audioContext, true);
      if (result) {
        cutResults.buffers.push(result.buffer);
        cutResults.waveforms.push(result.waveformData);
      }
    }

    // Step 1b: Adjust timemarks and volume envelope before sliding (uses pre-slide positions for overlap check)
    for (const t of tracks.value) {
      adjustTimemarksForCut(t.id, inPoint, outPoint);
      adjustVolumeEnvelopeForCut(t.id, inPoint, outPoint);
    }

    // Step 2: Close the gap - shift everything at/after outPoint left by gapDuration
    slideTracksLeft(outPoint, gapDuration);

    console.log(`[Tracks] Ripple deleted ${gapDuration.toFixed(2)}s region, affected ${cutResults.buffers.length} tracks`);
    return cutResults;
  }

  // Extract audio from the [inPoint, outPoint] region across ALL tracks and mix into one buffer
  function extractRegionFromAllTracks(
    inPoint: number,
    outPoint: number,
    audioContext: AudioContext
  ): { buffer: AudioBuffer; waveformData: number[] } | null {
    const regionDuration = outPoint - inPoint;
    if (regionDuration <= 0) return null;

    // Collect buffers and their offsets within the extraction region
    const contributions: { buffer: AudioBuffer; offsetInRegion: number }[] = [];
    let maxChannels = 1;
    let sampleRate = 44100;

    for (const track of tracks.value) {
      const trackEnd = track.trackStart + track.duration;
      // Check overlap
      if (track.trackStart >= outPoint || trackEnd <= inPoint) continue;

      const overlapStart = Math.max(track.trackStart, inPoint);
      const overlapEnd = Math.min(trackEnd, outPoint);
      if (overlapEnd <= overlapStart) continue;

      const buffer = track.audioData.buffer;
      if (!buffer) continue; // Empty track, skip
      sampleRate = buffer.sampleRate;
      maxChannels = Math.max(maxChannels, buffer.numberOfChannels);

      // Extract the overlapping portion from this track's buffer
      const relStart = overlapStart - track.trackStart;
      const relEnd = overlapEnd - track.trackStart;
      const startSample = Math.floor(relStart * buffer.sampleRate);
      const endSample = Math.floor(relEnd * buffer.sampleRate);
      const length = endSample - startSample;

      if (length <= 0) continue;

      const extractedBuffer = audioContext.createBuffer(
        buffer.numberOfChannels,
        length,
        buffer.sampleRate
      );
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const src = buffer.getChannelData(ch);
        const dest = extractedBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          dest[i] = src[startSample + i];
        }
      }

      contributions.push({
        buffer: extractedBuffer,
        offsetInRegion: overlapStart - inPoint,
      });
    }

    if (contributions.length === 0) return null;

    // Mix all contributions into a single buffer
    const totalSamples = Math.ceil(regionDuration * sampleRate);
    const mixedBuffer = audioContext.createBuffer(maxChannels, totalSamples, sampleRate);

    for (const { buffer, offsetInRegion } of contributions) {
      const offsetSamples = Math.floor(offsetInRegion * sampleRate);
      for (let ch = 0; ch < maxChannels; ch++) {
        const destData = mixedBuffer.getChannelData(ch);
        const srcCh = Math.min(ch, buffer.numberOfChannels - 1);
        const srcData = buffer.getChannelData(srcCh);
        for (let i = 0; i < srcData.length && (offsetSamples + i) < totalSamples; i++) {
          destData[offsetSamples + i] += srcData[i];
        }
      }
    }

    const waveformData = generateWaveformFromBuffer(mixedBuffer);
    console.log(`[Tracks] Extracted ${regionDuration.toFixed(2)}s from ${contributions.length} tracks`);
    return { buffer: mixedBuffer, waveformData };
  }

  // Finalize clip positions and recalculate track bounds after drag ends
  function finalizeClipPositions(trackId: string): void {
    const trackIndex = tracks.value.findIndex((t) => t.id === trackId);
    if (trackIndex === -1) return;

    const track = tracks.value[trackIndex];

    // Handle single-clip track: commit activeDrag position to track.trackStart
    if (!track.clips || track.clips.length === 0) {
      if (activeDrag.value?.trackId === trackId) {
        track.trackStart = activeDrag.value.position;
        activeDrag.value = null;
        tracks.value = [...tracks.value];
      }
      // Reset the timeline duration floor now that drag is complete.
      // During drag, minTimelineDuration prevents flickering, but after
      // finalization the timeline should reflect actual content bounds.
      minTimelineDuration.value = 0;
      return;
    }

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

    // Reset the timeline duration floor now that drag is complete.
    minTimelineDuration.value = 0;
  }

  // Delete a specific clip from a track
  function deleteClipFromTrack(trackId: string, clipId: string): void {
    const trackIndex = tracks.value.findIndex(t => t.id === trackId);
    if (trackIndex === -1) return;
    useHistoryStore().pushState('Delete clip');

    const track = tracks.value[trackIndex];

    // For single-buffer tracks (clipId ends with '-main'), delete entire track
    if (clipId === track.id + '-main') {
      deleteTrack(trackId);
      return;
    }

    // Multi-clip track: remove the clip
    if (!track.clips || track.clips.length === 0) return;

    const newClips = track.clips.filter(c => c.id !== clipId);

    if (newClips.length === 0) {
      // No clips left, delete the track
      deleteTrack(trackId);
      return;
    }

    // Recalculate track bounds
    const firstClipStart = Math.min(...newClips.map(c => c.clipStart));
    const lastClipEnd = Math.max(...newClips.map(c => c.clipStart + c.duration));

    tracks.value[trackIndex] = {
      ...track,
      clips: newClips,
      trackStart: firstClipStart,
      duration: lastClipEnd - firstClipStart,
    };
    tracks.value = [...tracks.value];

    // Clear clip selection if the deleted clip was selected
    if (selectedClipId.value === clipId) {
      selectedClipId.value = null;
    }

    console.log(`[Tracks] Deleted clip ${clipId} from track ${trackId}, ${newClips.length} clips remain`);
  }

  // Remove a clip from a track but ALWAYS keep the track (even if it becomes empty).
  // Used by cut operations where the clip is selected — the track should persist.
  function removeClipKeepTrack(trackId: string, clipId: string): void {
    const trackIndex = tracks.value.findIndex(t => t.id === trackId);
    if (trackIndex === -1) return;
    useHistoryStore().pushState('Remove clip (keep track)');

    const track = tracks.value[trackIndex];

    // Single-buffer track (virtual clip id = trackId + '-main'): clear audio but keep track
    if (clipId === track.id + '-main') {
      tracks.value[trackIndex] = {
        ...track,
        audioData: { buffer: null, waveformData: [], sampleRate: track.audioData.sampleRate, channels: track.audioData.channels },
        clips: undefined,
        duration: 0,
      };
      tracks.value = [...tracks.value];
      console.log(`[Tracks] Removed main audio from track ${trackId}, track preserved`);
      return;
    }

    // Multi-clip track: remove the clip
    if (!track.clips || track.clips.length === 0) return;

    const newClips = track.clips.filter(c => c.id !== clipId);

    if (newClips.length === 0) {
      // No clips left — keep track as empty
      tracks.value[trackIndex] = {
        ...track,
        clips: undefined,
        audioData: { buffer: null, waveformData: [], sampleRate: track.audioData.sampleRate, channels: track.audioData.channels },
        duration: 0,
      };
    } else {
      const firstClipStart = Math.min(...newClips.map(c => c.clipStart));
      const lastClipEnd = Math.max(...newClips.map(c => c.clipStart + c.duration));
      tracks.value[trackIndex] = {
        ...track,
        clips: newClips,
        trackStart: firstClipStart,
        duration: lastClipEnd - firstClipStart,
      };
    }
    tracks.value = [...tracks.value];

    if (selectedClipId.value === clipId) {
      selectedClipId.value = null;
    }

    console.log(`[Tracks] Removed clip ${clipId} from track ${trackId}, track preserved, ${newClips.length} clips remain`);
  }

  // Split a clip at a specific time, returning the two resulting clips
  function splitClipAtTime(
    trackId: string,
    clipId: string,
    splitTime: number,
    audioContext: AudioContext
  ): { before: TrackClip; after: TrackClip } | null {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track) return null;

    const clips = getTrackClips(trackId);
    const clip = clips.find(c => c.id === clipId);
    if (!clip) return null;

    const clipEnd = clip.clipStart + clip.duration;

    // Split point must be inside the clip (not at edges)
    if (splitTime <= clip.clipStart + 0.001 || splitTime >= clipEnd - 0.001) return null;

    const relSplit = splitTime - clip.clipStart;
    const buffer = clip.buffer;
    if (!buffer) return null; // Can't split large-file clips without buffers
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    const splitSample = Math.floor(relSplit * sampleRate);

    // Create "before" buffer
    const beforeBuffer = audioContext.createBuffer(channels, splitSample, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      const dest = beforeBuffer.getChannelData(ch);
      for (let i = 0; i < splitSample; i++) dest[i] = src[i];
    }

    // Create "after" buffer
    const afterLength = buffer.length - splitSample;
    const afterBuffer = audioContext.createBuffer(channels, afterLength, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      const dest = afterBuffer.getChannelData(ch);
      for (let i = 0; i < afterLength; i++) dest[i] = src[splitSample + i];
    }

    const beforeClip: TrackClip = {
      id: generateId(),
      buffer: beforeBuffer,
      waveformData: generateWaveformFromBuffer(beforeBuffer),
      clipStart: clip.clipStart,
      duration: beforeBuffer.duration,
    };

    const afterClip: TrackClip = {
      id: generateId(),
      buffer: afterBuffer,
      waveformData: generateWaveformFromBuffer(afterBuffer),
      clipStart: splitTime,
      duration: afterBuffer.duration,
    };

    return { before: beforeClip, after: afterClip };
  }

  // Insert a clip at the playhead position in a track, splitting existing clips if needed
  function insertClipAtPlayhead(
    trackId: string,
    buffer: AudioBuffer,
    waveformData: number[],
    playheadTime: number,
    audioContext: AudioContext
  ): boolean {
    const trackIndex = tracks.value.findIndex(t => t.id === trackId);
    if (trackIndex === -1) return false;
    useHistoryStore().pushState('Insert clip');

    const track = tracks.value[trackIndex];
    const pasteDuration = buffer.duration;

    // Get current clips (converting single-buffer track to clips if needed)
    let currentClips: TrackClip[];
    if (track.clips && track.clips.length > 0) {
      currentClips = [...track.clips];
    } else if (track.audioData.buffer) {
      // Convert main audio to a clip
      currentClips = [{
        id: generateId(),
        buffer: track.audioData.buffer,
        waveformData: track.audioData.waveformData,
        clipStart: track.trackStart,
        duration: track.duration,
      }];
    } else {
      // Empty track — start with no existing clips
      currentClips = [];
    }

    // Check if playhead falls within any existing clip - if so, split it
    const overlappingIndex = currentClips.findIndex(c =>
      playheadTime > c.clipStart + 0.001 && playheadTime < c.clipStart + c.duration - 0.001
    );

    if (overlappingIndex !== -1) {
      const overlapping = currentClips[overlappingIndex];
      const splitResult = splitClipAtTime(trackId, overlapping.id, playheadTime, audioContext);
      if (splitResult) {
        // Replace the overlapping clip with the two halves
        currentClips.splice(overlappingIndex, 1, splitResult.before, splitResult.after);
      }
    }

    // Shift all clips at/after playhead right by paste duration
    currentClips = currentClips.map(c => {
      if (c.clipStart >= playheadTime - 0.001) {
        return { ...c, clipStart: c.clipStart + pasteDuration };
      }
      return c;
    });

    // Insert the new clip at the playhead position
    const newClip: TrackClip = {
      id: generateId(),
      buffer,
      waveformData,
      clipStart: playheadTime,
      duration: pasteDuration,
    };
    currentClips.push(newClip);

    // Sort clips by position
    currentClips.sort((a, b) => a.clipStart - b.clipStart);

    // Recalculate track bounds
    const firstClipStart = Math.min(...currentClips.map(c => c.clipStart));
    const lastClipEnd = Math.max(...currentClips.map(c => c.clipStart + c.duration));

    // Shift timemarks at/after playhead right by paste duration
    const newTimemarks = track.timemarks?.map(m => {
      const absTime = track.trackStart + m.time;
      if (absTime >= playheadTime - 0.001) {
        return { ...m, time: m.time + pasteDuration };
      }
      return m;
    });

    // Shift volume envelope points at/after playhead right by paste duration
    const newEnvelope = track.volumeEnvelope?.map(p => {
      const absTime = track.trackStart + p.time;
      if (absTime >= playheadTime - 0.001) {
        return { ...p, time: p.time + pasteDuration };
      }
      return p;
    });

    tracks.value[trackIndex] = {
      ...track,
      clips: currentClips,
      timemarks: newTimemarks,
      volumeEnvelope: newEnvelope,
      trackStart: firstClipStart,
      duration: lastClipEnd - firstClipStart,
    };
    tracks.value = [...tracks.value];

    console.log(`[Tracks] Inserted ${pasteDuration.toFixed(2)}s clip at playhead ${playheadTime.toFixed(2)}s in track ${track.name}`);
    return true;
  }

  // Reset the minimum timeline duration floor (called when user manually zooms)
  function resetMinTimelineDuration(): void {
    minTimelineDuration.value = 0;
  }

  // Add a truly empty track — null buffer, zero duration, no audio at all
  function addEmptyTrack(): void {
    useHistoryStore().pushState('Add track');
    const name = `Track ${tracks.value.length + 1}`;
    const track: Track = {
      id: generateId(),
      name,
      audioData: { buffer: null, waveformData: [], sampleRate: 44100, channels: 1 },
      trackStart: 0,
      duration: 0,
      color: getNextColor(),
      muted: false,
      solo: false,
      volume: 1,
    };
    tracks.value = [...tracks.value, track];
    selectTrack(track.id);
  }

  // Create a track that's in the process of importing (no audio buffer yet)
  function createImportingTrack(
    name: string,
    metadata: { duration: number; sampleRate: number; channels: number },
    trackStart: number,
    sessionId: string,
    sourcePath?: string
  ): Track {
    useHistoryStore().pushState('Import track');

    const audioData: TrackAudioData = {
      buffer: null,
      waveformData: new Array(WAVEFORM_BUCKET_COUNT * 2).fill(0),
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
    };

    const track: Track = {
      id: generateId(),
      name,
      audioData,
      trackStart,
      duration: metadata.duration,
      color: getNextColor(),
      muted: false,
      solo: false,
      volume: 1,
      sourcePath,
      importStatus: 'importing',
      importProgress: 0,
      importSessionId: sessionId,
    };

    tracks.value = [...tracks.value, track];
    console.log('[Tracks] Created importing track:', track.name, 'session:', sessionId);
    return track;
  }

  // Update waveform data progressively during import (hot path — avoid full-array reactivity)
  function updateImportWaveform(trackId: string, chunk: WaveformChunkEvent): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = tracks.value[idx];
    if (!track.importSessionId) return;

    // Patch waveform in-place at startBucket (each bucket = 2 values: min, max)
    const waveform = track.audioData.waveformData;
    const offset = chunk.startBucket * 2;
    for (let i = 0; i < chunk.waveform.length && offset + i < waveform.length; i++) {
      waveform[offset + i] = chunk.waveform[i];
    }
    track.importProgress = chunk.progress;
    // Single shallow trigger — replace just this slot
    tracks.value[idx] = { ...track };
  }

  // Finalize waveform after Rust decode completes (corrects VBR duration estimates)
  function finalizeImportWaveform(trackId: string, finalWaveform: number[], actualDuration: number): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = tracks.value[idx];

    console.log(`[Tracks] finalizeImportWaveform: track=${track.name}, oldDuration=${track.duration.toFixed(2)}, newDuration=${actualDuration.toFixed(2)}, statusKept=${(['ready', 'large-file', 'caching'] as ImportStatus[]).includes(track.importStatus!)}`);
    tracks.value[idx] = {
      ...track,
      audioData: { ...track.audioData, waveformData: finalWaveform },
      duration: actualDuration,
      // If buffer already set (status 'ready'), keep it — don't regress to 'decoding'
      importStatus: (['ready', 'large-file', 'caching'] as ImportStatus[]).includes(track.importStatus!)
        ? track.importStatus!
        : 'decoding' as ImportStatus,
      importProgress: 1,
      importSessionId: undefined, // waveform session done
    };
    tracks.value = [...tracks.value];
  }

  // Update decode/fetch progress (hot path ~60Hz — mutate in-place, no array copy)
  function updateImportDecodeProgress(trackId: string, progress: number): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = tracks.value[idx];
    if (!track.importStatus || track.importStatus === 'ready') return;
    track.importDecodeProgress = progress;
  }

  // Set the AudioBuffer after browser decode completes
  function setImportBuffer(trackId: string, buffer: AudioBuffer): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = tracks.value[idx];

    console.log(`[Tracks] setImportBuffer: track=${track.name}, oldDuration=${track.duration.toFixed(2)}, newDuration=${buffer.duration.toFixed(2)}, oldStatus=${track.importStatus}, newStatus=ready`);
    tracks.value[idx] = {
      ...track,
      audioData: {
        ...track.audioData,
        buffer,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
      },
      duration: buffer.duration,
      importStatus: 'ready' as ImportStatus,
      importProgress: undefined,
      importDecodeProgress: undefined,
    };
    tracks.value = [...tracks.value];
  }

  // Mark a track as too large for browser decode (waveform still works)
  function setImportLargeFile(trackId: string): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = tracks.value[idx];

    tracks.value[idx] = {
      ...track,
      importStatus: 'large-file' as ImportStatus,
      importProgress: undefined,
      importDecodeProgress: undefined,
    };
    tracks.value = [...tracks.value];
  }

  // Transition from 'large-file' to 'caching' — shows progress bar
  function setImportCaching(trackId: string): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    tracks.value[idx] = {
      ...tracks.value[idx],
      importStatus: 'caching' as ImportStatus,
      importDecodeProgress: 0,
    };
    tracks.value = [...tracks.value];
  }

  // Set cached audio path and mark import as ready
  function setCachedAudioPath(trackId: string, cachedPath: string): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    tracks.value[idx] = {
      ...tracks.value[idx],
      cachedAudioPath: cachedPath,
      importStatus: 'ready' as ImportStatus,
      importDecodeProgress: undefined,
    };
    tracks.value = [...tracks.value];
  }

  function setHasPeakPyramid(trackId: string): void {
    const idx = tracks.value.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    tracks.value[idx] = { ...tracks.value[idx], hasPeakPyramid: true };
    tracks.value = [...tracks.value];
  }

  /** Add a timemark to any track (not just during recording) */
  function addTimemark(trackId: string, time: number, label: string, source: 'manual' | 'auto' = 'manual'): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track) return;

    const historyStore = useHistoryStore();
    historyStore.pushState('Add marker');

    if (!track.timemarks) track.timemarks = [];
    track.timemarks.push({
      id: generateId(),
      time,
      label,
      source,
      color: source === 'manual' ? '#00d4ff' : '#fbbf24',
    });
  }

  /** Update a timemark's time (for drag) — no history push (caller handles it at drag start) */
  function updateTimemarkTime(trackId: string, timemarkId: string, newTime: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track || !track.timemarks) return;

    const mark = track.timemarks.find(m => m.id === timemarkId);
    if (mark) {
      mark.time = Math.max(0, newTime);
    }
  }

  function removeTrackTimemark(trackId: string, timemarkId: string): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.timemarks) return;

    const historyStore = useHistoryStore();
    historyStore.pushState('Remove marker');

    track.timemarks = track.timemarks.filter(m => m.id !== timemarkId);
  }

  /**
   * Adjust timemarks after a cut (ripple): remove marks in [cutStart, cutEnd),
   * shift marks after cutEnd left by gapDuration.
   * Skips tracks that don't overlap the cut region (prevents double-shift with slideTracksLeft).
   */
  function adjustTimemarksForCut(trackId: string, cutStart: number, cutEnd: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.timemarks || track.timemarks.length === 0) return;

    const trackEnd = track.trackStart + track.duration;
    // Skip tracks that don't overlap the cut region
    if (track.trackStart >= cutEnd || trackEnd <= cutStart) return;

    const gapDuration = cutEnd - cutStart;
    track.timemarks = track.timemarks
      .filter(m => {
        const absTime = track.trackStart + m.time;
        return absTime < cutStart || absTime >= cutEnd;
      })
      .map(m => {
        const absTime = track.trackStart + m.time;
        if (absTime >= cutEnd) {
          return { ...m, time: m.time - gapDuration };
        }
        return m;
      });
  }

  /**
   * Adjust timemarks after a delete (no ripple): remove marks in [deleteStart, deleteEnd).
   * Gap stays open, so no shifting.
   */
  function adjustTimemarksForDelete(trackId: string, deleteStart: number, deleteEnd: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.timemarks || track.timemarks.length === 0) return;

    track.timemarks = track.timemarks.filter(m => {
      const absTime = track.trackStart + m.time;
      return absTime < deleteStart || absTime >= deleteEnd;
    });
  }

  /**
   * Adjust timemarks after an insert: shift marks at/after insertPoint right by insertDuration.
   */
  function adjustTimemarksForInsert(trackId: string, insertPoint: number, insertDuration: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.timemarks || track.timemarks.length === 0) return;

    track.timemarks = track.timemarks.map(m => {
      const absTime = track.trackStart + m.time;
      if (absTime >= insertPoint - 0.001) {
        return { ...m, time: m.time + insertDuration };
      }
      return m;
    });
  }

  // ── Volume Automation Envelope ──

  /** Interpolate a value from a sorted envelope at a given time. */
  function interpolateEnvelope(envelope: VolumeAutomationPoint[], fallback: number, time: number): number {
    if (!envelope || envelope.length === 0) return fallback;
    if (time <= envelope[0].time) return envelope[0].value;
    if (time >= envelope[envelope.length - 1].time) return envelope[envelope.length - 1].value;

    // Binary search for the segment containing `time`
    const idx = binarySearch(envelope, time, p => p.time);
    // idx is the insertion point — the first element >= time
    if (idx >= envelope.length) return envelope[envelope.length - 1].value;
    if (idx === 0) return envelope[0].value;

    const a = envelope[idx - 1];
    const b = envelope[idx];
    const t = (time - a.time) / (b.time - a.time);
    return a.value + (b.value - a.value) * t;
  }

  /** Add a keyframe to a track's volume envelope. */
  function addVolumePoint(trackId: string, time: number, value: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track) return;
    useHistoryStore().pushState('Add volume point');

    if (!track.volumeEnvelope) track.volumeEnvelope = [];
    track.volumeEnvelope.push({
      id: generateId(),
      time,
      value: Math.max(0, Math.min(MAX_VOLUME_LINEAR, value)),
    });
    track.volumeEnvelope.sort((a, b) => a.time - b.time);
  }

  /** Update a keyframe's position/value (no history — drag convention). */
  function updateVolumePoint(trackId: string, pointId: string, time: number, value: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.volumeEnvelope) return;

    const point = track.volumeEnvelope.find(p => p.id === pointId);
    if (point) {
      point.time = Math.max(0, time);
      point.value = Math.max(0, Math.min(MAX_VOLUME_LINEAR, value));
      track.volumeEnvelope.sort((a, b) => a.time - b.time);
    }
  }

  /** Remove a keyframe from a track's volume envelope. */
  function removeVolumePoint(trackId: string, pointId: string): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.volumeEnvelope) return;
    useHistoryStore().pushState('Remove volume point');
    track.volumeEnvelope = track.volumeEnvelope.filter(p => p.id !== pointId);
  }

  /** Get interpolated volume at a specific time, falling back to track.volume. */
  function getVolumeAtTime(trackId: string, time: number): number {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track) return 1;
    return interpolateEnvelope(track.volumeEnvelope ?? [], track.volume, time);
  }

  /** Adjust envelope after a cut (ripple): remove points in [cutStart, cutEnd), shift after left. */
  function adjustVolumeEnvelopeForCut(trackId: string, cutStart: number, cutEnd: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.volumeEnvelope || track.volumeEnvelope.length === 0) return;

    const trackEnd = track.trackStart + track.duration;
    if (track.trackStart >= cutEnd || trackEnd <= cutStart) return;

    const gapDuration = cutEnd - cutStart;
    track.volumeEnvelope = track.volumeEnvelope
      .filter(p => {
        const absTime = track.trackStart + p.time;
        return absTime < cutStart || absTime >= cutEnd;
      })
      .map(p => {
        const absTime = track.trackStart + p.time;
        if (absTime >= cutEnd) {
          return { ...p, time: p.time - gapDuration };
        }
        return p;
      });
  }

  /** Adjust envelope after a delete (no ripple): remove points in [deleteStart, deleteEnd). */
  function adjustVolumeEnvelopeForDelete(trackId: string, deleteStart: number, deleteEnd: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.volumeEnvelope || track.volumeEnvelope.length === 0) return;

    track.volumeEnvelope = track.volumeEnvelope.filter(p => {
      const absTime = track.trackStart + p.time;
      return absTime < deleteStart || absTime >= deleteEnd;
    });
  }

  /** Adjust envelope after an insert: shift points at/after insertPoint right by insertDuration. */
  function adjustVolumeEnvelopeForInsert(trackId: string, insertPoint: number, insertDuration: number): void {
    const track = tracks.value.find(t => t.id === trackId);
    if (!track?.volumeEnvelope || track.volumeEnvelope.length === 0) return;

    track.volumeEnvelope = track.volumeEnvelope.map(p => {
      const absTime = track.trackStart + p.time;
      if (absTime >= insertPoint - 0.001) {
        return { ...p, time: p.time + insertDuration };
      }
      return p;
    });
  }

  return {
    tracks,
    selectedTrackId,
    selectedClipId,
    viewMode,
    selectedTrack,
    selectedClip,
    timelineDuration,
    hasAudio,
    createTrackFromBuffer,
    deleteTrack,
    clearTrackAudio,
    selectTrack,
    selectClip,
    clearClipSelection,
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
    slideTracksLeft,
    rippleDeleteRegion,
    extractRegionFromAllTracks,
    finalizeClipPositions,
    deleteClipFromTrack,
    removeClipKeepTrack,
    splitClipAtTime,
    insertClipAtPlayhead,
    addEmptyTrack,
    resetMinTimelineDuration,
    activeDrag,
    addTimemark,
    updateTimemarkTime,
    removeTrackTimemark,
    adjustTimemarksForCut,
    adjustTimemarksForDelete,
    adjustTimemarksForInsert,
    interpolateEnvelope,
    addVolumePoint,
    updateVolumePoint,
    removeVolumePoint,
    getVolumeAtTime,
    adjustVolumeEnvelopeForCut,
    adjustVolumeEnvelopeForDelete,
    adjustVolumeEnvelopeForInsert,
    createImportingTrack,
    updateImportWaveform,
    finalizeImportWaveform,
    updateImportDecodeProgress,
    setImportBuffer,
    setImportLargeFile,
    setImportCaching,
    setCachedAudioPath,
    setHasPeakPyramid,
  };
});
