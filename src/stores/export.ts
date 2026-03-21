import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTempFile } from '@/shared/fs-utils';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSilenceStore } from './silence';
import { useSettingsStore } from './settings';
import { listen } from '@tauri-apps/api/event';
import type { ExportFormat, ExportProfile, ExportEDL, ExportEDLTrack, Track, TrackClip, VolumeAutomationPoint, SilenceRegion } from '@/shared/types';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { isTrackPlayable, filterActiveTracks } from '@/shared/utils';
import { useUIStore } from './ui';

const FORMAT_LABELS: Record<string, string> = {
  mp3: 'MP3 Audio',
  wav: 'WAV Audio',
  flac: 'FLAC Audio',
  ogg: 'OGG Audio',
};

/**
 * Normalize a path returned from the native save dialog to ensure it has
 * the correct extension for the chosen profile format.
 * Fixes GTK issue where changing filter doesn't update the filename extension.
 */
function normalizeAudioPath(path: string, expectedFormat: ExportFormat): { path: string; format: ExportFormat } {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === expectedFormat) return { path, format: expectedFormat };
  // If the extension matches another supported format, honour it
  if (ext === 'wav' || ext === 'mp3' || ext === 'flac' || ext === 'ogg') {
    return { path, format: ext as ExportFormat };
  }
  // GTK didn't append extension — add the expected one
  const dotIdx = path.lastIndexOf('.');
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = dotIdx > 0 && dotIdx > slashIdx ? path.substring(0, dotIdx) : path;
  return { path: base + '.' + expectedFormat, format: expectedFormat };
}

/**
 * Build a human-readable export summary showing which tracks are included/excluded.
 * Follows DAW conventions: explicitly list what's being exported and why others are excluded.
 */
function buildExportSummary(
  allTracks: Track[],
  active: Track[],
): string {
  const hasSolo = allTracks.some(t => t.solo);
  const excluded = allTracks.filter(t => !active.includes(t));

  const lines: string[] = [];
  lines.push(`Exporting ${active.length} of ${allTracks.length} track(s):`);

  for (const t of active) {
    const tags: string[] = [];
    if (t.solo) tags.push('solo');
    const suffix = tags.length ? ` (${tags.join(', ')})` : '';
    lines.push(`  + ${t.name}${suffix}`);
  }

  if (excluded.length > 0) {
    for (const t of excluded) {
      const reason = t.muted ? 'muted' : hasSolo && !t.solo ? 'not soloed' : 'excluded';
      lines.push(`  - ${t.name} (${reason})`);
    }
  }

  return lines.join('\n');
}

/**
 * Split a single EDL clip around silence regions, returning sub-clips that skip silence.
 * Rebases volume_envelope points to each sub-clip's local time.
 */
export function subtractSilenceFromClip(clip: ExportEDLTrack, silenceRegions: SilenceRegion[]): ExportEDLTrack[] {
  const clipEnd = clip.track_start + clip.duration;

  // Collect silence intervals that overlap this clip
  const overlapping = silenceRegions.filter(r => r.start < clipEnd && r.end > clip.track_start);
  if (overlapping.length === 0) return [clip];

  // Build non-silence intervals within the clip
  const intervals: Array<{ start: number; end: number }> = [];
  let cursor = clip.track_start;

  for (const r of overlapping) {
    const silStart = Math.max(r.start, clip.track_start);
    const silEnd = Math.min(r.end, clipEnd);
    if (cursor < silStart) {
      intervals.push({ start: cursor, end: silStart });
    }
    cursor = Math.max(cursor, silEnd);
  }
  if (cursor < clipEnd) {
    intervals.push({ start: cursor, end: clipEnd });
  }

  if (intervals.length === 0) return [];

  // Create sub-clips for each non-silence interval
  return intervals.map(iv => {
    const offsetFromClipStart = iv.start - clip.track_start;
    const subDuration = iv.end - iv.start;
    const subFileOffset = (clip.file_offset ?? 0) + offsetFromClipStart;

    // Rebase envelope points to sub-clip local time
    let subEnvelope: Array<{ time: number; value: number }> | undefined;
    if (clip.volume_envelope && clip.volume_envelope.length > 0) {
      subEnvelope = clip.volume_envelope
        .map(p => ({ time: p.time - offsetFromClipStart, value: p.value }))
        .filter(p => p.time >= 0 && p.time <= subDuration);
    }

    return {
      source_path: clip.source_path,
      track_start: iv.start,
      duration: subDuration,
      volume: clip.volume,
      file_offset: subFileOffset,
      volume_envelope: subEnvelope,
    };
  });
}

