import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Track } from '@/shared/types';
import { useAudioStore } from './audio';
import { useSelectionStore } from './selection';
import { generateId } from '@/shared/utils';

export const useTracksStore = defineStore('tracks', () => {
  const audioStore = useAudioStore();
  const selectionStore = useSelectionStore();

  const tracks = ref<Track[]>([]);
  const selectedTrackId = ref<string | null>(null);

  const mainTrack = computed(() => tracks.value.find((t) => t.type === 'full'));
  const clipTracks = computed(() => tracks.value.filter((t) => t.type === 'clip'));
  const selectedTrack = computed(() =>
    tracks.value.find((t) => t.id === selectedTrackId.value)
  );

  function initMainTrack(): void {
    if (!audioStore.currentFile) return;

    tracks.value = [
      {
        id: generateId(),
        name: 'Full Audio',
        audioId: audioStore.currentFile.id,
        type: 'full',
        start: 0,
        end: audioStore.duration,
        trackStart: 0,
        muted: false,
        solo: false,
        volume: 1,
      },
    ];
    selectedTrackId.value = tracks.value[0].id;
  }

  function createClip(): Track | null {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) return null;
    if (!audioStore.currentFile) return null;

    const clipNumber = clipTracks.value.length + 1;

    const clip: Track = {
      id: generateId(),
      name: `Clip ${clipNumber}`,
      audioId: audioStore.currentFile.id,
      type: 'clip',
      start: inPoint,
      end: outPoint,
      trackStart: inPoint,
      muted: false,
      solo: false,
      volume: 1,
    };

    tracks.value.push(clip);

    const main = mainTrack.value;
    if (main) {
      main.muted = true;
    }

    selectionStore.clearInOutPoints();
    selectedTrackId.value = clip.id;

    return clip;
  }

  function deleteTrack(trackId: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (!track || track.type === 'full') return;

    tracks.value = tracks.value.filter((t) => t.id !== trackId);

    if (clipTracks.value.length === 0) {
      const main = mainTrack.value;
      if (main) {
        main.muted = false;
      }
    }

    if (selectedTrackId.value === trackId) {
      selectedTrackId.value = mainTrack.value?.id ?? null;
    }
  }

  function setTrackMuted(trackId: string, muted: boolean): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.muted = muted;
    }
  }

  function setTrackSolo(trackId: string, solo: boolean): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.solo = solo;
    }
  }

  function setTrackVolume(trackId: string, volume: number): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.volume = Math.max(0, Math.min(1, volume));
    }
  }

  function selectTrack(trackId: string): void {
    selectedTrackId.value = trackId;
  }

  function renameTrack(trackId: string, name: string): void {
    const track = tracks.value.find((t) => t.id === trackId);
    if (track) {
      track.name = name;
    }
  }

  function clearTracks(): void {
    tracks.value = [];
    selectedTrackId.value = null;
  }

  function addTrack(track: Track): void {
    tracks.value.push(track);
  }

  function reorderTrack(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= tracks.value.length) return;
    if (toIndex < 0 || toIndex >= tracks.value.length) return;
    if (fromIndex === toIndex) return;

    const [movedTrack] = tracks.value.splice(fromIndex, 1);
    tracks.value.splice(toIndex, 0, movedTrack);
  }

  function createSpeechSegmentTracks(segments: Array<{ start: number; end: number }>): Track[] {
    if (!audioStore.currentFile || segments.length === 0) return [];

    const newTracks: Track[] = [];
    const baseNumber = clipTracks.value.length + 1;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clip: Track = {
        id: generateId(),
        name: `Speech ${baseNumber + i}`,
        audioId: audioStore.currentFile.id,
        type: 'clip',
        start: seg.start,
        end: seg.end,
        trackStart: seg.start,
        muted: false,
        solo: false,
        volume: 1,
      };
      newTracks.push(clip);
    }

    tracks.value.push(...newTracks);

    // Mute main track
    const main = mainTrack.value;
    if (main) {
      main.muted = true;
    }

    // Select the first new track
    if (newTracks.length > 0) {
      selectedTrackId.value = newTracks[0].id;
    }

    return newTracks;
  }

  function deleteSpeechSegmentTracks(): void {
    // Delete all clip tracks that are speech segments (named "Speech X")
    tracks.value = tracks.value.filter((t) => t.type === 'full' || !t.name.startsWith('Speech '));

    // If no clips remain, unmute main
    if (clipTracks.value.length === 0) {
      const main = mainTrack.value;
      if (main) {
        main.muted = false;
      }
    }

    selectedTrackId.value = mainTrack.value?.id ?? null;
  }

  function getActiveTracksAtTime(time: number): Track[] {
    return tracks.value.filter((track) => {
      if (track.muted) return false;

      const hasSolo = tracks.value.some((t) => t.solo);
      if (hasSolo && !track.solo) return false;

      if (track.type === 'full') {
        const isClipped = clipTracks.value.some(
          (clip) => !clip.muted && time >= clip.start && time < clip.end
        );
        return !isClipped;
      }

      return time >= track.start && time < track.end;
    });
  }

  return {
    tracks,
    selectedTrackId,
    mainTrack,
    clipTracks,
    selectedTrack,
    initMainTrack,
    createClip,
    deleteTrack,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
    selectTrack,
    renameTrack,
    clearTracks,
    addTrack,
    reorderTrack,
    getActiveTracksAtTime,
    createSpeechSegmentTracks,
    deleteSpeechSegmentTracks,
  };
});
