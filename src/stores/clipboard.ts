import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import { useUIStore } from './ui';
import type { Track } from '@/shared/types';
import { useHistoryStore } from './history';
import { encodeWavFloat32 } from '@/shared/audio-utils';
import { writeTempFile } from '@/shared/fs-utils';

export interface VirtualClipboardSegment {
  sourceFile: string;
  sourceOffset: number;
  duration: number;
  offsetInRegion: number;
  gain?: number;    // linear, default 1.0 — reserved for future use
  pan?: number;     // -1..+1, default 0 — reserved for future use
}

export interface AudioClipboard {
  samples: Float32Array[];
  sampleRate: number;
  duration: number;
  sourceRegion: { start: number; end: number };
  sourceTrackId: string;
  waveformData: number[];
  copiedAt: number;
  /** Virtual source for large-file regions — audio materialized on paste */
  virtualSource?: {
    kind: 'mixdown';
    segments: VirtualClipboardSegment[];
    sampleRate: number;
    channels: number;
  };
}

export const useClipboardStore = defineStore('clipboard', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const selectionStore = useSelectionStore();
  const playbackStore = usePlaybackStore();
  const settingsStore = useSettingsStore();
  const transcriptionStore = useTranscriptionStore();

  // Mutex: prevent concurrent cut/paste/delete operations
  const operationInProgress = ref(false);

  // Cache small-file clips as individual WAVs for Rust playback
  // EDL clips (with sourceFile) already point to their source — no caching needed
  async function cacheClipsForPlayback(): Promise<void> {
    for (const track of tracksStore.tracks) {
      if (!track.clips || track.clips.length === 0) continue;
      for (const clip of track.clips) {
        // EDL clips already have sourceFile — skip
        if (clip.sourceFile) continue;
        // No buffer — skip (shouldn't happen for small files, but guard)
        if (!clip.buffer) continue;

        try {
          const wavData = encodeWavFloat32(clip.buffer);
          clip.sourceFile = await writeTempFile(`clip_${clip.id}_${Date.now()}.wav`, wavData);
          clip.sourceOffset = 0;
        } catch (err) {
          console.error('[Clipboard] Failed to cache clip WAV:', err);
        }
      }
    }
  }

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
  async function getCopyRegion(): Promise<{ start: number; end: number; trackId: string; buffer: AudioBuffer } | null> {
    const selectedTrack = getTargetTrack();
    if (!selectedTrack) return null;

    let buffer = selectedTrack.audioData.buffer;

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
          // Large-file fallback: extract via Rust if no in-memory buffer
          if (!buffer && (selectedTrack.cachedAudioPath || selectedTrack.sourcePath)) {
            const ctx = audioStore.getAudioContext();
            const rustBuffer = await tracksStore.extractRegionViaRust(selectedTrack, start, end, ctx);
            if (rustBuffer) return { start, end, trackId: selectedTrack.id, buffer: rustBuffer };
            return null;
          }
          if (!buffer) return null;
          return { start, end, trackId: selectedTrack.id, buffer };
        }
      }
    }

    // Use entire track — large-file fallback for full track
    if (!buffer && (selectedTrack.cachedAudioPath || selectedTrack.sourcePath)) {
      const ctx = audioStore.getAudioContext();
      const rustBuffer = await tracksStore.extractRegionViaRust(selectedTrack, 0, selectedTrack.duration, ctx);
      if (rustBuffer) return { start: 0, end: selectedTrack.duration, trackId: selectedTrack.id, buffer: rustBuffer };
      return null;
    }
    if (!buffer) return null;

    return {
      start: 0,
      end: selectedTrack.duration,
      trackId: selectedTrack.id,
      buffer,
    };
  }

  // Copy the selected region to clipboard
  async function copy(): Promise<boolean> {
    const region = await getCopyRegion();
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
    const waveformData = await tracksStore.generateWaveformFromBuffer(newBuffer);

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
  async function cut(): Promise<boolean> {
    if (operationInProgress.value) {
      useUIStore().showToast('Another edit is in progress. Please wait.', 'warn');
      return false;
    }
    operationInProgress.value = true;
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Cut');
    try {
    // Priority 1: Selected clip - cut it to clipboard and slide remaining left
    const selClip = tracksStore.selectedClip;
    if (selClip) {
      const { trackId, clip } = selClip;
      const ctx = audioStore.getAudioContext();

      // Copy clip audio to clipboard (requires buffer — large-file clips can't be cut this way)
      if (!clip.buffer) return false;
      const clonedBuffer = ctx.createBuffer(
        clip.buffer.numberOfChannels,
        clip.buffer.length,
        clip.buffer.sampleRate
      );
      for (let ch = 0; ch < clip.buffer.numberOfChannels; ch++) {
        clonedBuffer.getChannelData(ch).set(clip.buffer.getChannelData(ch));
      }
      clipboardBuffer.value = clonedBuffer;

      const waveform = await tracksStore.generateWaveformFromBuffer(clonedBuffer);
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

      // Adjust timemarks and volume envelope before sliding (uses pre-slide positions)
      const gapEnd = gapStart + gapDuration;
      for (const track of tracksStore.tracks) {
        tracksStore.adjustTimemarksForCut(track.id, gapStart, gapEnd);
        tracksStore.adjustVolumeEnvelopeForCut(track.id, gapStart, gapEnd);
      }

      // Slide remaining clips left to close the gap
      tracksStore.slideTracksLeft(gapStart, gapDuration);

      tracksStore.clearClipSelection();
      playbackStore.seek(Math.max(0, gapStart - 1.0));
      console.log(`[Clipboard] Cut clip ${clip.id} (${gapDuration.toFixed(2)}s) from track ${trackId}`);
      return true;
    }

    // Priority 2: I/O points
    const { inPoint, outPoint } = selectionStore.inOutPoints;
    const useInOutPoints = settingsStore.settings.clipboardUsesInOutPoints ?? true;
    const hasIOPoints = useInOutPoints && inPoint !== null && outPoint !== null;

    const ctx = audioStore.getAudioContext();

    if (hasIOPoints) {
      // Determine if any overlapping track lacks an in-memory buffer
      const hasLargeFile = tracksStore.tracks.some(t => {
        const trackEnd = t.trackStart + t.duration;
        if (t.trackStart >= outPoint || trackEnd <= inPoint) return false;
        return !t.audioData.buffer;
      });

      let extracted: { buffer: AudioBuffer; waveformData: number[] } | null = null;
      let virtualSegments: VirtualClipboardSegment[] | null = null;
      let sr = 44100;
      let ch = 2;
      let clipWaveform: number[] = [];

      if (hasLargeFile) {
        // Large file: collect virtual clipboard segments (instant, metadata only)
        // Capture format and waveform BEFORE ripple delete modifies/removes tracks
        virtualSegments = tracksStore.collectVirtualClipboardSegments(inPoint, outPoint);
        ({ sampleRate: sr, channels: ch } = tracksStore.getContributingFormat(inPoint, outPoint));
        clipWaveform = tracksStore.sliceWaveformForRegion(inPoint, outPoint);
      } else {
        // Small file: extract audio (fast, in-memory)
        extracted = await tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx);
      }

      // Ripple delete — ALWAYS edit-only (no extraction)
      const results = await tracksStore.rippleDeleteRegion(inPoint, outPoint, ctx, { mode: 'edit-only' });

      if (results.affectedCount > 0) {
        if (extracted) {
          // Small file: use extracted buffer directly
          clipboardBuffer.value = extracted.buffer;
          clipboard.value = {
            samples: [],
            sampleRate: extracted.buffer.sampleRate,
            duration: extracted.buffer.duration,
            sourceRegion: { start: inPoint, end: outPoint },
            sourceTrackId: 'all',
            waveformData: extracted.waveformData,
            copiedAt: Date.now(),
          };
        } else if (virtualSegments && virtualSegments.length > 0) {
          // Large file: store virtual clipboard reference (format/waveform captured above)
          clipboardBuffer.value = null;
          clipboard.value = {
            samples: [],
            sampleRate: sr,
            duration: outPoint - inPoint,
            sourceRegion: { start: inPoint, end: outPoint },
            sourceTrackId: 'all',
            waveformData: clipWaveform,
            copiedAt: Date.now(),
            virtualSource: {
              kind: 'mixdown',
              segments: virtualSegments,
              sampleRate: sr,
              channels: ch,
            },
          };
        }

        console.log(`[Clipboard] Ripple cut ${(outPoint - inPoint).toFixed(2)}s from ${results.affectedCount} track(s)`);

        // Shift transcription words to match the ripple delete
        for (const track of tracksStore.tracks) {
          transcriptionStore.adjustForCut(track.id, inPoint, outPoint);
        }

        // Cache small-file clips for Rust playback (EDL clips already have sourceFile)
        const recachePromise = cacheClipsForPlayback();
        tracksStore.setPendingRecache(recachePromise);
      }

      // Clear I/O points after cut
      selectionStore.clearInOutPoints();
      if (results.affectedCount > 0) {
        playbackStore.seek(Math.max(0, inPoint! - 1.0));
      }
      return results.affectedCount > 0;
    } else {
      // No I/O points - cut the target track entirely (keep empty track)
      const selectedTrack = getTargetTrack();
      if (!selectedTrack) return false;

      const trackStart = selectedTrack.trackStart;
      const trackDuration = selectedTrack.duration;
      const copied = await copy();
      if (!copied) return false;

      tracksStore.clearTrackAudio(selectedTrack.id);

      // Adjust timemarks and volume envelope before sliding (uses pre-slide positions)
      const cutEnd = trackStart + trackDuration;
      for (const track of tracksStore.tracks) {
        tracksStore.adjustTimemarksForCut(track.id, trackStart, cutEnd);
        tracksStore.adjustVolumeEnvelopeForCut(track.id, trackStart, cutEnd);
      }

      tracksStore.slideTracksLeft(trackStart, trackDuration);
      playbackStore.seek(Math.max(0, trackStart - 1.0));
      console.log(`[Clipboard] Cut entire track ${selectedTrack.id}, kept empty, slid remaining tracks left`);
      return true;
    }
    } finally {
      historyStore.endBatch();
      operationInProgress.value = false;
    }
  }

  const PASTE_MATERIALIZE_CEILING_SECS = 300; // 5 minutes max for in-memory paste

  // Paste clipboard content - insert at playhead in selected track, or create new track
  async function paste(): Promise<Track | null> {
    if (!clipboard.value) {
      console.log('[Clipboard] Nothing to paste');
      return null;
    }
    if (operationInProgress.value) {
      useUIStore().showToast('Another edit is in progress. Please wait.', 'warn');
      return null;
    }
    operationInProgress.value = true;
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Paste');
    try {

    const vs = clipboard.value.virtualSource;

    // Virtual clipboard: decide whether to materialize or paste as EDL
    if (vs && !clipboardBuffer.value) {
      if (clipboard.value.duration <= PASTE_MATERIALIZE_CEILING_SECS) {
        // Small enough to materialize into an AudioBuffer
        const matCtx = audioStore.getAudioContext();
        const materialized = await tracksStore.materializeVirtualClipboard(vs, matCtx);
        if (materialized) {
          clipboardBuffer.value = materialized;
        }
      } else {
        // Too large — paste as EDL clips on a new track (instant)
        const pasteTime = playbackStore.currentTime;
        const newTrack = tracksStore.createEDLTrackFromSegments(
          vs.segments,
          clipboard.value.waveformData,
          vs.sampleRate,
          vs.channels,
          `Pasted ${tracksStore.tracks.length + 1}`,
          pasteTime
        );
        return newTrack;
      }
    }

    if (!clipboardBuffer.value) {
      console.log('[Clipboard] Nothing to paste - no buffer available');
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

    // Check if a specific track is selected (not ALL view)
    const selectedTrack = tracksStore.selectedTrack;

    if (selectedTrack) {
      // Insert at playhead position (splits existing clips if needed)
      const playheadTime = playbackStore.currentTime;
      const waveform = [...clipboard.value.waveformData];
      console.log(`[Clipboard] Inserting ${clipboard.value.duration.toFixed(2)}s at playhead ${playheadTime.toFixed(2)}s in track "${selectedTrack.name}"`);

      // Satisfy C2: resolve sourceFile from the source track so new clip has EDL metadata immediately
      const sourceTrack = clipboard.value.sourceTrackId
        ? tracksStore.tracks.find(t => t.id === clipboard.value!.sourceTrackId)
        : undefined;
      const pasteSourceFile = sourceTrack?.cachedAudioPath || sourceTrack?.sourcePath;

      // EDL-H1: pass the source region start as sourceOffset so the pasted
      // clip knows where in the original file its audio came from
      const pasteSourceOffset = clipboard.value.sourceRegion.start;

      const success = await tracksStore.insertClipAtPlayhead(
        selectedTrack.id,
        clonedBuffer,
        waveform,
        playheadTime,
        ctx,
        pasteSourceFile,
        pasteSourceOffset
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

    const newTrack = await tracksStore.createTrackFromBuffer(
      clonedBuffer,
      [...clipboard.value.waveformData],
      trackName,
      pasteTime
    );

    console.log(`[Clipboard] Pasted ${clipboard.value.duration.toFixed(2)}s, new track ID: ${newTrack.id}`);
    return newTrack;
    } finally {
      historyStore.endBatch();
      operationInProgress.value = false;
    }
  }

  // Delete: I/O points > selected clip > entire track
  async function deleteSelected(): Promise<boolean> {
    if (operationInProgress.value) {
      useUIStore().showToast('Another edit is in progress. Please wait.', 'warn');
      return false;
    }
    operationInProgress.value = true;
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Delete');
    try {
    // Priority 1: I/O points (precision editing takes precedence)
    const { inPoint, outPoint } = selectionStore.inOutPoints;

    if (inPoint !== null && outPoint !== null) {
      const ctx = audioStore.getAudioContext();
      let cutCount = 0;

      // Cut from every track that overlaps the I/O region (no ripple shift)
      const trackIds = tracksStore.tracks.map(t => t.id);
      for (const trackId of trackIds) {
        const track = tracksStore.tracks.find(t => t.id === trackId);
        if (!track) continue;
        const trackEnd = track.trackStart + track.duration;
        if (track.trackStart >= outPoint || trackEnd <= inPoint) continue;

        const result = await tracksStore.cutRegionFromTrack(trackId, inPoint, outPoint, ctx, { mode: 'edit-only' });
        if (result) cutCount++;
      }

      if (cutCount > 0) {
        // Adjust transcription: remove words in deleted region (no shift)
        for (const trackId of trackIds) {
          transcriptionStore.adjustForDelete(trackId, inPoint, outPoint);
        }
        // Adjust timemarks and volume envelope: remove in deleted region (no shift)
        for (const trackId of trackIds) {
          tracksStore.adjustTimemarksForDelete(trackId, inPoint, outPoint);
          tracksStore.adjustVolumeEnvelopeForDelete(trackId, inPoint, outPoint);
        }
        // Cache small-file clips for Rust playback (EDL clips already have sourceFile)
        const recachePromise = cacheClipsForPlayback();
        tracksStore.setPendingRecache(recachePromise);
        selectionStore.clearInOutPoints();
        playbackStore.seek(Math.max(0, inPoint - 1.0));
      }
      return cutCount > 0;
    }

    // Priority 2: Selected clip
    const selClip = tracksStore.selectedClip;
    if (selClip) {
      tracksStore.deleteClipFromTrack(selClip.trackId, selClip.clip.id);
      tracksStore.clearClipSelection();
      return true;
    }

    // Priority 3: Entire target track
    const selectedTrack = getTargetTrack();
    if (!selectedTrack) {
        return false;
    }
    transcriptionStore.removeTranscription(selectedTrack.id);
    tracksStore.deleteTrack(selectedTrack.id);
    return true;
    } finally {
      historyStore.endBatch();
      operationInProgress.value = false;
    }
  }

  // NOTE: createClip() moved to useClipping.ts composable (insert below + solo behavior)

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
