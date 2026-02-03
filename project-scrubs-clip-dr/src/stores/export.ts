import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useCleaningStore } from './cleaning';
import { useSilenceStore } from './silence';
import { useSettingsStore } from './settings';

// Helper to get the source path and time range for a track
function getTrackSource(track: Track, audioStore: ReturnType<typeof useAudioStore>, cleaningStore: ReturnType<typeof useCleaningStore>, silenceStore: ReturnType<typeof useSilenceStore>) {
  // Check for cleaned audio
  const cleanedEntry = cleaningStore.cleanedAudioFiles.get(track.id);
  if (cleanedEntry) {
    return {
      sourcePath: cleanedEntry.path,
      startTime: 0,
      endTime: cleanedEntry.duration,
    };
  }

  // Check for cut (silence removed) audio
  const cutEntry = silenceStore.cutAudioFiles.get(track.id);
  if (cutEntry) {
    return {
      sourcePath: cutEntry.path,
      startTime: 0,
      endTime: cutEntry.duration,
    };
  }

  // Use original audio - fallback to lastImportedPath
  const sourcePath = audioStore.lastImportedPath;
  if (!sourcePath) {
    throw new Error('No source file path available for track');
  }

  return {
    sourcePath,
    startTime: 0,
    endTime: track.duration,
  };
}
import type { ExportFormat, Track } from '@/shared/types';

export type Mp3Bitrate = 128 | 192 | 256 | 320;

export const useExportStore = defineStore('export', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const cleaningStore = useCleaningStore();
  const settingsStore = useSettingsStore();

  const loading = ref(false);
  const error = ref<string | null>(null);
  const progress = ref(0);
  const mp3Bitrate = ref<Mp3Bitrate>(192);

  // Get active (non-muted) tracks
  const activeTracks = computed(() => {
    const tracks = tracksStore.tracks;
    const hasSolo = tracks.some(t => t.solo);

    if (hasSolo) {
      return tracks.filter(t => t.solo && !t.muted);
    }
    return tracks.filter(t => !t.muted);
  });

  const canExport = computed(() => {
    return tracksStore.hasAudio && activeTracks.value.length > 0;
  });

  async function exportActiveTracks(format: ExportFormat = 'wav'): Promise<string | null> {
    if (!canExport.value) {
      error.value = 'Nothing to export';
      return null;
    }

    // Get file extension
    const extensions: Record<ExportFormat, string> = {
      wav: 'wav',
      mp3: 'mp3',
      flac: 'flac',
      ogg: 'ogg',
    };

    const ext = extensions[format];
    const trackName = activeTracks.value[0]?.name || 'audio';
    const defaultName = `${trackName.replace(/[^a-zA-Z0-9]/g, '_')}_export.${ext}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    try {
      const outputPath = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [
          { name: format.toUpperCase(), extensions: [ext] },
        ],
      });

      if (!outputPath) {
        return null; // User cancelled
      }

      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;
      progress.value = 0;

      // For now, export the first active track
      // TODO: Mix multiple tracks if needed
      const track = activeTracks.value[0];
      const silenceStore = useSilenceStore();

      // Get the appropriate source (cleaned, cut, or original)
      const source = getTrackSource(track, audioStore, cleaningStore, silenceStore);

      if (format === 'mp3') {
        await invoke('export_audio_mp3', {
          sourcePath: source.sourcePath,
          outputPath,
          startTime: source.startTime,
          endTime: source.endTime,
          bitrate: mp3Bitrate.value,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: source.sourcePath,
          outputPath,
          startTime: source.startTime,
          endTime: source.endTime,
        });
      }

      progress.value = 100;
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('Export error:', e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function exportTrack(track: Track, format: ExportFormat = 'wav'): Promise<string | null> {
    if (!tracksStore.hasAudio) {
      error.value = 'No audio loaded';
      return null;
    }

    const extensions: Record<ExportFormat, string> = {
      wav: 'wav',
      mp3: 'mp3',
      flac: 'flac',
      ogg: 'ogg',
    };

    const ext = extensions[format];
    const defaultName = `${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    try {
      const outputPath = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [
          { name: format.toUpperCase(), extensions: [ext] },
        ],
      });

      if (!outputPath) {
        return null;
      }

      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;

      const silenceStore = useSilenceStore();

      // Get the appropriate source (cleaned, cut, or original)
      const source = getTrackSource(track, audioStore, cleaningStore, silenceStore);

      if (format === 'mp3') {
        await invoke('export_audio_mp3', {
          sourcePath: source.sourcePath,
          outputPath,
          startTime: source.startTime,
          endTime: source.endTime,
          bitrate: mp3Bitrate.value,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: source.sourcePath,
          outputPath,
          startTime: source.startTime,
          endTime: source.endTime,
        });
      }

      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  function setMp3Bitrate(bitrate: Mp3Bitrate): void {
    mp3Bitrate.value = bitrate;
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

    const extensions: Record<ExportFormat, string> = {
      wav: 'wav',
      mp3: 'mp3',
      flac: 'flac',
      ogg: 'ogg',
    };

    const ext = extensions[format];
    const trackName = tracksStore.tracks[0]?.name || 'audio';
    const defaultName = `${trackName.replace(/[^a-zA-Z0-9]/g, '_')}_no_silence.${ext}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    try {
      const outputPath = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [
          { name: format.toUpperCase(), extensions: [ext] },
        ],
      });

      if (!outputPath) {
        return null;
      }

      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;
      progress.value = 0;

      // Build speech segments from gaps between active silence regions
      const duration = tracksStore.timelineDuration;
      const silenceRegions = silenceStore.activeSilenceRegions;

      // Sort by start time
      const sorted = [...silenceRegions].sort((a, b) => a.start - b.start);

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

      // Get source path from audioStore
      const sourcePath = audioStore.lastImportedPath;
      if (!sourcePath) {
        throw new Error('No source file path available');
      }

      // Call the backend to export
      await invoke('export_without_silence', {
        sourcePath,
        outputPath,
        speechSegments,
      });

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
  }

  return {
    loading,
    error,
    progress,
    activeTracks,
    canExport,
    mp3Bitrate,
    exportActiveTracks,
    exportTrack,
    exportWithSilenceRemoval,
    setMp3Bitrate,
    clear,
  };
});
