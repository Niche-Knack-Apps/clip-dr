import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useCleaningStore } from './cleaning';
import { useSettingsStore } from './settings';
import type { ExportFormat, Track } from '@/shared/types';

export const useExportStore = defineStore('export', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const cleaningStore = useCleaningStore();
  const settingsStore = useSettingsStore();

  const loading = ref(false);
  const error = ref<string | null>(null);
  const progress = ref(0);

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
    return audioStore.currentFile !== null && activeTracks.value.length > 0;
  });

  async function exportActiveTracks(format: ExportFormat = 'wav'): Promise<string | null> {
    if (!canExport.value || !audioStore.currentFile) {
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
    const defaultName = audioStore.currentFile.name.replace(/\.[^.]+$/, `_export.${ext}`);
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

      // Check if this track has cleaned audio
      const cleanedBuffer = cleaningStore.getBufferForTrack(track.id);

      if (cleanedBuffer) {
        // Export the cleaned audio buffer
        // For cleaned tracks, we need to export from the temp file
        const cleanedEntry = cleaningStore.cleanedAudioFiles.get(track.id);
        if (cleanedEntry) {
          await invoke('export_audio_region', {
            sourcePath: cleanedEntry.path,
            outputPath,
            startTime: 0,
            endTime: cleanedEntry.duration,
          });
        }
      } else {
        // Export from original audio
        await invoke('export_audio_region', {
          sourcePath: audioStore.currentFile.path,
          outputPath,
          startTime: track.start,
          endTime: track.end,
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
    if (!audioStore.currentFile) {
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

      const cleanedEntry = cleaningStore.cleanedAudioFiles.get(track.id);

      if (cleanedEntry) {
        await invoke('export_audio_region', {
          sourcePath: cleanedEntry.path,
          outputPath,
          startTime: 0,
          endTime: cleanedEntry.duration,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: audioStore.currentFile.path,
          outputPath,
          startTime: track.start,
          endTime: track.end,
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
    exportActiveTracks,
    exportTrack,
    clear,
  };
});
