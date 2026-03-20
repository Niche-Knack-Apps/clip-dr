import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import { useUIStore } from './ui';
import type { Track, TrackClip } from '@/shared/types';
import { useHistoryStore } from './history';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { writeTempFile } from '@/shared/fs-utils';
import { generateId } from '@/shared/utils';

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
          const wavData = await encodeWavFloat32InWorker(clip.buffer);
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

      // Resolve source file for EDL segment metadata (save/load round-trip)
      const srcTrack = tracksStore.tracks.find(t => t.id === trackId);
      const segSourceFile = clip.sourceFile || srcTrack?.cachedAudioPath || srcTrack?.sourcePath || '';

      clipboard.value = {
        samples: [],
        sampleRate: clonedBuffer.sampleRate,
        duration: clonedBuffer.duration,
        sourceRegion: { start: clip.clipStart, end: clip.clipStart + clip.duration },
        sourceTrackId: trackId,
        waveformData: waveform,
        copiedAt: Date.now(),
        virtualSource: segSourceFile ? {
          kind: 'mixdown',
          segments: [{
            sourceFile: segSourceFile,
            sourceOffset: clip.sourceOffset ?? 0,
            duration: clip.duration,
            offsetInRegion: 0,
          }],
          sampleRate: clonedBuffer.sampleRate,
          channels: clonedBuffer.numberOfChannels,
        } : undefined,
      };

      // Record gap position before deleting
      const gapStart = clip.clipStart;
      const gapDuration = clip.duration;

      // Remove the clip but keep the track (clip was selected, not the track)
      tracksStore.removeClipKeepTrack(trackId, clip.id);

      // Adjust timemarks and volume envelope on the affected track only
      const gapEnd = gapStart + gapDuration;
      tracksStore.adjustTimemarksForCut(trackId, gapStart, gapEnd);
      tracksStore.adjustVolumeEnvelopeForCut(trackId, gapStart, gapEnd);

      // Slide remaining clips on the affected track only — don't ripple other tracks.
      // Selected-clip cut is a clip-level operation, not a timeline-level operation.
      tracksStore.slideTracksLeft(gapStart, gapDuration, trackId);

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
      // Scope extraction to selected track (or all tracks if 'ALL'/null)
      const selectedId = tracksStore.selectedTrackId;
      const sourceTrackIds = (selectedId && selectedId !== 'ALL') ? [selectedId] : undefined;

      // Determine if any overlapping track lacks an in-memory buffer
      const hasLargeFile = tracksStore.tracks.some(t => {
        if (sourceTrackIds && !sourceTrackIds.includes(t.id)) return false;
        const trackEnd = t.trackStart + t.duration;
        if (t.trackStart >= outPoint || trackEnd <= inPoint) return false;
        return !t.audioData.buffer;
      });

      let extracted: { buffer: AudioBuffer; waveformData: number[] } | null = null;

      // Always collect segments BEFORE ripple delete modifies tracks — needed for
      // save/load round-trip even for small files (EDL clip metadata)
      const virtualSegments = tracksStore.collectVirtualClipboardSegments(inPoint, outPoint, sourceTrackIds);
      const { sampleRate: sr, channels: ch } = tracksStore.getContributingFormat(inPoint, outPoint, sourceTrackIds);
      const clipWaveform = tracksStore.sliceWaveformForRegion(inPoint, outPoint, sourceTrackIds);

      if (!hasLargeFile) {
        // Small file: also extract in-memory audio for immediate playback
        extracted = await tracksStore.extractRegionFromAllTracks(inPoint, outPoint, ctx, sourceTrackIds);
      }

      // Ripple delete — ALWAYS edit-only (no extraction)
      const results = await tracksStore.rippleDeleteRegion(inPoint, outPoint, ctx, { mode: 'edit-only' });

      if (results.affectedCount > 0) {
        // Store clipboard with both buffer (if available) and segment metadata (always)
        clipboardBuffer.value = extracted?.buffer ?? null;
        clipboard.value = {
          samples: [],
          sampleRate: extracted?.buffer.sampleRate ?? sr,
          duration: extracted?.buffer.duration ?? (outPoint - inPoint),
          sourceRegion: { start: inPoint, end: outPoint },
          sourceTrackId: 'all',
          waveformData: extracted?.waveformData ?? clipWaveform,
          copiedAt: Date.now(),
          virtualSource: virtualSegments.length > 0 ? {
            kind: 'mixdown',
            segments: virtualSegments,
            sampleRate: sr,
            channels: ch,
          } : undefined,
        };

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

      // Satisfy C2: resolve sourceFile from segment metadata or source track
      const sourceTrack = clipboard.value.sourceTrackId
        ? tracksStore.tracks.find(t => t.id === clipboard.value!.sourceTrackId)
        : undefined;
      const pasteSourceFile = vs?.segments?.[0]?.sourceFile || sourceTrack?.cachedAudioPath || sourceTrack?.sourcePath;

      // Use segment's file offset (correct), not timeline position (sourceRegion.start)
      const pasteSourceOffset = vs?.segments?.[0]?.sourceOffset ?? clipboard.value.sourceRegion.start;

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

    // Derive sourcePath from segments or source track
    const sourceTrackForNew = clipboard.value.sourceTrackId
      ? tracksStore.tracks.find(t => t.id === clipboard.value!.sourceTrackId)
      : undefined;
    const pasteSourcePath = vs?.segments?.[0]?.sourceFile
      || sourceTrackForNew?.sourcePath
      || sourceTrackForNew?.cachedAudioPath;

    const newTrack = await tracksStore.createTrackFromBuffer(
      clonedBuffer,
      [...clipboard.value.waveformData],
      trackName,
      pasteTime,
      pasteSourcePath
    );

    // Create EDL clips from stored segments for save/load round-trip
    if (vs?.segments && vs.segments.length > 0) {
      const clips: TrackClip[] = vs.segments.map(seg => ({
        id: generateId(),
        buffer: null,
        waveformData: [] as number[],
        clipStart: pasteTime + seg.offsetInRegion,
        duration: seg.duration,
        sourceFile: seg.sourceFile,
        sourceOffset: seg.sourceOffset,
      }));

      // Distribute waveform across clips proportionally
      const waveformData = clipboard.value.waveformData;
      const totalDuration = clipboard.value.duration;
      const bucketCount = waveformData.length / 2;
      for (let i = 0; i < clips.length; i++) {
        const seg = vs.segments[i];
        const startFrac = seg.offsetInRegion / totalDuration;
        const endFrac = (seg.offsetInRegion + seg.duration) / totalDuration;
        const startBucket = Math.floor(startFrac * bucketCount);
        const endBucket = Math.ceil(endFrac * bucketCount);
        clips[i].waveformData = waveformData.slice(startBucket * 2, endBucket * 2);
      }

      tracksStore.setTrackClips(newTrack.id, clips);
    }

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