/**
 * Collapse timeline by subtracting accumulated silence duration before each clip's start.
 * Returns adjusted clips and a new shortened end time.
 */
export function collapseTimeline(
  clips: ExportEDLTrack[],
  silenceRegions: SilenceRegion[],
  timelineEnd: number,
): { clips: ExportEDLTrack[]; newEndTime: number } {
  if (silenceRegions.length === 0) return { clips, newEndTime: timelineEnd };

  const sorted = [...silenceRegions].sort((a, b) => a.start - b.start);
  const totalSilence = sorted.reduce((sum, r) => sum + (r.end - r.start), 0);

  const collapsed = clips.map(clip => {
    let silenceBefore = 0;
    for (const r of sorted) {
      if (r.end <= clip.track_start) {
        silenceBefore += r.end - r.start;
      } else if (r.start < clip.track_start) {
        silenceBefore += clip.track_start - r.start;
      } else {
        break;
      }
    }
    return { ...clip, track_start: clip.track_start - silenceBefore };
  });

  return { clips: collapsed, newEndTime: Math.max(0, timelineEnd - totalSilence) };
}

/**
 * Compute the union of all active silence regions across multiple tracks.
 * Merges overlapping regions into a flat sorted array.
 */
export function computeUnionSilenceRegions(tracks: Track[], silenceStore: ReturnType<typeof useSilenceStore>): SilenceRegion[] {
  const all: SilenceRegion[] = [];
  for (const t of tracks) {
    all.push(...silenceStore.getActiveRegionsForTrack(t.id));
  }
  if (all.length === 0) return [];

  // Sort by start, then merge overlapping
  all.sort((a, b) => a.start - b.start);
  const merged: SilenceRegion[] = [{ ...all[0] }];

  for (let i = 1; i < all.length; i++) {
    const last = merged[merged.length - 1];
    const cur = all[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
}

/**
 * Remove silence regions from a mixed AudioBuffer by keeping only speech portions.
 * Returns a compacted buffer with silence gaps removed.
 */
function removeSilenceFromBuffer(
  buffer: AudioBuffer,
  silenceRegions: SilenceRegion[],
  timelineStart: number,
  audioContext: AudioContext,
): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const sorted = [...silenceRegions].sort((a, b) => a.start - b.start);

  // Build speech intervals (inverse of silence within buffer range)
  const bufEnd = timelineStart + buffer.duration;
  const speechIntervals: Array<{ start: number; end: number }> = [];
  let cursor = timelineStart;

  for (const r of sorted) {
    const silStart = Math.max(r.start, timelineStart);
    const silEnd = Math.min(r.end, bufEnd);
    if (silStart >= bufEnd) break;
    if (cursor < silStart) {
      speechIntervals.push({ start: cursor, end: silStart });
    }
    cursor = Math.max(cursor, silEnd);
  }
  if (cursor < bufEnd) {
    speechIntervals.push({ start: cursor, end: bufEnd });
  }

  if (speechIntervals.length === 0) {
    return audioContext.createBuffer(numChannels, 1, sampleRate);
  }

  const totalSpeechSamples = speechIntervals.reduce(
    (sum, iv) => sum + Math.ceil((iv.end - iv.start) * sampleRate), 0
  );
  const compacted = audioContext.createBuffer(numChannels, totalSpeechSamples, sampleRate);

  let writeCursor = 0;
  for (const iv of speechIntervals) {
    const readStart = Math.floor((iv.start - timelineStart) * sampleRate);
    const readLen = Math.ceil((iv.end - iv.start) * sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      const input = buffer.getChannelData(ch);
      const output = compacted.getChannelData(ch);
      for (let i = 0; i < readLen && readStart + i < input.length && writeCursor + i < output.length; i++) {
        output[writeCursor + i] = input[readStart + i];
      }
    }
    writeCursor += readLen;
  }

  return compacted;
}

export const useExportStore = defineStore('export', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const settingsStore = useSettingsStore();

  const loading = ref(false);
  const error = ref<string | null>(null);
  const progress = ref(0);
  const lastExportResult = ref<string | null>(null);
  const currentExportPath = ref<string | null>(null);

  // DUP-07: use canonical solo/mute filter
  const activeTracks = computed(() => {
    const tracks = tracksStore.tracks.filter(t => isTrackPlayable(t.importStatus));
    return filterActiveTracks(tracks);
  });

  const canExport = computed(() => {
    return tracksStore.hasAudio && activeTracks.value.length > 0;
  });

  const canQuickReExport = computed(() => {
    return canExport.value && !!settingsStore.settings.lastExportPath;
  });

  /**
   * Export all active tracks mixed together using a specific profile.
   * Opens native save dialog with a single filter matching the profile format.
   */
  async function exportWithProfile(profile: ExportProfile): Promise<string | null> {
    if (loading.value) {
      useUIStore().showToast('Export already in progress.', 'warn');
      return null;
    }
    if (!canExport.value) {
      error.value = 'Nothing to export';
      return null;
    }

    const format = profile.format;
    const trackName = activeTracks.value[0]?.name || 'audio';
    const defaultName = `${trackName.replace(/[^a-zA-Z0-9]/g, '_')}_export.${format}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    // Single filter matching the profile format — fixes GTK extension issue
    const filter = {
      name: FORMAT_LABELS[format] || format.toUpperCase(),
      extensions: [format],
    };

    try {
      const outputPathRaw = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [filter],
      });

      if (!outputPathRaw) {
        return null;
      }

      // Normalize extension (handles GTK not appending extension)
      const { path: outputPath } = normalizeAudioPath(outputPathRaw, format);

      const allPlayable = tracksStore.tracks.filter(t => isTrackPlayable(t.importStatus));
      useUIStore().showToast(buildExportSummary(allPlayable, activeTracks.value), 'info', 6000);

      settingsStore.setLastExportFolder(outputPath);
      settingsStore.setLastExportFormat(format);
      settingsStore.setLastExportProfileId(profile.id);
      settingsStore.setLastExportPath(outputPath);

      return await doMixedExport(outputPath, format, profile.mp3Bitrate || 192, profile.oggQuality);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Profile export error:', e);
      return null;
    }
  }

  /**
   * Quick Re-Export: re-exports to the same path with the same profile.
   * No dialog shown. Returns null if no previous export exists.
   */
  async function quickReExport(): Promise<string | null> {
    const lastPath = settingsStore.settings.lastExportPath;
    if (!lastPath || !canExport.value) {
      return null;
    }

    const profiles = settingsStore.getExportProfiles();
    const lastProfileId = settingsStore.settings.lastExportProfileId;
    const profile = profiles.find(p => p.id === lastProfileId) || profiles[0];
    if (!profile) return null;

    const { format } = normalizeAudioPath(lastPath, profile.format);

    const allPlayable = tracksStore.tracks.filter(t => isTrackPlayable(t.importStatus));
    useUIStore().showToast(buildExportSummary(allPlayable, activeTracks.value), 'info', 6000);

    try {
      return await doMixedExport(lastPath, format, profile.mp3Bitrate || 192, profile.oggQuality);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Quick re-export error:', e);
      return null;
    }
  }

  /**
   * Check if all active tracks can use EDL streaming export.
   * Returns true when every clip in every track has a resolvable source path.
   */
  function canUseEdlExport(tracks: Track[]): boolean {
    return tracks.length > 0 && tracks.every(t => {
      const clips = tracksStore.getTrackClips(t.id);
      return clips.length > 0 && clips.every(c =>
        !!(c.sourceFile || t.cachedAudioPath || t.sourcePath)
      );
    });
  }

  /**
   * Build an EDL from active tracks for Rust-side streaming export.
   * Flattens per-track → per-clip so edited (multi-clip) tracks export correctly.
   * Rebases volume envelope times to each clip's local origin.
   */
  function buildEdl(tracks: Track[], outputPath: string, format: ExportFormat, bitrate: number, oggQuality?: number, silenceRegions?: SilenceRegion[]): ExportEDL {
    const firstTrack = tracks[0];
    const sampleRate = firstTrack?.audioData.sampleRate || 44100;
    const channels = Math.min(firstTrack?.audioData.channels || 2, 2) as number;

    let edlTracks: ExportEDLTrack[] = [];
    for (const t of tracks) {
      const clips = tracksStore.getTrackClips(t.id);
      for (const clip of clips) {
        const sourcePath = clip.sourceFile || t.cachedAudioPath || t.sourcePath!;
        // Envelope times are track-relative (relative to t.trackStart).
        // Rebase them to each clip's local origin so Rust gets clip-local times.
        const envelopeOffset = clip.clipStart - (t.trackStart ?? 0);
        const clipEnvelope = t.volumeEnvelope
          ?.map(p => ({ time: p.time - envelopeOffset, value: p.value }))
          .filter(p => p.time >= 0 && p.time <= clip.duration);
        edlTracks.push({
          source_path: sourcePath,
          track_start: clip.clipStart,
          duration: clip.duration,
          volume: t.volume,
          file_offset: clip.sourceOffset ?? 0,
          volume_envelope: clipEnvelope,
        });
      }
    }

    // Split clips around silence regions (produces sub-clips that skip silence)
    if (silenceRegions && silenceRegions.length > 0) {
      const sorted = [...silenceRegions].sort((a, b) => a.start - b.start);
      edlTracks = edlTracks.flatMap(clip => subtractSilenceFromClip(clip, sorted));
    }

    // Sort by timeline position for deterministic mixing
    edlTracks.sort((a, b) => a.track_start - b.track_start);

    let endTime = edlTracks.length > 0
      ? Math.max(...edlTracks.map(e => e.track_start + e.duration))
      : 0;

    // Collapse timeline to close gaps left by removed silence
    if (silenceRegions && silenceRegions.length > 0) {
      const result = collapseTimeline(edlTracks, silenceRegions, endTime);
      edlTracks = result.clips;
      endTime = result.newEndTime;
    }

    return {
      tracks: edlTracks,
      output_path: outputPath,
      format,
      sample_rate: sampleRate,
      channels,
      mp3_bitrate: format === 'mp3' ? bitrate : undefined,
      ogg_quality: format === 'ogg' ? (oggQuality ?? 0.4) : undefined,
      start_time: 0,
      end_time: endTime,
    };
  }

  /**
   * Rebase EDL track_start values so the earliest clip starts at 0.
   * Applied only for single-track exports to trim leading silence.
   * Multi-track mixed exports must NOT be rebased (preserves timeline accuracy).
   */
  function rebaseEdlToZero(edl: ExportEDL): void {
    if (edl.tracks.length === 0) return;
    const minStart = Math.min(...edl.tracks.map(t => t.track_start));
    if (minStart <= 0) return;
    for (const track of edl.tracks) {
      track.track_start -= minStart;
    }
    edl.end_time -= minStart;
  }

  /**
   * Core mixed export logic — used by both exportWithProfile and quickReExport.
   * Uses EDL streaming export when all tracks have source paths (handles large files).
   * Falls back to JS AudioBuffer mixing for tracks without source paths.
   */
  async function doMixedExport(outputPath: string, format: ExportFormat, bitrate: number, oggQuality?: number): Promise<string | null> {
    if (loading.value) {
      useUIStore().showToast('Export already in progress.', 'warn');
      return null;
    }
    loading.value = true;
    error.value = null;
    progress.value = 10;
    lastExportResult.value = null;
    currentExportPath.value = outputPath;

    try {
      // Ensure any in-flight clip recache from cut/delete has completed
      if (tracksStore.pendingRecache) {
        await tracksStore.pendingRecache;
      }

      // Read tracks AFTER recache so clips are cleared and cachedAudioPath is set
      const tracks = activeTracks.value;

      // Explicit error: clips with no buffer and no source file cannot be exported
      const unresolvable = tracks.flatMap(t => tracksStore.getTrackClips(t.id))
        .filter(c => c.buffer === null && !c.sourceFile);
      if (unresolvable.length > 0) {
        throw new Error(
          `Cannot export: ${unresolvable.length} clip(s) have no audio buffer and no source file. ` +
          `Try re-importing the source file.`
        );
      }

      // Compute merged silence regions for all active tracks
      const silenceStore = useSilenceStore();
      const mergedSilence = computeUnionSilenceRegions(tracks, silenceStore);
      if (mergedSilence.length > 0) {
        const totalSilenceDur = mergedSilence.reduce((s, r) => s + (r.end - r.start), 0);
        console.log(`[Export] Removing ${mergedSilence.length} silence region(s) (${totalSilenceDur.toFixed(2)}s)`);
      }

      // Use EDL streaming export when possible (required for large files)
      if (canUseEdlExport(tracks)) {
        console.log('[Export] Using EDL path:', true, 'tracks:', tracks.length);
        const edl = buildEdl(tracks, outputPath, format, bitrate, oggQuality, mergedSilence);

        // Single-track export: trim leading/trailing silence by rebasing to zero
        if (tracks.length === 1) {
          rebaseEdlToZero(edl);
        }

        // Listen for progress events from Rust
        const unlisten = await listen<{ progress: number }>('export-progress', (event) => {
          progress.value = Math.round(event.payload.progress * 100);
        });

        try {
          await invoke('export_edl', { edl });
          progress.value = 100;
          lastExportResult.value = outputPath;
          console.log('[Export] EDL export complete:', outputPath);
          return outputPath;
        } finally {
          unlisten();
        }
      }

      // Fallback: JS-side AudioBuffer mixing (for tracks without source paths)
      console.log('[Export] Using EDL path:', false, 'tracks:', tracks.length);
      const audioContext = audioStore.getAudioContext();
      progress.value = 30;

      let mixedBuffer = mixActiveTracks(audioContext);
      if (!mixedBuffer) {
        throw new Error('Failed to mix tracks');
      }

      // Remove silence from mixed buffer if regions exist
      if (mergedSilence.length > 0) {
        const timelineStart = Math.min(...tracks.map(t => t.trackStart));
        mixedBuffer = removeSilenceFromBuffer(mixedBuffer, mergedSilence, timelineStart, audioContext);
      }
      progress.value = 50;

      const wavData = await encodeWavFloat32InWorker(mixedBuffer);
      const tempPath = await writeTempFile(`mixed_temp_${Date.now()}.wav`, wavData);
      progress.value = 70;

      if (format === 'mp3') {
        await invoke('export_audio_mp3', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
          bitrate,
        });
      } else if (format === 'flac') {
        await invoke('export_audio_flac', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
        });
      } else if (format === 'ogg') {
        await invoke('export_audio_ogg', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
          quality: oggQuality ?? 0.4,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
        });
      }

      progress.value = 100;
      lastExportResult.value = outputPath;
      console.log('[Export] Mixed export complete:', outputPath);
      return outputPath;
    } finally {
      loading.value = false;
      currentExportPath.value = null;
    }
  }

  /**
   * Export a single track using a specific profile.
   */
  async function exportTrackWithProfile(track: Track, profile: ExportProfile): Promise<string | null> {
    if (loading.value) {
      useUIStore().showToast('Export already in progress.', 'warn');
      return null;
    }
    console.log(`[Export] Starting single track export: "${track.name}", profile: ${profile.name}`);
    if (!tracksStore.hasAudio) {
      error.value = 'No audio loaded';
      return null;
    }

    const format = profile.format;
    const defaultName = `${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    const filter = {
      name: FORMAT_LABELS[format] || format.toUpperCase(),
      extensions: [format],
    };

    try {
      const outputPathRaw = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [filter],
      });

      if (!outputPathRaw) {
        return null;
      }

      const { path: outputPath } = normalizeAudioPath(outputPathRaw, format);

      settingsStore.setLastExportFolder(outputPath);
      settingsStore.setLastExportFormat(format);
      settingsStore.setLastExportProfileId(profile.id);
      settingsStore.setLastExportPath(outputPath);

      loading.value = true;
      error.value = null;
      progress.value = 10;
      currentExportPath.value = outputPath;

      // Ensure any in-flight clip recache from cut/delete has completed
      if (tracksStore.pendingRecache) {
        await tracksStore.pendingRecache;
      }

      // Re-read track from store — recache may have cleared clips and set cachedAudioPath
      const currentTrack = tracksStore.tracks.find(t => t.id === track.id);
      if (!currentTrack) {
        throw new Error('Track was removed');
      }

      // Get silence regions for this track
      const silenceStore = useSilenceStore();
      const trackSilence = silenceStore.getActiveRegionsForTrack(currentTrack.id);
      if (trackSilence.length > 0) {
        const totalSilenceDur = trackSilence.reduce((s, r) => s + (r.end - r.start), 0);
        console.log(`[Export] Track "${currentTrack.name}": removing ${trackSilence.length} silence region(s) (${totalSilenceDur.toFixed(2)}s)`);
      }

      // Use EDL path when all clips have a resolvable source (handles multi-clip edited tracks)
      if (canUseEdlExport([currentTrack])) {
        const edl = buildEdl([currentTrack], outputPath, format, profile.mp3Bitrate || 192, profile.oggQuality, trackSilence);
        rebaseEdlToZero(edl);

        const unlisten = await listen<{ progress: number }>('export-progress', (event) => {
          progress.value = Math.round(event.payload.progress * 100);
        });

        try {
          await invoke('export_edl', { edl });
          progress.value = 100;
          lastExportResult.value = outputPath;
          console.log('[Export] Track EDL export complete:', currentTrack.name, '->', outputPath);
          return outputPath;
        } finally {
          unlisten();
        }
      }

      // Fallback: JS-side mixing for tracks without source paths
      const audioContext = audioStore.getAudioContext();
      let trackBuffer = mixSingleTrack(currentTrack.id, audioContext);

      if (!trackBuffer) {
        throw new Error('No audio clips to export for this track');
      }

      // Remove silence from buffer if regions exist
      if (trackSilence.length > 0) {
        trackBuffer = removeSilenceFromBuffer(trackBuffer, trackSilence, currentTrack.trackStart, audioContext);
      }

      const wavData = await encodeWavFloat32InWorker(trackBuffer);
      const tempPath = await writeTempFile(`track_export_${Date.now()}.wav`, wavData);

      if (format === 'mp3') {
        await invoke('export_audio_mp3', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
          bitrate: profile.mp3Bitrate || 192,
        });
      } else if (format === 'flac') {
        await invoke('export_audio_flac', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
        });
      } else if (format === 'ogg') {
        await invoke('export_audio_ogg', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
          quality: profile.oggQuality ?? 0.4,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
        });
      }

      lastExportResult.value = outputPath;
      console.log('[Export] Track export complete:', currentTrack.name, '->', outputPath);
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Track export error:', e);
      return null;
    } finally {
      loading.value = false;
      currentExportPath.value = null;
    }
  }

  /**
   * Legacy: export single track (uses favorite profile).
   */
  async function exportTrack(track: Track): Promise<string | null> {
    const profile = settingsStore.getFavoriteProfile();
    if (!profile) return null;
    return exportTrackWithProfile(track, profile);
  }

  /**
   * Mix a single track's clips into an AudioBuffer.
   */
  function mixSingleTrack(trackId: string, audioContext: AudioContext): AudioBuffer | null {
    const track = tracksStore.tracks.find(t => t.id === trackId);
    if (!track) return null;
    const clips = tracksStore.getTrackClips(trackId);
    if (clips.length === 0) return null;

    let timelineStart = Infinity;
    let timelineEnd = 0;
    let sampleRate = 44100;

    // Filter to clips with AudioBuffers (large-file tracks have null buffers)
    const bufferedClips = clips.filter((c): c is TrackClip & { buffer: AudioBuffer } => c.buffer !== null);
    if (bufferedClips.length === 0) return null;

    for (const clip of bufferedClips) {
      timelineStart = Math.min(timelineStart, clip.clipStart);
      timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
      sampleRate = clip.buffer.sampleRate;
    }

    const totalDuration = timelineEnd - timelineStart;
    const totalSamples = Math.ceil(totalDuration * sampleRate);
    const numChannels = Math.max(...bufferedClips.map(c => c.buffer.numberOfChannels));
    const mixedBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);

    // AQ-02: apply track volume + volume envelope (matches mixActiveTracks behaviour)
    const trackVolume = track.volume;
    const hasEnvelope = track.volumeEnvelope && track.volumeEnvelope.length > 0;
    // PERF-15: linear-walk envelope interpolation for sequential export access
    const envelopeWalker = hasEnvelope
      ? tracksStore.createEnvelopeWalker(track.volumeEnvelope!, trackVolume)
      : null;

    for (const clip of bufferedClips) {
      const startSample = Math.floor((clip.clipStart - timelineStart) * sampleRate);
      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);
        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            let vol = trackVolume;
            if (envelopeWalker) {
              const timelineTime = timelineStart + (startSample + i) / sampleRate;
              const trackRelTime = timelineTime - track.trackStart;
              vol = envelopeWalker(trackRelTime);
            }
            outputData[startSample + i] += inputData[i] * vol;
          }
        }
      }
    }
    return mixedBuffer;
  }

  /**
   * @deprecated Silence removal is now handled natively by all export paths via buildEdl().
   * Kept for one version cycle (remove after v0.28.x). Use exportWithProfile() instead.
   */
  async function exportWithSilenceRemoval(format: ExportFormat = 'wav'): Promise<string | null> {
    if (loading.value) {
      useUIStore().showToast('Export already in progress.', 'warn');
      return null;
    }
    const silenceStore = useSilenceStore();

    if (!tracksStore.hasAudio) {
      error.value = 'No audio loaded';
      return null;
    }

    if (!silenceStore.hasRegions) {
      error.value = 'No silence regions defined';
      return null;
    }

    const trackName = tracksStore.tracks[0]?.name || 'audio';
    const defaultName = `${trackName.replace(/[^a-zA-Z0-9]/g, '_')}_no_silence.${format}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    try {
      const outputPath = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [
          { name: FORMAT_LABELS[format] || format.toUpperCase(), extensions: [format] },
        ],
      });

      if (!outputPath) {
        return null;
      }

      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;
      progress.value = 0;

      const duration = tracksStore.timelineDuration;
      const silenceRegions = silenceStore.activeSilenceRegions;
      const sorted = [...silenceRegions].sort((a, b) => a.start - b.start);

      const speechSegments: Array<{ start: number; end: number; isSpeech: boolean }> = [];
      let prevEnd = 0;

      for (const region of sorted) {
        if (region.start > prevEnd) {
          speechSegments.push({ start: prevEnd, end: region.start, isSpeech: true });
        }
        prevEnd = region.end;
      }

      if (prevEnd < duration) {
        speechSegments.push({ start: prevEnd, end: duration, isSpeech: true });
      }

      const sourcePath = audioStore.lastImportedPath;
      if (!sourcePath) {
        throw new Error('No source file path available');
      }

      await invoke('export_without_silence', { sourcePath, outputPath, speechSegments });
      progress.value = 100;
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('Export with silence removal error:', e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  function clear(): void {
    error.value = null;
    progress.value = 0;
    lastExportResult.value = null;
  }

  /**
   * Mix all active tracks/clips into a single AudioBuffer.
   */
  function mixActiveTracks(audioContext: AudioContext): AudioBuffer | null {
    const tracks = activeTracks.value;
    if (tracks.length === 0) return null;

    let timelineStart = Infinity;
    let timelineEnd = 0;
    let sampleRate = 44100;

    const allClips: Array<{
      buffer: AudioBuffer;
      clipStart: number;
      duration: number;
      volume: number;
      trackStart: number;
      volumeEnvelope?: VolumeAutomationPoint[];
    }> = [];

    for (const track of tracks) {
      const clips = tracksStore.getTrackClips(track.id);
      for (const clip of clips) {
        if (!clip.buffer) continue; // Skip large-file clips without buffers
        timelineStart = Math.min(timelineStart, clip.clipStart);
        timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
        sampleRate = clip.buffer.sampleRate;
        allClips.push({
          buffer: clip.buffer,
          clipStart: clip.clipStart,
          duration: clip.duration,
          volume: track.volume,
          trackStart: track.trackStart,
          volumeEnvelope: track.volumeEnvelope,
        });
      }
    }

    if (allClips.length === 0) return null;

    const totalDuration = timelineEnd - timelineStart;
    const totalSamples = Math.ceil(totalDuration * sampleRate);
    const numChannels = Math.max(...allClips.map(c => c.buffer.numberOfChannels));
    const mixedBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);

    for (const clip of allClips) {
      const startSample = Math.floor((clip.clipStart - timelineStart) * sampleRate);
      // PERF-15: linear-walk envelope interpolation for sequential export access
      const hasEnvelope = clip.volumeEnvelope && clip.volumeEnvelope.length > 0;
      const envelopeWalker = hasEnvelope
        ? tracksStore.createEnvelopeWalker(clip.volumeEnvelope!, clip.volume)
        : null;

      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);
        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            let vol = clip.volume;
            if (envelopeWalker) {
              const timelineTime = timelineStart + (startSample + i) / sampleRate;
              const trackRelTime = timelineTime - clip.trackStart;
              vol = envelopeWalker(trackRelTime);
            }
            outputData[startSample + i] += inputData[i] * vol;
          }
        }
      }
    }

    // Warn about clipping but do NOT normalize — export must match playback exactly
    let maxAbs = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = mixedBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(data[i]));
      }
    }
    if (maxAbs > 1) {
      console.warn(`[Export] Peak exceeds 1.0 (maxAbs=${maxAbs.toFixed(3)}), output may clip`);
    }

    return mixedBuffer;
  }

  return {
    loading,
    error,
    progress,
    activeTracks,
    canExport,
    canQuickReExport,
    lastExportResult,
    currentExportPath,
    exportTrack,
    exportWithProfile,
    exportTrackWithProfile,
    quickReExport,
    exportWithSilenceRemoval,
    clear,
    mixActiveTracks,
    encodeWavFloat32: encodeWavFloat32InWorker,
  };
});
