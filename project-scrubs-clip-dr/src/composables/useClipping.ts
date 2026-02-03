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

  const canCreateClip = computed(() => selectionStore.hasInOutPoints && tracksStore.selectedTrack !== null);

  // Create a new track from the audio between in/out points
  function createClip(): Track | null {
    const selectedTrack = tracksStore.selectedTrack;
    if (!selectedTrack) {
      console.log('[Clipping] No track selected');
      return null;
    }

    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) {
      console.log('[Clipping] In/Out points not set');
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

    // Create new track at current playhead position
    const clipName = `Clip ${tracksStore.tracks.length + 1}`;
    const newTrack = tracksStore.createTrackFromBuffer(
      newBuffer,
      waveformData,
      clipName,
      playbackStore.currentTime
    );

    console.log(`[Clipping] Created clip from ${relativeStart.toFixed(2)}s - ${relativeEnd.toFixed(2)}s at playhead ${playbackStore.currentTime.toFixed(2)}s`);
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
