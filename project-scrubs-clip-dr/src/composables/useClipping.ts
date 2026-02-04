import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import type { Track } from '@/shared/types';

export function useClipping() {
  const tracksStore = useTracksStore();
  const selectionStore = useSelectionStore();
  const audioStore = useAudioStore();
  const playbackStore = usePlaybackStore();

  const tracks = computed(() => tracksStore.tracks);
  const selectedTrack = computed(() => tracksStore.selectedTrack);
  const selectedTrackId = computed(() => tracksStore.selectedTrackId);
  const viewMode = computed(() => tracksStore.viewMode);

  // Clip is available whenever in/out points are set and there's a usable track
  const canCreateClip = computed(() => {
    if (!selectionStore.hasInOutPoints) return false;
    // Allow clipping from the selected track, or from any overlapping track when 'ALL' is selected
    if (tracksStore.selectedTrack !== null) return true;
    // When 'ALL' or no specific track selected, check if any track overlaps the in/out region
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) return false;
    return tracksStore.tracks.some(t =>
      t.audioData.buffer && t.trackStart < outPoint && t.trackStart + t.duration > inPoint
    );
  });

  // Find the best track to clip from: selected track, or the first overlapping track
  function findClipSourceTrack(): Track | null {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) return null;

    // Prefer the explicitly selected track
    if (tracksStore.selectedTrack) return tracksStore.selectedTrack;

    // Otherwise find the first track that overlaps the in/out region
    return tracksStore.tracks.find(t =>
      t.audioData.buffer && t.trackStart < outPoint && t.trackStart + t.duration > inPoint
    ) ?? null;
  }

  // Create a new track from the audio between in/out points
  function createClip(): Track | null {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) {
      console.log('[Clipping] In/Out points not set');
      return null;
    }

    const selectedTrack = findClipSourceTrack();
    if (!selectedTrack) {
      console.log('[Clipping] No track found overlapping in/out region');
      return null;
    }

    const buffer = selectedTrack.audioData.buffer;
    if (!buffer) {
      console.log('[Clipping] No audio buffer in selected track');
      return null;
    }

    // In/out points are in timeline time - convert to track-relative time
    const trackStart = selectedTrack.trackStart;
    const relativeStart = Math.max(0, inPoint - trackStart);
    const relativeEnd = Math.min(selectedTrack.duration, outPoint - trackStart);

    if (relativeEnd <= relativeStart) {
      console.log('[Clipping] Invalid region: relativeStart=', relativeStart, 'relativeEnd=', relativeEnd);
      return null;
    }

    const startSample = Math.floor(relativeStart * buffer.sampleRate);
    const endSample = Math.floor(relativeEnd * buffer.sampleRate);
    const sampleCount = endSample - startSample;

    if (sampleCount <= 0) {
      console.log('[Clipping] Invalid sample range');
      return null;
    }

    // Extract samples from each channel
    const ctx = audioStore.getAudioContext();
    const newBuffer = ctx.createBuffer(
      buffer.numberOfChannels,
      sampleCount,
      buffer.sampleRate
    );

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channelData = buffer.getChannelData(ch);
      const newChannelData = newBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i++) {
        newChannelData[i] = channelData[startSample + i];
      }
    }

    // Generate waveform for the clipped region
    const waveformData = tracksStore.generateWaveformFromBuffer(newBuffer);

    // Place the clip at the in-point so it lines up with the original audio position
    const clipName = `Clip ${tracksStore.tracks.length + 1}`;
    const newTrack = tracksStore.createTrackFromBuffer(
      newBuffer,
      waveformData,
      clipName,
      inPoint
    );

    console.log(`[Clipping] Created clip from ${relativeStart.toFixed(2)}s - ${relativeEnd.toFixed(2)}s at timeline ${inPoint.toFixed(2)}s`);
    return newTrack;
  }

  function deleteTrack(trackId: string): void {
    tracksStore.deleteTrack(trackId);
  }

  function deleteSelectedTrack(): void {
    if (selectedTrackId.value && selectedTrackId.value !== 'ALL') {
      tracksStore.deleteTrack(selectedTrackId.value);
    }
  }

  function selectTrack(trackId: string | 'ALL'): void {
    tracksStore.selectTrack(trackId);
  }

  function setTrackMuted(trackId: string, muted: boolean): void {
    tracksStore.setTrackMuted(trackId, muted);
  }

  function setTrackSolo(trackId: string, solo: boolean): void {
    tracksStore.setTrackSolo(trackId, solo);
  }

  function setTrackVolume(trackId: string, volume: number): void {
    tracksStore.setTrackVolume(trackId, volume);
  }

  function renameTrack(trackId: string, name: string): void {
    tracksStore.renameTrack(trackId, name);
  }

  function toggleMute(trackId: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      tracksStore.setTrackMuted(trackId, !track.muted);
    }
  }

  function toggleSolo(trackId: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      tracksStore.setTrackSolo(trackId, !track.solo);
    }
  }

  function getActiveTracksAtTime(time: number): Track[] {
    return tracksStore.getActiveTracksAtTime(time);
  }

  function reorderTrack(fromIndex: number, toIndex: number): void {
    tracksStore.reorderTrack(fromIndex, toIndex);
  }

  return {
    tracks,
    selectedTrack,
    selectedTrackId,
    viewMode,
    canCreateClip,
    createClip,
    deleteTrack,
    deleteSelectedTrack,
    selectTrack,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
    renameTrack,
    toggleMute,
    toggleSolo,
    getActiveTracksAtTime,
    reorderTrack,
  };
}
