import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import type { Track } from '@/shared/types';

export interface AudioClipboard {
  samples: Float32Array[];
  sampleRate: number;
  duration: number;
  sourceRegion: { start: number; end: number };
  sourceTrackId: string;
  waveformData: number[];
  copiedAt: number;
}

export const useClipboardStore = defineStore('clipboard', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const selectionStore = useSelectionStore();
  const playbackStore = usePlaybackStore();
  const settingsStore = useSettingsStore();

  const clipboard = ref<AudioClipboard | null>(null);
  const clipboardBuffer = ref<AudioBuffer | null>(null);

  const hasClipboard = computed(() => clipboard.value !== null);
  const clipboardDuration = computed(() => clipboard.value?.duration ?? 0);

  // Get the region to copy based on settings and I/O points
  function getCopyRegion(): { start: number; end: number; trackId: string; buffer: AudioBuffer } | null {
    const selectedTrack = tracksStore.selectedTrack;
    if (!selectedTrack) return null;

    const buffer = selectedTrack.audioData.buffer;
    if (!buffer) return null;

    // Check settings for whether to use I/O points or track bounds
    const useInOutPoints = settingsStore.settings.clipboardUsesInOutPoints ?? true;

    if (useInOutPoints) {
      const { inPoint, outPoint } = selectionStore.inOutPoints;
      if (inPoint !== null && outPoint !== null) {
        // I/O points are in timeline time, convert to track-relative
        const trackStart = selectedTrack.trackStart;
        const relativeStart = inPoint - trackStart;
        const relativeEnd = outPoint - trackStart;

        // Clamp to track bounds
        const start = Math.max(0, relativeStart);
        const end = Math.min(selectedTrack.duration, relativeEnd);

        if (end > start) {
          return { start, end, trackId: selectedTrack.id, buffer };
        }
      }
    }

    // Use entire track
    return {
      start: 0,
      end: selectedTrack.duration,
      trackId: selectedTrack.id,
      buffer,
    };
  }

  // Copy the selected region to clipboard
  function copy(): boolean {
    const region = getCopyRegion();
    if (!region) {
      console.log('[Clipboard] Nothing to copy - no region or track selected');
      return false;
    }

    const { start, end, trackId, buffer } = region;
    const startSample = Math.floor(start * buffer.sampleRate);
    const endSample = Math.floor(end * buffer.sampleRate);
    const sampleCount = endSample - startSample;

    if (sampleCount <= 0) {
      console.log('[Clipboard] Invalid sample range');
      return false;
    }

    // Extract samples from each channel
    const samples: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channelData = buffer.getChannelData(ch);
      const extracted = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        extracted[i] = channelData[startSample + i];
      }
      samples.push(extracted);
    }

    // Create AudioBuffer for playback preview
    const ctx = audioStore.getAudioContext();
    const newBuffer = ctx.createBuffer(
      buffer.numberOfChannels,
      sampleCount,
      buffer.sampleRate
    );
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      // Copy channel data - create a new Float32Array to ensure correct type
      const channelData = newBuffer.getChannelData(ch);
      channelData.set(samples[ch]);
    }
    clipboardBuffer.value = newBuffer;

    // Generate waveform for the clipboard content
    const waveformData = tracksStore.generateWaveformFromBuffer(newBuffer);

    clipboard.value = {
      samples,
      sampleRate: buffer.sampleRate,
      duration: end - start,
      sourceRegion: { start, end },
      sourceTrackId: trackId,
      waveformData,
      copiedAt: Date.now(),
    };

    console.log(`[Clipboard] Copied ${(end - start).toFixed(2)}s from track ${trackId}`);
    return true;
  }

  // Cut the selected region (copy + delete track or region)
  function cut(): boolean {
    const selectedTrack = tracksStore.selectedTrack;
    if (!selectedTrack) return false;

    // Check if we're cutting a region (I/O points) or whole track
    const useInOutPoints = settingsStore.settings.clipboardUsesInOutPoints ?? true;
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    const hasIOPoints = useInOutPoints && inPoint !== null && outPoint !== null;

    const ctx = audioStore.getAudioContext();

    if (hasIOPoints) {
      // Cutting a region - use cutRegionFromTrack which handles splitting
      const result = tracksStore.cutRegionFromTrack(
        selectedTrack.id,
        inPoint,
        outPoint,
        ctx
      );

      if (result) {
        // Store cut audio in clipboard
        clipboardBuffer.value = result.buffer;
        clipboard.value = {
          samples: [], // Not used directly anymore
          sampleRate: result.buffer.sampleRate,
          duration: result.buffer.duration,
          sourceRegion: { start: inPoint, end: outPoint },
          sourceTrackId: selectedTrack.id,
          waveformData: result.waveformData,
          copiedAt: Date.now(),
        };
        console.log(`[Clipboard] Cut region ${(outPoint - inPoint).toFixed(2)}s from track`);

        // Clear I/O points after cut
        selectionStore.clearInOutPoints();
        return true;
      }
      return false;
    } else {
      // Cutting the whole track - copy first, then delete
      const copied = copy();
      if (!copied) return false;

      tracksStore.deleteTrack(selectedTrack.id);
      console.log(`[Clipboard] Cut entire track ${selectedTrack.id}`);
      return true;
    }
  }

  // Paste clipboard content - append to selected track or create new track
  function paste(): Track | null {
    if (!clipboard.value || !clipboardBuffer.value) {
      console.log('[Clipboard] Nothing to paste');
      return null;
    }

    const ctx = audioStore.getAudioContext();
    const sourceBuffer = clipboardBuffer.value;

    // Clone the buffer to avoid sharing references
    const clonedBuffer = ctx.createBuffer(
      sourceBuffer.numberOfChannels,
      sourceBuffer.length,
      sourceBuffer.sampleRate
    );
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
      clonedBuffer.getChannelData(ch).set(sourceBuffer.getChannelData(ch));
    }

    // Check if a specific track is selected (not 'ALL' view)
    const selectedTrack = tracksStore.selectedTrack;

    if (selectedTrack) {
      // Append to selected track
      console.log(`[Clipboard] Appending ${clipboard.value.duration.toFixed(2)}s to track "${selectedTrack.name}"`);

      const success = tracksStore.appendAudioToTrack(
        selectedTrack.id,
        clonedBuffer,
        ctx
      );

      if (success) {
        // Re-fetch the track since it was replaced in the array
        const updatedTrack = tracksStore.selectedTrack;
        console.log(`[Clipboard] Pasted to existing track, new duration: ${updatedTrack?.duration.toFixed(2)}s`);
        return updatedTrack;
      }
      // Fall through to create new track if append failed
    }

    // No track selected (ALL view) or append failed - create new track
    const pasteTime = playbackStore.currentTime;
    const trackName = `Pasted ${tracksStore.tracks.length + 1}`;
    console.log(`[Clipboard] Creating NEW track "${trackName}" at time ${pasteTime.toFixed(2)}s`);

    const newTrack = tracksStore.createTrackFromBuffer(
      clonedBuffer,
      [...clipboard.value.waveformData],
      trackName,
      pasteTime
    );

    console.log(`[Clipboard] Pasted ${clipboard.value.duration.toFixed(2)}s, new track ID: ${newTrack.id}`);
    return newTrack;
  }

  // Delete selected track without copying to clipboard
  function deleteSelected(): boolean {
    const selectedTrack = tracksStore.selectedTrack;
    if (!selectedTrack) return false;

    tracksStore.deleteTrack(selectedTrack.id);
    console.log(`[Clipboard] Deleted track ${selectedTrack.id}`);
    return true;
  }

  // Clear clipboard
  function clear(): void {
    clipboard.value = null;
    clipboardBuffer.value = null;
  }

  return {
    clipboard,
    clipboardBuffer,
    hasClipboard,
    clipboardDuration,
    copy,
    cut,
    paste,
    deleteSelected,
    clear,
  };
});
