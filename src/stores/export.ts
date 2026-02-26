import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSilenceStore } from './silence';
import { useSettingsStore } from './settings';
import { listen } from '@tauri-apps/api/event';
import type { ExportFormat, ExportProfile, ExportEDL, ExportEDLTrack, Track, TrackClip, VolumeAutomationPoint } from '@/shared/types';
import { encodeWav } from '@/shared/audio-utils';

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

export const useExportStore = defineStore('export', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const settingsStore = useSettingsStore();

  const loading = ref(false);
  const error = ref<string | null>(null);
  const progress = ref(0);
  const lastExportResult = ref<string | null>(null);
  const currentExportPath = ref<string | null>(null);

  // Get active (non-muted) tracks, excluding tracks still importing
  const activeTracks = computed(() => {
    const tracks = tracksStore.tracks.filter(t =>
      !t.importStatus || t.importStatus === 'ready' || t.importStatus === 'large-file'
    );
    const hasSolo = tracks.some(t => t.solo);

    if (hasSolo) {
      return tracks.filter(t => t.solo && !t.muted);
    }
    return tracks.filter(t => !t.muted);
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

    try {
      return await doMixedExport(lastPath, format, profile.mp3Bitrate || 192, profile.oggQuality);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Quick re-export error:', e);
      return null;
    }
  }

  /**
   * Check if all active tracks have source paths (can use EDL export).
   */
  function canUseEdlExport(tracks: Track[]): boolean {
    return tracks.length > 0 && tracks.every(t =>
      !!(t.cachedAudioPath || t.sourcePath) && (!t.clips || t.clips.length === 0)
    );
  }

  /**
   * Build an EDL from active tracks for Rust-side streaming export.
   */
  function buildEdl(tracks: Track[], outputPath: string, format: ExportFormat, bitrate: number, oggQuality?: number): ExportEDL {
    // Use the sample rate of the first track, or default to 44100
    const firstTrack = tracks[0];
    const sampleRate = firstTrack?.audioData.sampleRate || 44100;
    const channels = Math.min(firstTrack?.audioData.channels || 2, 2) as number;

    const edlTracks: ExportEDLTrack[] = tracks.map(t => ({
      source_path: t.cachedAudioPath || t.sourcePath!,
      track_start: t.trackStart,
      duration: t.duration,
      volume: t.volume,
      volume_envelope: t.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })),
    }));

    // Timeline range: from 0 to the end of the last track
    const endTime = Math.max(...tracks.map(t => t.trackStart + t.duration));

    return {
      tracks: edlTracks,
      output_path: outputPath,
      format: format,
      sample_rate: sampleRate,
      channels,
      mp3_bitrate: format === 'mp3' ? bitrate : undefined,
      ogg_quality: format === 'ogg' ? (oggQuality ?? 0.4) : undefined,
      start_time: 0,
      end_time: endTime,
    };
  }

  /**
   * Core mixed export logic — used by both exportWithProfile and quickReExport.
   * Uses EDL streaming export when all tracks have source paths (handles large files).
   * Falls back to JS AudioBuffer mixing for tracks without source paths.
   */
  async function doMixedExport(outputPath: string, format: ExportFormat, bitrate: number, oggQuality?: number): Promise<string | null> {
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

      // Use EDL streaming export when possible (required for large files)
      if (canUseEdlExport(tracks)) {
        const edl = buildEdl(tracks, outputPath, format, bitrate, oggQuality);

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
      const audioContext = audioStore.getAudioContext();
      progress.value = 30;

      const mixedBuffer = mixActiveTracks(audioContext);
      if (!mixedBuffer) {
        throw new Error('Failed to mix tracks');
      }
      progress.value = 50;

      const tempDirPath = await tempDir();
      const ensurePath = (fileName: string) => `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${fileName}`;

      const wavData = encodeWav(mixedBuffer);
      const tempFileName = `mixed_temp_${Date.now()}.wav`;
      await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
      const tempPath = ensurePath(tempFileName);
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

      // Use EDL path for tracks with source paths and no unflattened clips
      if ((currentTrack.cachedAudioPath || currentTrack.sourcePath) && (!currentTrack.clips || currentTrack.clips.length === 0)) {
        const edl = buildEdl([currentTrack], outputPath, format, profile.mp3Bitrate || 192, profile.oggQuality);

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
      const trackBuffer = mixSingleTrack(currentTrack.id, audioContext);

      if (!trackBuffer) {
        throw new Error('No audio clips to export for this track');
      }

      const wavData = encodeWav(trackBuffer);
      const tempFileName = `track_export_${Date.now()}.wav`;
      await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
      const tempDirPath = await tempDir();
      const tempPath = `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${tempFileName}`;

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
   * Legacy: export active tracks (uses favorite profile).
   */
  async function exportActiveTracks(): Promise<string | null> {
    const profile = settingsStore.getFavoriteProfile();
    if (!profile) return null;
    return exportWithProfile(profile);
  }

  /**
   * Legacy: export mixed tracks (uses favorite profile).
   */
  async function exportMixedTracks(): Promise<string | null> {
    const profile = settingsStore.getFavoriteProfile();
    if (!profile) return null;
    return exportWithProfile(profile);
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

    for (const clip of bufferedClips) {
      const startSample = Math.floor((clip.clipStart - timelineStart) * sampleRate);
      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);
        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            outputData[startSample + i] += inputData[i];
          }
        }
      }
    }
    return mixedBuffer;
  }

  async function exportWithSilenceRemoval(format: ExportFormat = 'wav'): Promise<string | null> {
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
      // Determine if we need per-sample envelope evaluation
      const hasEnvelope = clip.volumeEnvelope && clip.volumeEnvelope.length > 0;

      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);
        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            let vol = clip.volume;
            if (hasEnvelope) {
              // Compute track-relative time for this sample
              const timelineTime = timelineStart + (startSample + i) / sampleRate;
              const trackRelTime = timelineTime - clip.trackStart;
              vol = tracksStore.interpolateEnvelope(clip.volumeEnvelope!, clip.volume, trackRelTime);
            }
            outputData[startSample + i] += inputData[i] * vol;
          }
        }
      }
    }

    // Normalize to prevent clipping
    let maxAbs = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = mixedBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(data[i]));
      }
    }
    if (maxAbs > 1) {
      const scale = 0.95 / maxAbs;
      for (let ch = 0; ch < numChannels; ch++) {
        const data = mixedBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          data[i] *= scale;
        }
      }
    }

    return mixedBuffer;
  }

  // encodeWav imported from @/shared/audio-utils

  return {
    loading,
    error,
    progress,
    activeTracks,
    canExport,
    canQuickReExport,
    lastExportResult,
    currentExportPath,
    exportActiveTracks,
    exportMixedTracks,
    exportTrack,
    exportWithProfile,
    exportTrackWithProfile,
    quickReExport,
    exportWithSilenceRemoval,
    clear,
    mixActiveTracks,
    encodeWav,
  };
});
