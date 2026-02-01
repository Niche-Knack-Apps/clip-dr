import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import type { Track } from '@/shared/types';

export function useClipping() {
  const tracksStore = useTracksStore();
  const selectionStore = useSelectionStore();

  const tracks = computed(() => tracksStore.tracks);
  const mainTrack = computed(() => tracksStore.mainTrack);
  const clipTracks = computed(() => tracksStore.clipTracks);
  const selectedTrack = computed(() => tracksStore.selectedTrack);
  const selectedTrackId = computed(() => tracksStore.selectedTrackId);

  const canCreateClip = computed(() => selectionStore.hasInOutPoints);

  function createClip(): Track | null {
    return tracksStore.createClip();
  }

  function deleteTrack(trackId: string): void {
    tracksStore.deleteTrack(trackId);
  }

  function deleteSelectedTrack(): void {
    if (selectedTrackId.value && selectedTrack.value?.type === 'clip') {
      tracksStore.deleteTrack(selectedTrackId.value);
    }
  }

  function selectTrack(trackId: string): void {
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
    mainTrack,
    clipTracks,
    selectedTrack,
    selectedTrackId,
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
