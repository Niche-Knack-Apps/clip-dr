import { computed } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { encodeWavFloat32 } from '@/shared/audio-utils';
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

  // Clip is available whenever in/out points are set and any track overlaps the region
  const canCreateClip = computed(() => {
    if (!selectionStore.hasInOutPoints) return false;
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) return false;
    return tracksStore.tracks.some(t =>
      t.trackStart < outPoint && t.trackStart + t.duration > inPoint
    );
  });

  // Create a new track from audio across ALL tracks between in/out points
  function createClip(): Track | null {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) {
      console.log('[Clipping] In/Out points not set');
      return null;
    }

    const ctx = audioStore.getAudioContext();
    const extracted = tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx);
    if (!extracted) {
      console.log('[Clipping] No audio found in I/O region');
      return null;
    }

    // Place the clip at the in-point so it lines up with the original audio position
    const clipName = `Clip ${tracksStore.tracks.length + 1}`;
    const newTrack = tracksStore.createTrackFromBuffer(
      extracted.buffer,
      extracted.waveformData,
      clipName,
      inPoint
    );

    // Write temp WAV so Rust playback engine can access this clip
    const cachePromise = cacheClipForPlayback(newTrack.id, extracted.buffer);
    tracksStore.setPendingRecache(cachePromise);

    // Mute source tracks that contributed audio to the clip
    for (const t of tracksStore.tracks) {
      if (t.id === newTrack.id) continue;
      if (t.trackStart < outPoint && t.trackStart + t.duration > inPoint) {
        tracksStore.setTrackMuted(t.id, true);
      }
    }

    // Position playhead at the beginning of the new clip
    playbackStore.seek(inPoint);
    console.log(`[Clipping] Created clip (${(outPoint - inPoint).toFixed(2)}s) at timeline ${inPoint.toFixed(2)}s`);
    return newTrack;
  }

  // Write a clip's AudioBuffer to a temp WAV and set cachedAudioPath for Rust playback
  async function cacheClipForPlayback(trackId: string, buffer: AudioBuffer): Promise<void> {
    try {
      const wavData = encodeWavFloat32(buffer);
      const fileName = `clip_${trackId}_${Date.now()}.wav`;
      await writeFile(fileName, wavData, { baseDir: BaseDirectory.Temp });
      const tmpDir = await tempDir();
      const cachedPath = `${tmpDir}${tmpDir.endsWith('/') ? '' : '/'}${fileName}`;
      tracksStore.setCachedAudioPath(trackId, cachedPath);
      console.log(`[Clipping] Cached clip WAV for Rust playback: ${cachedPath}`);
    } catch (err) {
      console.error('[Clipping] Failed to cache clip WAV:', err);
    }
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

  function setTrackVolume(trackId: string, volume: number, skipHistory = false): void {
    tracksStore.setTrackVolume(trackId, volume, skipHistory);
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
