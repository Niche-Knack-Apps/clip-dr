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
import type { ExportFormat, ExportProfile, Track } from '@/shared/types';

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

  // Get active (non-muted) tracks, excluding tracks still importing
  const activeTracks = computed(() => {
    const tracks = tracksStore.tracks.filter(t => !t.importStatus || t.importStatus === 'ready');
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

      return await doMixedExport(outputPath, format, profile.mp3Bitrate || 192);
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
      return await doMixedExport(lastPath, format, profile.mp3Bitrate || 192);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Quick re-export error:', e);
      return null;
    }
  }

  /**
   * Core mixed export logic — used by both exportWithProfile and quickReExport.
   */
  async function doMixedExport(outputPath: string, format: ExportFormat, bitrate: number): Promise<string | null> {
    loading.value = true;
    error.value = null;
    progress.value = 10;
    lastExportResult.value = null;

    try {
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

      const audioContext = audioStore.getAudioContext();
      const trackBuffer = mixSingleTrack(track.id, audioContext);

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
      } else {
        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
        });
      }

      lastExportResult.value = outputPath;
      console.log('[Export] Track export complete:', track.name, '->', outputPath);
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Track export error:', e);
      return null;
    } finally {
      loading.value = false;
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

    for (const clip of clips) {
      timelineStart = Math.min(timelineStart, clip.clipStart);
      timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
      sampleRate = clip.buffer.sampleRate;
    }

    const totalDuration = timelineEnd - timelineStart;
    const totalSamples = Math.ceil(totalDuration * sampleRate);
    const numChannels = Math.max(...clips.map(c => c.buffer.numberOfChannels));
    const mixedBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);

    for (const clip of clips) {
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
    }> = [];

    for (const track of tracks) {
      const clips = tracksStore.getTrackClips(track.id);
      for (const clip of clips) {
        timelineStart = Math.min(timelineStart, clip.clipStart);
        timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
        sampleRate = clip.buffer.sampleRate;
        allClips.push({
          buffer: clip.buffer,
          clipStart: clip.clipStart,
          duration: clip.duration,
          volume: track.volume,
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
      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);
        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            outputData[startSample + i] += inputData[i] * clip.volume;
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

  function encodeWav(buffer: AudioBuffer): Uint8Array {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = buffer.length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }

    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Uint8Array(arrayBuffer);
  }

  function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  return {
    loading,
    error,
    progress,
    activeTracks,
    canExport,
    canQuickReExport,
    lastExportResult,
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
