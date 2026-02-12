import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
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
  const mp3Bitrate = ref<Mp3Bitrate>(settingsStore.settings.defaultMp3Bitrate || 192);

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
    console.log(`[Export] Starting active tracks export, format: ${format}, tracks: ${activeTracks.value.length}`);
    if (!canExport.value) {
      console.warn('[Export] Cannot export - no audio or no active tracks');
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
        console.log('[Export] User cancelled save dialog');
        return null; // User cancelled
      }

      console.log(`[Export] Save path selected: ${outputPath}`);
      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;
      progress.value = 0;

      // For now, export the first active track
      // TODO: Mix multiple tracks if needed
      const track = activeTracks.value[0];
      console.log(`[Export] Exporting track: "${track.name}", duration: ${track.duration.toFixed(2)}s`);
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
      console.log(`[Export] Active tracks export complete: ${outputPath}`);
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Active tracks export error:', e);
      return null;
    } finally {
      loading.value = false;
    }
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

  /**
   * Export a single track using its current buffer state (after edits/cuts).
   */
  async function exportTrack(track: Track, format: ExportFormat = 'wav'): Promise<string | null> {
    console.log(`[Export] Starting single track export: "${track.name}", format: ${format}, duration: ${track.duration.toFixed(2)}s`);
    if (!tracksStore.hasAudio) {
      console.warn('[Export] No audio loaded');
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
        console.log('[Export] User cancelled track export save dialog');
        return null;
      }

      console.log(`[Export] Track export save path: ${outputPath}`);
      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;

      // Get audio context and mix track's clips into single buffer
      const audioContext = audioStore.getAudioContext();
      console.log('[Export] Mixing track clips into single buffer...');
      const trackBuffer = mixSingleTrack(track.id, audioContext);

      if (!trackBuffer) {
        throw new Error('No audio clips to export for this track');
      }

      console.log(`[Export] Track buffer mixed: ${trackBuffer.duration.toFixed(2)}s, ${trackBuffer.numberOfChannels}ch, ${trackBuffer.sampleRate}Hz`);

      // Encode to WAV and write to temp file
      const wavData = encodeWav(trackBuffer);
      console.log(`[Export] WAV encoded: ${(wavData.length / 1024).toFixed(0)}KB`);
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
          bitrate: mp3Bitrate.value,
        });
      } else {
        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: trackBuffer.duration,
        });
      }

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

  /**
   * Mix all active tracks/clips into a single AudioBuffer.
   * Handles clip positions on the timeline and respects mute/solo.
   */
  function mixActiveTracks(audioContext: AudioContext): AudioBuffer | null {
    const tracks = activeTracks.value;
    if (tracks.length === 0) return null;

    // Find timeline bounds
    let timelineStart = Infinity;
    let timelineEnd = 0;
    let sampleRate = 44100;

    // Gather all clips from active tracks
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

    // Normalize timeline to start at 0
    const totalDuration = timelineEnd - timelineStart;
    const totalSamples = Math.ceil(totalDuration * sampleRate);
    const numChannels = Math.max(...allClips.map(c => c.buffer.numberOfChannels));

    // Create output buffer
    const mixedBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);

    // Mix each clip into the output buffer
    for (const clip of allClips) {
      const startSample = Math.floor((clip.clipStart - timelineStart) * sampleRate);

      for (let ch = 0; ch < numChannels; ch++) {
        const outputData = mixedBuffer.getChannelData(ch);
        const inputCh = Math.min(ch, clip.buffer.numberOfChannels - 1);
        const inputData = clip.buffer.getChannelData(inputCh);

        for (let i = 0; i < inputData.length && startSample + i < totalSamples; i++) {
          if (startSample + i >= 0) {
            // Mix (add) with volume applied
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

  /**
   * Encode AudioBuffer to WAV format.
   */
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

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave channels and write samples
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

  /**
   * Export all active tracks mixed together (toolbar export).
   * This mixes all non-muted tracks into a single file.
   */
  async function exportMixedTracks(format: ExportFormat = 'wav'): Promise<string | null> {
    if (!canExport.value) {
      error.value = 'Nothing to export';
      return null;
    }

    const extensions: Record<ExportFormat, string> = {
      wav: 'wav',
      mp3: 'mp3',
      flac: 'flac',
      ogg: 'ogg',
    };

    const ext = extensions[format];
    const defaultName = `mixed_export.${ext}`;
    const lastFolder = settingsStore.settings.lastExportFolder || undefined;

    try {
      const outputPath = await save({
        defaultPath: lastFolder ? `${lastFolder}/${defaultName}` : defaultName,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });

      if (!outputPath) {
        return null;
      }

      settingsStore.setLastExportFolder(outputPath);
      loading.value = true;
      error.value = null;
      progress.value = 10;

      // Get audio context for mixing
      const audioContext = audioStore.getAudioContext();

      // Mix all active tracks
      progress.value = 30;
      const mixedBuffer = mixActiveTracks(audioContext);
      if (!mixedBuffer) {
        throw new Error('Failed to mix tracks');
      }

      progress.value = 50;

      // Get temp directory path once
      const tempDirPath = await tempDir();
      const ensurePath = (fileName: string) => `${tempDirPath}${tempDirPath.endsWith('/') ? '' : '/'}${fileName}`;

      if (format === 'wav') {
        // Encode to WAV and write directly
        const wavData = encodeWav(mixedBuffer);
        progress.value = 70;

        // Write to temp file first, then use Rust to move/convert
        const tempFileName = `mixed_temp_${Date.now()}.wav`;
        await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
        const tempPath = ensurePath(tempFileName);

        // Use Rust to copy to final location (handles permissions)
        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
        });
      } else if (format === 'mp3') {
        // For MP3, write temp WAV then convert
        const wavData = encodeWav(mixedBuffer);
        const tempFileName = `mixed_temp_${Date.now()}.wav`;
        await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
        const tempPath = ensurePath(tempFileName);

        progress.value = 70;
        await invoke('export_audio_mp3', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
          bitrate: mp3Bitrate.value,
        });
      } else {
        // For other formats, write temp WAV and use Rust to convert
        const wavData = encodeWav(mixedBuffer);
        const tempFileName = `mixed_temp_${Date.now()}.wav`;
        await writeFile(tempFileName, wavData, { baseDir: BaseDirectory.Temp });
        const tempPath = ensurePath(tempFileName);

        await invoke('export_audio_region', {
          sourcePath: tempPath,
          outputPath,
          startTime: 0,
          endTime: mixedBuffer.duration,
        });
      }

      progress.value = 100;
      console.log('[Export] Mixed export complete:', outputPath);
      return outputPath;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[Export] Mixed export error:', e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  return {
    loading,
    error,
    progress,
    activeTracks,
    canExport,
    mp3Bitrate,
    exportActiveTracks,
    exportMixedTracks,
    exportTrack,
    exportWithSilenceRemoval,
    setMp3Bitrate,
    clear,
    mixActiveTracks,
    encodeWav,
  };
});
