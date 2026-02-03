import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { SilenceRegion, Track } from '@/shared/types';
import { useVadStore } from './vad';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { usePlaybackStore } from './playback';
import { generateId } from '@/shared/utils';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';

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

export const useSilenceStore = defineStore('silence', () => {
  const vadStore = useVadStore();
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();

  const silenceRegions = ref<SilenceRegion[]>([]);
  const compressionEnabled = ref(false);
  const cutting = ref(false);
  const cutError = ref<string | null>(null);

  // Map of trackId -> cut audio data (silence removed)
  const cutAudioFiles = ref<Map<string, CutAudioEntry>>(new Map());

  // Minimum region duration in seconds
  const MIN_REGION_DURATION = 0.05;

  // Get only enabled (active) silence regions
  const activeSilenceRegions = computed(() =>
    silenceRegions.value.filter(r => r.enabled)
  );

  // Calculate compressed duration (total duration minus active silence)
  const compressedDuration = computed(() => {
    const total = tracksStore.timelineDuration;
    const silenceTotal = activeSilenceRegions.value.reduce(
      (sum, r) => sum + (r.end - r.start),
      0
    );
    return Math.max(0, total - silenceTotal);
  });

  // Calculate how much silence is being removed
  const savedDuration = computed(() => {
    return activeSilenceRegions.value.reduce(
      (sum, r) => sum + (r.end - r.start),
      0
    );
  });

  // Generate unique ID
  function generateId(): string {
    return `silence-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Initialize silence regions from VAD results
  function initFromVad(): void {
    if (!vadStore.result) return;

    silenceRegions.value = vadStore.silenceSegments.map(seg => ({
      id: generateId(),
      start: seg.start,
      end: seg.end,
      enabled: true,
    }));

    console.log(`Created ${silenceRegions.value.length} silence regions from VAD`);
  }

  // Add a new silence region manually
  function addRegion(start: number, end: number): SilenceRegion | null {
    // Ensure valid range
    const duration = tracksStore.timelineDuration;
    const regionStart = Math.max(0, Math.min(start, end));
    const regionEnd = Math.min(duration, Math.max(start, end));

    // Check minimum duration
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

    // Insert in sorted order by start time
    const insertIndex = silenceRegions.value.findIndex(r => r.start > regionStart);
    if (insertIndex === -1) {
      silenceRegions.value.push(newRegion);
    } else {
      silenceRegions.value.splice(insertIndex, 0, newRegion);
    }

    // Merge overlapping regions
    mergeOverlapping();

    return newRegion;
  }

  // Update a region's boundaries
  function updateRegion(
    id: string,
    updates: { start?: number; end?: number }
  ): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (!region) return;

    const duration = tracksStore.timelineDuration;
    const oldStart = region.start;
    const oldEnd = region.end;

    if (updates.start !== undefined) {
      region.start = Math.max(0, Math.min(updates.start, region.end - MIN_REGION_DURATION));
    }

    if (updates.end !== undefined) {
      region.end = Math.min(duration, Math.max(updates.end, region.start + MIN_REGION_DURATION));
    }

    // Ensure minimum duration
    if (region.end - region.start < MIN_REGION_DURATION) {
      region.end = region.start + MIN_REGION_DURATION;
    }

    console.log('[Silence] Updated region:', id, `${oldStart.toFixed(2)}-${oldEnd.toFixed(2)} → ${region.start.toFixed(2)}-${region.end.toFixed(2)}`);

    // Re-sort and merge if needed
    silenceRegions.value.sort((a, b) => a.start - b.start);
    mergeOverlapping();
  }

  // Move a region by delta (preserving duration)
  function moveRegion(id: string, delta: number): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (!region) return;

    const duration = tracksStore.timelineDuration;
    const regionDuration = region.end - region.start;

    let newStart = region.start + delta;
    let newEnd = region.end + delta;

    // Clamp to audio bounds
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

    // Re-sort and merge
    silenceRegions.value.sort((a, b) => a.start - b.start);
    mergeOverlapping();
  }

  // Delete a region (restore that audio)
  function deleteRegion(id: string): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (region) {
      region.enabled = false;
      console.log('[Silence] Disabled region:', id, `${region.start.toFixed(2)}-${region.end.toFixed(2)}`);
      console.log('[Silence] Active regions now:', activeSilenceRegions.value.length);
    }
  }

  // Permanently remove a region from the list
  function removeRegion(id: string): void {
    const index = silenceRegions.value.findIndex(r => r.id === id);
    if (index !== -1) {
      silenceRegions.value.splice(index, 1);
    }
  }

  // Restore a previously deleted region
  function restoreRegion(id: string): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (region) {
      region.enabled = true;
    }
  }

  // Toggle compression (skip silence on playback)
  function toggleCompression(enabled?: boolean): void {
    compressionEnabled.value = enabled ?? !compressionEnabled.value;
  }

  // Check if a time falls within an active silence region
  function isInSilence(time: number): SilenceRegion | null {
    if (!compressionEnabled.value) return null;

    return activeSilenceRegions.value.find(
      r => time >= r.start && time < r.end
    ) || null;
  }

  // Get the end time of silence region at given time (for skipping)
  function getNextSpeechTime(time: number): number {
    const region = isInSilence(time);
    return region ? region.end : time;
  }

  // Merge overlapping regions
  function mergeOverlapping(): void {
    if (silenceRegions.value.length < 2) return;

    // Sort by start time
    silenceRegions.value.sort((a, b) => a.start - b.start);

    const merged: SilenceRegion[] = [];
    let current = { ...silenceRegions.value[0] };

    for (let i = 1; i < silenceRegions.value.length; i++) {
      const next = silenceRegions.value[i];

      // Check if regions overlap or touch
      if (next.start <= current.end) {
        // Merge: extend current to cover next
        current.end = Math.max(current.end, next.end);
        // Keep enabled if either is enabled
        current.enabled = current.enabled || next.enabled;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    silenceRegions.value = merged;
  }

  // Cut silence and create a new track (non-destructive)
  async function cutSilenceToNewTrack(): Promise<Track | null> {
    if (!tracksStore.hasAudio) {
      cutError.value = 'No audio loaded';
      return null;
    }

    if (!hasRegions.value) {
      cutError.value = 'No silence regions defined';
      return null;
    }

    // Use selected track or first track
    const sourceTrack = tracksStore.selectedTrack || tracksStore.tracks[0];
    if (!sourceTrack) {
      cutError.value = 'No track selected';
      return null;
    }

    // Need a file path - check if we have lastImportedPath
    const sourcePath = audioStore.lastImportedPath;
    if (!sourcePath) {
      cutError.value = 'Cannot cut silence: no source file path available';
      return null;
    }

    cutting.value = true;
    cutError.value = null;

    try {
      console.log('[CutSilence] Starting cut for track:', sourceTrack.name);

      // Get temp path for output
      const outputPath = await invoke<string>('get_temp_audio_path');
      console.log('[CutSilence] Temp output path:', outputPath);

      // Build speech segments from gaps between active (enabled) silence regions
      const duration = sourceTrack.duration;
      const sorted = [...activeSilenceRegions.value].sort((a, b) => a.start - b.start);

      console.log('[CutSilence] Total silence regions:', silenceRegions.value.length);
      console.log('[CutSilence] Active (enabled) silence regions:', sorted.length);
      console.log('[CutSilence] Active regions:', sorted.map(r => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(', '));

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
      console.log('[CutSilence] Speech segments (KEEPING):', speechSegments.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(', '));

      // Log what's being removed (for debugging)
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
      const cutTrack = tracksStore.createTrackFromBuffer(
        cutAudioEntry.buffer,
        cutAudioEntry.waveformData,
        cutName,
        0
      );
      console.log('[CutSilence] Created track:', cutTrack.id, cutTrack.name);

      // Store the cut audio data mapped to the new track's ID
      // Include the silence regions that were cut for time mapping
      // Create a new Map to trigger Vue reactivity
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

  async function loadCutAudio(path: string): Promise<CutAudioData> {
    const ctx = audioStore.getAudioContext();

    // Load audio metadata
    const metadata = await invoke<{ duration: number; sampleRate: number; channels: number }>(
      'get_audio_metadata',
      { path }
    );

    // Load waveform data
    const waveformData = await invoke<number[]>('extract_waveform', {
      path,
      bucketCount: WAVEFORM_BUCKET_COUNT,
    });

    // Load audio buffer
    const audioData = await invoke<number[]>('load_audio_buffer', { path });

    const float32Data = new Float32Array(audioData);
    const samplesPerChannel = Math.floor(float32Data.length / metadata.channels);

    const buffer = ctx.createBuffer(
      metadata.channels,
      samplesPerChannel,
      metadata.sampleRate
    );

    for (let channel = 0; channel < metadata.channels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = float32Data[i * metadata.channels + channel];
      }
    }

    return {
      path,
      buffer,
      waveformData,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
    };
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
  // This makes the playhead visually skip over the cut silence regions
  function mapCutTimeToOriginal(trackId: string, cutTime: number): number {
    const cutRegions = getCutRegions(trackId);
    if (!cutRegions || cutRegions.length === 0) {
      return cutTime;
    }

    // Sort regions by start time
    const sorted = [...cutRegions].sort((a, b) => a.start - b.start);

    // Walk through regions, accumulating offset as we pass cut points
    let offset = 0;
    let remainingCutTime = cutTime;

    for (const region of sorted) {
      const regionDuration = region.end - region.start;
      // Position in original timeline (before this region's cut)
      const originalPosBeforeRegion = remainingCutTime + offset;

      if (originalPosBeforeRegion < region.start) {
        // We haven't reached this cut region yet
        break;
      }

      // We've passed this cut point, add its duration to offset
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
        // Past this region, subtract its duration
        cutTime -= (region.end - region.start);
      } else if (originalTime >= region.start) {
        // Inside a cut region - snap to the start
        cutTime = region.start;
        // Subtract all previous regions
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
    silenceRegions.value = [];
    compressionEnabled.value = false;
  }

  // Clear cut audio data
  function clearCutAudio(): void {
    cutAudioFiles.value.clear();
  }

  // Get regions visible in a time range
  function getRegionsInRange(start: number, end: number): SilenceRegion[] {
    return silenceRegions.value.filter(
      r => r.end > start && r.start < end
    );
  }

  // Check if silence regions have been created
  const hasRegions = computed(() => silenceRegions.value.length > 0);

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
    getRegionsInRange,
    cutSilenceToNewTrack,
    getBufferForTrack,
    getWaveformForTrack,
    hasCutAudio,
    getCutRegions,
    mapCutTimeToOriginal,
    mapOriginalToCutTime,
    clear,
    clearCutAudio,
  };
});
