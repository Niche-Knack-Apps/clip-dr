import { computed, nextTick } from 'vue';
import { useTracksStore } from '@/stores/tracks';
import { useSelectionStore } from '@/stores/selection';
import { useAudioStore } from '@/stores/audio';
import { usePlaybackStore } from '@/stores/playback';
import { useHistoryStore } from '@/stores/history';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { generateId } from '@/shared/utils';
import type { Track, TrackClip } from '@/shared/types';
import { TRACK_COLORS } from '@/shared/types';

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
  // Inserts directly below the current track and mutes all other tracks (solo behavior)
  async function createClip(): Promise<Track | null> {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) {
      console.log('[Clipping] In/Out points not set');
      return null;
    }

    const historyStore = useHistoryStore();
    historyStore.beginBatch('Create clip');
    try {
      // Detect large files (same check as clipboard.cut)
      const hasLargeFile = tracksStore.tracks.some(t => {
        const trackEnd = t.trackStart + t.duration;
        if (t.trackStart >= outPoint || trackEnd <= inPoint) return false;
        return !t.audioData.buffer;
      });

      let newTrack: Track;

      if (hasLargeFile) {
        // Large file: create EDL track with virtual references (instant, no extraction)
        const segments = tracksStore.collectVirtualClipboardSegments(inPoint, outPoint);
        if (segments.length === 0) {
          console.log('[Clipping] No segments found in I/O region');
          return null;
        }
        const { sampleRate, channels } = tracksStore.getContributingFormat(inPoint, outPoint);
        const waveform = tracksStore.sliceWaveformForRegion(inPoint, outPoint);
        const clipName = `Clip ${tracksStore.tracks.length + 1}`;
        const totalDuration = outPoint - inPoint;

        // Build EDL clips from virtual segments
        const clips: TrackClip[] = segments.map(seg => ({
          id: generateId(),
          buffer: null,
          waveformData: [] as number[],
          clipStart: inPoint + seg.offsetInRegion,
          duration: seg.duration,
          sourceFile: seg.sourceFile,
          sourceOffset: seg.sourceOffset,
        }));

        // Distribute waveform data across clips proportionally
        const bucketCount = waveform.length / 2;
        for (let i = 0; i < clips.length; i++) {
          const seg = segments[i];
          const startFrac = seg.offsetInRegion / totalDuration;
          const endFrac = (seg.offsetInRegion + seg.duration) / totalDuration;
          const startBucket = Math.floor(startFrac * bucketCount);
          const endBucket = Math.ceil(endFrac * bucketCount);
          clips[i].waveformData = waveform.slice(startBucket * 2, endBucket * 2);
        }

        newTrack = {
          id: generateId(),
          name: clipName,
          audioData: { buffer: null, waveformData: waveform, sampleRate, channels },
          trackStart: inPoint,
          duration: totalDuration,
          color: TRACK_COLORS[tracksStore.tracks.length % TRACK_COLORS.length],
          muted: false,
          solo: false,
          volume: 1,
          clips,
          sourcePath: segments[0]?.sourceFile,
        };

        console.log(`[Clipping] Created EDL clip "${clipName}" (${totalDuration.toFixed(2)}s) with ${segments.length} segment(s)`);
      } else {
        // Small file: extract audio AND create EDL clips for save/load round-trip
        const segments = tracksStore.collectVirtualClipboardSegments(inPoint, outPoint);
        const ctx = audioStore.getAudioContext();
        const extracted = await tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx);
        if (!extracted) {
          console.log('[Clipping] No audio found in I/O region');
          return null;
        }
        const clipName = `Clip ${tracksStore.tracks.length + 1}`;
        const totalDuration = outPoint - inPoint;
        const waveform = extracted.waveformData;

        // Build EDL clips from segments (mirrors the large-file path)
        const clips: TrackClip[] = segments.map(seg => ({
          id: generateId(),
          buffer: null,
          waveformData: [] as number[],
          clipStart: inPoint + seg.offsetInRegion,
          duration: seg.duration,
          sourceFile: seg.sourceFile,
          sourceOffset: seg.sourceOffset,
        }));

        // Distribute waveform across clips proportionally
        if (clips.length > 0) {
          const bucketCount = waveform.length / 2;
          for (let i = 0; i < clips.length; i++) {
            const seg = segments[i];
            const startFrac = seg.offsetInRegion / totalDuration;
            const endFrac = (seg.offsetInRegion + seg.duration) / totalDuration;
            const startBucket = Math.floor(startFrac * bucketCount);
            const endBucket = Math.ceil(endFrac * bucketCount);
            clips[i].waveformData = waveform.slice(startBucket * 2, endBucket * 2);
          }
        }

        // Derive sourcePath from segments or contributing track
        const contributingTrack = tracksStore.tracks.find(t =>
          t.trackStart < outPoint && t.trackStart + t.duration > inPoint
        );
        newTrack = {
          id: generateId(),
          name: clipName,
          audioData: {
            buffer: extracted.buffer,
            waveformData: waveform,
            sampleRate: extracted.buffer.sampleRate,
            channels: extracted.buffer.numberOfChannels,
          },
          trackStart: inPoint,
          duration: totalDuration,
          color: TRACK_COLORS[tracksStore.tracks.length % TRACK_COLORS.length],
          muted: false,
          solo: false,
          volume: 1,
          clips: clips.length > 0 ? clips : undefined,
          sourcePath: segments[0]?.sourceFile || contributingTrack?.sourcePath || contributingTrack?.cachedAudioPath,
        };
      }

      // Mute all existing tracks (within batch so undo restores mute states)
      for (const track of tracksStore.tracks) {
        if (!track.muted) {
          tracksStore.setTrackMuted(track.id, true);
        }
      }

      // Insert below current selected track
      const currentTrackId = tracksStore.selectedTrackId;
      let insertIndex = tracksStore.tracks.length;
      if (currentTrackId && currentTrackId !== 'ALL') {
        const idx = tracksStore.tracks.findIndex(t => t.id === currentTrackId);
        if (idx !== -1) insertIndex = idx + 1;
      }

      tracksStore.insertTrackAtIndex(newTrack, insertIndex);

      // Only cache WAV for small-file clips; EDL clips use sourceFile/sourceOffset
      if (newTrack.audioData.buffer) {
        const cachePromise = cacheClipForPlayback(newTrack.id, newTrack.audioData.buffer);
        tracksStore.setPendingRecache(cachePromise);
      }

      playbackStore.seek(inPoint);
      selectionStore.clearInOutPoints(); // Clear immediately (visual feedback)

      // EditorView's tracks.length watcher resets selection to [0, timelineDuration]
      // asynchronously (via its own nextTick). Wait two cycles to run after it.
      await nextTick(); // Yield: EditorView watcher starts and registers its nextTick
      await nextTick(); // Yield: watcher continuation resets selection first, then we override
      selectionStore.setSelection(inPoint, outPoint);

      return newTrack;
    } finally {
      historyStore.endBatch();
    }
  }

  // Write a clip's AudioBuffer to a temp WAV and set cachedAudioPath for Rust playback
  async function cacheClipForPlayback(trackId: string, buffer: AudioBuffer): Promise<void> {
    try {
      const wavData = await encodeWavFloat32InWorker(buffer);
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
