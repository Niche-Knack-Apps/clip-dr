import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import type { Track } from '@/shared/types';
import { useHistoryStore } from './history';

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
  const transcriptionStore = useTranscriptionStore();

  const clipboard = ref<AudioClipboard | null>(null);
  const clipboardBuffer = ref<AudioBuffer | null>(null);

  const hasClipboard = computed(() => clipboard.value !== null);
  const clipboardDuration = computed(() => clipboard.value?.duration ?? 0);

  // Get the target track for operations: selected track, or first track when in ALL view
  function getTargetTrack(): Track | null {
    const selected = tracksStore.selectedTrack;
    if (selected) return selected;
    // In ALL view, fall back to first track
    if (tracksStore.selectedTrackId === 'ALL' && tracksStore.tracks.length > 0) {
      return tracksStore.tracks[0];
    }
    return null;
  }

  // Get the region to copy based on settings and I/O points
  function getCopyRegion(): { start: number; end: number; trackId: string; buffer: AudioBuffer } | null {
    const selectedTrack = getTargetTrack();
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

  // Cut: selected clip > I/O region ripple delete > entire track
  function cut(): boolean {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Cut');
    try {
    // Priority 1: Selected clip - cut it to clipboard and slide remaining left
    const selClip = tracksStore.selectedClip;
    if (selClip) {
      const { trackId, clip } = selClip;
      const ctx = audioStore.getAudioContext();

      // Copy clip audio to clipboard
      const clonedBuffer = ctx.createBuffer(
        clip.buffer.numberOfChannels,
        clip.buffer.length,
        clip.buffer.sampleRate
      );
      for (let ch = 0; ch < clip.buffer.numberOfChannels; ch++) {
        clonedBuffer.getChannelData(ch).set(clip.buffer.getChannelData(ch));
      }
      clipboardBuffer.value = clonedBuffer;

      const waveform = tracksStore.generateWaveformFromBuffer(clonedBuffer);
      clipboard.value = {
        samples: [],
        sampleRate: clonedBuffer.sampleRate,
        duration: clonedBuffer.duration,
        sourceRegion: { start: clip.clipStart, end: clip.clipStart + clip.duration },
        sourceTrackId: trackId,
        waveformData: waveform,
        copiedAt: Date.now(),
      };

      // Record gap position before deleting
      const gapStart = clip.clipStart;
      const gapDuration = clip.duration;

      // Remove the clip but keep the track (clip was selected, not the track)
      tracksStore.removeClipKeepTrack(trackId, clip.id);

      // Slide remaining clips left to close the gap
      tracksStore.slideTracksLeft(gapStart, gapDuration);

      tracksStore.clearClipSelection();
      console.log(`[Clipboard] Cut clip ${clip.id} (${gapDuration.toFixed(2)}s) from track ${trackId}`);
      return true;
    }

    // Priority 2: I/O points
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    const useInOutPoints = settingsStore.settings.clipboardUsesInOutPoints ?? true;
    const hasIOPoints = useInOutPoints && inPoint !== null && outPoint !== null;

    const ctx = audioStore.getAudioContext();

    if (hasIOPoints) {
      // Extract mixed audio BEFORE deleting (for clipboard)
      const extracted = tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx);

      // Ripple delete the I/O region from ALL tracks and close the gap
      const results = tracksStore.rippleDeleteRegion(inPoint, outPoint, ctx);

      if (results.buffers.length > 0) {
        // Store the mixed extraction in clipboard (or first cut buffer as fallback)
        const buf = extracted?.buffer ?? results.buffers[0];
        const waveform = extracted?.waveformData ?? results.waveforms[0] ?? [];
        clipboardBuffer.value = buf;
        clipboard.value = {
          samples: [],
          sampleRate: buf.sampleRate,
          duration: buf.duration,
          sourceRegion: { start: inPoint, end: outPoint },
          sourceTrackId: 'all',
          waveformData: waveform,
          copiedAt: Date.now(),
        };
        console.log(`[Clipboard] Ripple cut ${(outPoint - inPoint).toFixed(2)}s from ${results.buffers.length} track(s)`);

        // Shift transcription words to match the ripple delete
        for (const track of tracksStore.tracks) {
          transcriptionStore.adjustForCut(track.id, inPoint, outPoint);
        }
      }

      // Clear I/O points after cut
      selectionStore.clearInOutPoints();
      return results.buffers.length > 0;
    } else {
      // No I/O points - cut the target track entirely (keep empty track)
      const selectedTrack = getTargetTrack();
      if (!selectedTrack) return false;

      const trackStart = selectedTrack.trackStart;
      const trackDuration = selectedTrack.duration;
      const copied = copy();
      if (!copied) return false;

      tracksStore.clearTrackAudio(selectedTrack.id);
      tracksStore.slideTracksLeft(trackStart, trackDuration);
      console.log(`[Clipboard] Cut entire track ${selectedTrack.id}, kept empty, slid remaining tracks left`);
      return true;
    }
    } finally { historyStore.endBatch(); }
  }

  // Paste clipboard content - insert at playhead in selected track, or create new track
  function paste(): Track | null {
    if (!clipboard.value || !clipboardBuffer.value) {
      console.log('[Clipboard] Nothing to paste');
      return null;
    }
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Paste');
    try {

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

    // Check if a specific track is selected (not ALL view)
    const selectedTrack = tracksStore.selectedTrack;

    if (selectedTrack) {
      // Insert at playhead position (splits existing clips if needed)
      const playheadTime = playbackStore.currentTime;
      const waveform = [...clipboard.value.waveformData];
      console.log(`[Clipboard] Inserting ${clipboard.value.duration.toFixed(2)}s at playhead ${playheadTime.toFixed(2)}s in track "${selectedTrack.name}"`);

      const success = tracksStore.insertClipAtPlayhead(
        selectedTrack.id,
        clonedBuffer,
        waveform,
        playheadTime,
        ctx
      );

      if (success) {
        const updatedTrack = tracksStore.tracks.find(t => t.id === selectedTrack.id);
        console.log(`[Clipboard] Pasted at playhead, track duration: ${updatedTrack?.duration.toFixed(2)}s`);
        return updatedTrack ?? null;
      }
      // Fall through to create new track if insert failed
    }

    // No specific track selected or insert failed - create new track
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
    } finally { historyStore.endBatch(); }
  }

  // Delete: selected clip > I/O points > entire track
  function deleteSelected(): boolean {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Delete');
    try {
    // Priority 1: Selected clip
    const selClip = tracksStore.selectedClip;
    if (selClip) {
      console.log(`[Clipboard] deleteSelected: deleting selected clip ${selClip.clip.id} from track ${selClip.trackId}`);
      tracksStore.deleteClipFromTrack(selClip.trackId, selClip.clip.id);
      tracksStore.clearClipSelection();
      return true;
    }

    // Priority 2: I/O points
    const { inPoint, outPoint } = selectionStore.inOutPoints;

    if (inPoint !== null && outPoint !== null) {
      console.log(`[Clipboard] deleteSelected: removing segment ${inPoint.toFixed(2)}-${outPoint.toFixed(2)}s from all overlapping tracks`);
      const ctx = audioStore.getAudioContext();
      let cutCount = 0;

      // Cut from every track that overlaps the I/O region (no ripple shift)
      const trackIds = tracksStore.tracks.map(t => t.id);
      for (const trackId of trackIds) {
        const track = tracksStore.tracks.find(t => t.id === trackId);
        if (!track) continue;
        const trackEnd = track.trackStart + track.duration;
        if (track.trackStart >= outPoint || trackEnd <= inPoint) continue;

        const result = tracksStore.cutRegionFromTrack(trackId, inPoint, outPoint, ctx);
        if (result) cutCount++;
      }

      if (cutCount > 0) {
        // Adjust transcription: remove words in deleted region (no shift)
        for (const trackId of trackIds) {
          transcriptionStore.adjustForDelete(trackId, inPoint, outPoint);
        }
        selectionStore.clearInOutPoints();
        console.log(`[Clipboard] deleteSelected: removed segment from ${cutCount} track(s)`);
      }
      return cutCount > 0;
    } else {
      // Priority 3: Entire target track
      const selectedTrack = getTargetTrack();
      if (!selectedTrack) {
        console.log('[Clipboard] deleteSelected: no target track, nothing to do');
        return false;
      }
      console.log(`[Clipboard] deleteSelected: deleting entire track "${selectedTrack.name}" (${selectedTrack.id})`);
      transcriptionStore.removeTranscription(selectedTrack.id);
      tracksStore.deleteTrack(selectedTrack.id);
      return true;
    }
    } finally { historyStore.endBatch(); }
  }

  // Create clip: extract audio from I/O region across ALL tracks into a new track
  function createClip(): Track | null {
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    if (inPoint === null || outPoint === null) {
      console.log('[Clipboard] createClip: no I/O points set');
      return null;
    }
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Create clip');
    try {

    const ctx = audioStore.getAudioContext();
    const extracted = tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx);
    if (!extracted) {
      console.log('[Clipboard] createClip: no audio found in I/O region');
      return null;
    }

    // Create new track at end of timeline so it doesn't overlap
    const pasteTime = tracksStore.timelineDuration;
    const trackName = `Clip ${tracksStore.tracks.length + 1}`;

    const newTrack = tracksStore.createTrackFromBuffer(
      extracted.buffer,
      extracted.waveformData,
      trackName,
      pasteTime
    );

    console.log(`[Clipboard] Created clip "${trackName}" (${(outPoint - inPoint).toFixed(2)}s) at ${pasteTime.toFixed(2)}s`);
    selectionStore.clearInOutPoints();
    return newTrack;
    } finally { historyStore.endBatch(); }
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
    createClip,
    clear,
  };
});
