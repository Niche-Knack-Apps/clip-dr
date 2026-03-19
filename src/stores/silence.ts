import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeTempFile } from '@/shared/fs-utils';
import type { SilenceRegion, Track } from '@/shared/types';
import { loadAudioFromFile } from '@/shared/audio-utils';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { useVadStore } from './vad';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { usePlaybackStore } from './playback';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useHistoryStore } from './history';
import { generateId } from '@/shared/utils';

interface CutAudioData {
  path: string;
  buffer: AudioBuffer;
  waveformData: number[];
  duration: number;
  sampleRate: number;
}

interface CutAudioEntry extends CutAudioData {
  // Store the silence regions that were cut for time mapping
  cutRegions: Array<{ start: number; end: number }>;
}

/** Special key for legacy silence regions from v2 multitrack projects that need reassignment */
export const UNASSIGNED_TRACK_KEY = '_unassigned';

export const useSilenceStore = defineStore('silence', () => {
  const vadStore = useVadStore();
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();

  // Per-track silence regions: Map<trackId, SilenceRegion[]>
  const silenceRegions = ref<Map<string, SilenceRegion[]>>(new Map());
  const compressionEnabled = ref(false);
  const cutting = ref(false);
  const cutError = ref<string | null>(null);

  // Map of trackId -> cut audio data (silence removed)
  const cutAudioFiles = ref<Map<string, CutAudioEntry>>(new Map());

  // Minimum region duration in seconds
  const MIN_REGION_DURATION = 0.05;

  // Get regions for a specific track
  function getRegionsForTrack(trackId: string): SilenceRegion[] {
    return silenceRegions.value.get(trackId) ?? [];
  }

  // Get only enabled (active) silence regions for a track
  function getActiveRegionsForTrack(trackId: string): SilenceRegion[] {
    return getRegionsForTrack(trackId).filter(r => r.enabled);
  }

  // Backward-compat computed: get active regions for the current track
  // (used by playback and other stores that need single-track context)
  const activeSilenceRegions = computed(() => {
    const trackId = tracksStore.selectedTrack?.id;
    if (!trackId) return [];
    return getActiveRegionsForTrack(trackId);
  });

  // Calculate compressed duration for a specific track
  function compressedDurationForTrack(trackId: string): number {
    const track = tracksStore.getTrackById(trackId);
    if (!track) return 0;
    const total = track.duration;
    const silenceTotal = getActiveRegionsForTrack(trackId).reduce(
      (sum, r) => sum + (r.end - r.start), 0
    );
    return Math.max(0, total - silenceTotal);
  }

  // Calculate how much silence is being removed for a track
  function savedDurationForTrack(trackId: string): number {
    return getActiveRegionsForTrack(trackId).reduce(
      (sum, r) => sum + (r.end - r.start), 0
    );
  }

  // Backward-compat computed: uses selected track
  const compressedDuration = computed(() => {
    const trackId = tracksStore.selectedTrack?.id;
    if (!trackId) return tracksStore.timelineDuration;
    return compressedDurationForTrack(trackId);
  });

  const savedDuration = computed(() => {
    const trackId = tracksStore.selectedTrack?.id;
    if (!trackId) return 0;
    return savedDurationForTrack(trackId);
  });

  // Initialize silence regions from VAD results for a specific track
  function initFromVad(trackId: string): void {
    if (!vadStore.result) return;

    // VAD timestamps are 0-based relative to the rendered track content.
    // Offset by the track's earliest clip position so overlays align on the timeline.
    const clips = tracksStore.getTrackClips(trackId);
    const timelineOffset = clips.length > 0
      ? Math.min(...clips.map(c => c.clipStart))
      : 0;

    const regions = vadStore.silenceSegments.map(seg => ({
      id: generateId(),
      start: seg.start + timelineOffset,
      end: seg.end + timelineOffset,
      enabled: true,
    }));

    const newMap = new Map(silenceRegions.value);
    newMap.set(trackId, regions);
    silenceRegions.value = newMap;

    console.log(`Created ${regions.length} silence regions for track ${trackId} from VAD (offset: ${timelineOffset.toFixed(2)}s)`);
  }

  // Add a new silence region manually for a specific track
  function addRegion(trackId: string, start: number, end: number): SilenceRegion | null {
    useHistoryStore().pushState('Add silence region');
    const track = tracksStore.getTrackById(trackId);
    const duration = track ? track.trackStart + track.duration : tracksStore.timelineDuration;
    const regionStart = Math.max(0, Math.min(start, end));
    const regionEnd = Math.min(duration, Math.max(start, end));

    if (regionEnd - regionStart < MIN_REGION_DURATION) {
      console.warn('Region too small');
      return null;
    }

    const newRegion: SilenceRegion = {
      id: generateId(),
      start: regionStart,
      end: regionEnd,
      enabled: true,
    };

    const regions = [...getRegionsForTrack(trackId)];
    const insertIndex = regions.findIndex(r => r.start > regionStart);
    if (insertIndex === -1) {
      regions.push(newRegion);
    } else {
      regions.splice(insertIndex, 0, newRegion);
    }

    const newMap = new Map(silenceRegions.value);
    newMap.set(trackId, regions);
    silenceRegions.value = newMap;

    mergeOverlapping(trackId);
    return newRegion;
  }

  // Update a region's boundaries for a specific track
  function updateRegion(
    trackId: string,
    id: string,
    updates: { start?: number; end?: number }
  ): void {
    const regions = getRegionsForTrack(trackId);
    const region = regions.find(r => r.id === id);
    if (!region) return;
    useHistoryStore().pushState('Update silence region');

    const track = tracksStore.getTrackById(trackId);
    const duration = track ? track.trackStart + track.duration : tracksStore.timelineDuration;
    const oldStart = region.start;
    const oldEnd = region.end;

    if (updates.start !== undefined) {
      region.start = Math.max(0, Math.min(updates.start, region.end - MIN_REGION_DURATION));
    }

    if (updates.end !== undefined) {
      region.end = Math.min(duration, Math.max(updates.end, region.start + MIN_REGION_DURATION));
    }

    if (region.end - region.start < MIN_REGION_DURATION) {
      region.end = region.start + MIN_REGION_DURATION;
    }

    console.log('[Silence] Updated region:', id, `${oldStart.toFixed(2)}-${oldEnd.toFixed(2)} → ${region.start.toFixed(2)}-${region.end.toFixed(2)}`);

    // Trigger reactivity
    const newMap = new Map(silenceRegions.value);
    const updatedRegions = [...regions];
    updatedRegions.sort((a, b) => a.start - b.start);
    newMap.set(trackId, updatedRegions);
    silenceRegions.value = newMap;
    mergeOverlapping(trackId);
  }

  // Move a region by delta (preserving duration)
  function moveRegion(trackId: string, id: string, delta: number): void {
    const regions = getRegionsForTrack(trackId);
    const region = regions.find(r => r.id === id);
    if (!region) return;
    useHistoryStore().pushState('Move silence region');

    const track = tracksStore.getTrackById(trackId);
    const duration = track ? track.trackStart + track.duration : tracksStore.timelineDuration;
    const regionDuration = region.end - region.start;

    let newStart = region.start + delta;
    let newEnd = region.end + delta;

    if (newStart < 0) {
      newStart = 0;
      newEnd = regionDuration;
    }
    if (newEnd > duration) {
      newEnd = duration;
      newStart = duration - regionDuration;
    }

    region.start = newStart;
    region.end = newEnd;

    const newMap = new Map(silenceRegions.value);
    const updatedRegions = [...regions];
    updatedRegions.sort((a, b) => a.start - b.start);
    newMap.set(trackId, updatedRegions);
    silenceRegions.value = newMap;
    mergeOverlapping(trackId);
  }

  // Delete a region (restore that audio)
  function deleteRegion(trackId: string, id: string): void {
    const regions = getRegionsForTrack(trackId);
    const region = regions.find(r => r.id === id);
    if (region) {
      useHistoryStore().pushState('Delete silence region');
      region.enabled = false;
      // Trigger reactivity
      const newMap = new Map(silenceRegions.value);
      newMap.set(trackId, [...regions]);
      silenceRegions.value = newMap;
      console.log('[Silence] Disabled region:', id, `${region.start.toFixed(2)}-${region.end.toFixed(2)}`);
    }
  }

  // Permanently remove a region from the list
  function removeRegion(trackId: string, id: string): void {
    useHistoryStore().pushState('Remove silence region');
    const regions = getRegionsForTrack(trackId);
    const filtered = regions.filter(r => r.id !== id);
    const newMap = new Map(silenceRegions.value);
    newMap.set(trackId, filtered);
    silenceRegions.value = newMap;
  }

  // Restore a previously deleted region
  function restoreRegion(trackId: string, id: string): void {
    const regions = getRegionsForTrack(trackId);
    const region = regions.find(r => r.id === id);
    if (region) {
      useHistoryStore().pushState('Restore silence region');
      region.enabled = true;
      const newMap = new Map(silenceRegions.value);
      newMap.set(trackId, [...regions]);
      silenceRegions.value = newMap;
    }
  }

  // Toggle compression (skip silence on playback)
  function toggleCompression(enabled?: boolean): void {
    useHistoryStore().pushState('Toggle compression');
    compressionEnabled.value = enabled ?? !compressionEnabled.value;
  }

  // Check if a time falls within an active silence region for a track (O(log n) binary search)
  function isInSilence(trackId: string, time: number): SilenceRegion | null {
    if (!compressionEnabled.value) return null;
    const regions = getActiveRegionsForTrack(trackId);
    if (regions.length === 0) return null;

    let lo = 0, hi = regions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = regions[mid];
      if (time < r.start) hi = mid - 1;
      else if (time >= r.end) lo = mid + 1;
      else return r; // time is inside this region
    }
    return null;
  }

  // Get the end time of silence region at given time (for skipping forward)
  function getNextSpeechTime(trackId: string, time: number): number {
    const region = isInSilence(trackId, time);
    return region ? region.end : time;
  }

  // Get the start time of silence region at given time (for skipping backward)
  function getPrevSpeechTime(trackId: string, time: number): number {
    const region = isInSilence(trackId, time);
    return region ? region.start : time;
  }

  // Merge overlapping regions for a specific track
  function mergeOverlapping(trackId: string): void {
    const regions = getRegionsForTrack(trackId);
    if (regions.length < 2) return;

    const sorted = [...regions].sort((a, b) => a.start - b.start);
    const merged: SilenceRegion[] = [];
    let current = { ...sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
        current.enabled = current.enabled || next.enabled;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    const newMap = new Map(silenceRegions.value);
    newMap.set(trackId, merged);
    silenceRegions.value = newMap;
  }

  // Cut silence and create a new track (non-destructive)
  async function cutSilenceToNewTrack(trackId: string): Promise<Track | null> {
    // Reject _unassigned — must be explicitly reassigned first
    if (trackId === UNASSIGNED_TRACK_KEY) {
      cutError.value = 'Legacy silence regions need reassignment. Run silence detection on the target track.';
      return null;
    }

    if (!tracksStore.hasAudio) {
      cutError.value = 'No audio loaded';
      return null;
    }

    const trackRegions = getActiveRegionsForTrack(trackId);
    if (trackRegions.length === 0) {
      cutError.value = 'No silence regions for this track';
      return null;
    }

    const sourceTrack = tracksStore.getTrackById(trackId);
    if (!sourceTrack) {
      cutError.value = 'Track not found';
      return null;
    }

    cutting.value = true;
    cutError.value = null;

    try {
      console.log('[CutSilence] Starting cut for track:', sourceTrack.name);

      // Get current buffer state (clips mixed together)
      const mixedBuffer = tracksStore.mixClipsForTrack(sourceTrack.id, audioStore.getAudioContext());
      if (!mixedBuffer) {
        cutError.value = 'Cannot cut silence: no audio clips available';
        cutting.value = false;
        return null;
      }

      // Encode to WAV and write to temp file
      const wavData = await encodeWavFloat32InWorker(mixedBuffer);
      const sourcePath = await writeTempFile(`cut_source_${Date.now()}.wav`, wavData);

      console.log('[CutSilence] Using current buffer state, temp file:', sourcePath);

      // Get temp path for output
      const outputPath = await invoke<string>('get_temp_audio_path');
      console.log('[CutSilence] Temp output path:', outputPath);

      // Build speech segments from gaps between active (enabled) silence regions
      const duration = mixedBuffer.duration;
      const sorted = [...trackRegions].sort((a, b) => a.start - b.start);

      console.log('[CutSilence] Total silence regions:', getRegionsForTrack(trackId).length);
      console.log('[CutSilence] Active (enabled) silence regions:', sorted.length);
      console.log(`[CutSilence] Active regions: ${sorted.length} (first: ${sorted[0]?.start.toFixed(2)}-${sorted[0]?.end.toFixed(2)}, last: ${sorted[sorted.length - 1]?.start.toFixed(2)}-${sorted[sorted.length - 1]?.end.toFixed(2)})`);

      // Create speech segments (inverse of silence)
      const speechSegments: Array<{ start: number; end: number; isSpeech: boolean }> = [];
      let prevEnd = 0;

      for (const region of sorted) {
        if (region.start > prevEnd) {
          speechSegments.push({
            start: prevEnd,
            end: region.start,
            isSpeech: true,
          });
        }
        prevEnd = region.end;
      }

      // Add final segment if there's speech after last silence
      if (prevEnd < duration) {
        speechSegments.push({
          start: prevEnd,
          end: duration,
          isSpeech: true,
        });
      }

      console.log('[CutSilence] Speech segments:', speechSegments.length);
      console.log(`[CutSilence] Speech segments (KEEPING): ${speechSegments.length}`);

      const totalSpeechDuration = speechSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
      console.log('[CutSilence] Original duration:', duration.toFixed(2), 'New duration:', totalSpeechDuration.toFixed(2), 'Removing:', (duration - totalSpeechDuration).toFixed(2));

      // Call backend to create the cut audio
      console.log('[CutSilence] Calling backend export_without_silence...');
      await invoke('export_without_silence', {
        sourcePath,
        outputPath,
        speechSegments,
      });
      console.log('[CutSilence] Backend completed');

      // Load the cut audio file into a buffer
      console.log('[CutSilence] Loading cut audio buffer...');
      const cutAudioEntry = await loadCutAudio(outputPath);
      console.log('[CutSilence] Loaded cut audio, duration:', cutAudioEntry.duration);

      // Create a new track from the cut audio
      console.log('[CutSilence] Creating new track...');
      const cutName = `No Silence - ${sourceTrack.name}`;
      const cutTrack = await tracksStore.createTrackFromBuffer(
        cutAudioEntry.buffer,
        cutAudioEntry.waveformData,
        cutName,
        0
      );
      console.log('[CutSilence] Created track:', cutTrack.id, cutTrack.name);

      // Store the cut audio data mapped to the new track's ID
      const newMap = new Map(cutAudioFiles.value);
      newMap.set(cutTrack.id, {
        ...cutAudioEntry,
        cutRegions: sorted.map(r => ({ start: r.start, end: r.end })),
      });
      cutAudioFiles.value = newMap;

      // MUTE the source track (non-destructive)
      tracksStore.setTrackMuted(sourceTrack.id, true);

      // Switch to 'clip' loop mode to loop on the new track
      const playbackStore = usePlaybackStore();
      playbackStore.setLoopMode('clip');

      console.log('[CutSilence] Silence cut successfully, new track added');
      console.log('[CutSilence] Total tracks now:', tracksStore.tracks.length);
      return cutTrack;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      cutError.value = errorMsg;
      console.error('[CutSilence] Error:', e);
      return null;
    } finally {
      cutting.value = false;
    }
  }

  // DUP-02: use shared loadAudioFromFile utility
  async function loadCutAudio(path: string): Promise<CutAudioData> {
    const ctx = audioStore.getAudioContext();
    return loadAudioFromFile(path, ctx);
  }

  // Get the audio buffer for a track (returns cut buffer if available)
  function getBufferForTrack(trackId: string): AudioBuffer | null {
    const cutEntry = cutAudioFiles.value.get(trackId);
    if (cutEntry) {
      return cutEntry.buffer;
    }
    return null;
  }

  // Get waveform data for a track (returns cut waveform if available)
  function getWaveformForTrack(trackId: string): number[] | null {
    const cutEntry = cutAudioFiles.value.get(trackId);
    if (cutEntry) {
      return cutEntry.waveformData;
    }
    return null;
  }

  // Check if a track has cut audio
  function hasCutAudio(trackId: string): boolean {
    return cutAudioFiles.value.has(trackId);
  }

  // Get the cut regions for a track (for time mapping)
  function getCutRegions(trackId: string): Array<{ start: number; end: number }> | null {
    const entry = cutAudioFiles.value.get(trackId);
    return entry?.cutRegions ?? null;
  }

  // Map cut-audio playback time to original timeline time
  function mapCutTimeToOriginal(trackId: string, cutTime: number): number {
    const cutRegions = getCutRegions(trackId);
    if (!cutRegions || cutRegions.length === 0) {
      return cutTime;
    }

    const sorted = [...cutRegions].sort((a, b) => a.start - b.start);
    let offset = 0;
    let remainingCutTime = cutTime;

    for (const region of sorted) {
      const regionDuration = region.end - region.start;
      const originalPosBeforeRegion = remainingCutTime + offset;

      if (originalPosBeforeRegion < region.start) {
        break;
      }
      offset += regionDuration;
    }

    return cutTime + offset;
  }

  // Map original timeline time to cut-audio playback time (inverse mapping)
  function mapOriginalToCutTime(trackId: string, originalTime: number): number {
    const cutRegions = getCutRegions(trackId);
    if (!cutRegions || cutRegions.length === 0) {
      return originalTime;
    }

    const sorted = [...cutRegions].sort((a, b) => a.start - b.start);
    let cutTime = originalTime;

    for (const region of sorted) {
      if (originalTime > region.end) {
        cutTime -= (region.end - region.start);
      } else if (originalTime >= region.start) {
        cutTime = region.start;
        for (const prev of sorted) {
          if (prev.start < region.start) {
            cutTime -= (prev.end - prev.start);
          }
        }
        break;
      }
    }

    return Math.max(0, cutTime);
  }

  // Clear all silence regions
  function clear(): void {
    useHistoryStore().pushState('Clear silence regions');
    silenceRegions.value = new Map();
    compressionEnabled.value = false;
  }

  // Clear without pushing history (for project load)
  function clearWithoutHistory(): void {
    silenceRegions.value = new Map();
    compressionEnabled.value = false;
  }

  // Set silence regions for a specific track (for project load)
  function setSilenceRegions(regions: SilenceRegion[], trackId?: string): void {
    if (trackId) {
      const newMap = new Map(silenceRegions.value);
      newMap.set(trackId, regions);
      silenceRegions.value = newMap;
    } else {
      // Legacy: single-track auto-migration is handled by project.ts
      // This path should no longer be called for new code
      const tracks = tracksStore.tracks;
      if (tracks.length === 1) {
        const newMap = new Map(silenceRegions.value);
        newMap.set(tracks[0].id, regions);
        silenceRegions.value = newMap;
      } else if (tracks.length > 1) {
        // Multiple tracks: load into _unassigned
        const newMap = new Map(silenceRegions.value);
        newMap.set(UNASSIGNED_TRACK_KEY, regions);
        silenceRegions.value = newMap;
      }
    }
  }

  // Set per-track silence regions from a Record (v3 project load)
  function setPerTrackSilenceRegions(perTrack: Record<string, SilenceRegion[]>): void {
    const newMap = new Map<string, SilenceRegion[]>();
    for (const [trackId, regions] of Object.entries(perTrack)) {
      newMap.set(trackId, regions);
    }
    silenceRegions.value = newMap;
  }

  // Clear cut audio data
  function clearCutAudio(): void {
    cutAudioFiles.value.clear();
  }

  // Get regions visible in a time range for a track
  function getRegionsInRange(trackId: string, start: number, end: number): SilenceRegion[] {
    return getRegionsForTrack(trackId).filter(
      r => r.end > start && r.start < end
    );
  }

  // Check if any track has silence regions
  const hasRegions = computed(() => {
    for (const regions of silenceRegions.value.values()) {
      if (regions.length > 0) return true;
    }
    return false;
  });

  // Check if a specific track has silence regions
  function hasRegionsForTrack(trackId: string): boolean {
    return (silenceRegions.value.get(trackId)?.length ?? 0) > 0;
  }

  return {
    silenceRegions,
    compressionEnabled,
    cutting,
    cutError,
    cutAudioFiles,
    activeSilenceRegions,
    compressedDuration,
    savedDuration,
    hasRegions,
    hasRegionsForTrack,
    getRegionsForTrack,
    getActiveRegionsForTrack,
    compressedDurationForTrack,
    savedDurationForTrack,
    initFromVad,
    addRegion,
    updateRegion,
    moveRegion,
    deleteRegion,
    removeRegion,
    restoreRegion,
    toggleCompression,
    isInSilence,
    getNextSpeechTime,
    getPrevSpeechTime,
    getRegionsInRange,
    cutSilenceToNewTrack,
    getBufferForTrack,
    getWaveformForTrack,
    hasCutAudio,
    getCutRegions,
    mapCutTimeToOriginal,
    mapOriginalToCutTime,
    clear,
    clearWithoutHistory,
    setSilenceRegions,
    setPerTrackSilenceRegions,
    clearCutAudio,
  };
});
