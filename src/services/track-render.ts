/**
 * Render a track's audible arranged content to a temp WAV file.
 * Fast path: in-memory buffer mix → encode → write temp.
 * Fallback: Rust EDL export pipeline for EDL/large-file tracks.
 * Returns the temp WAV file path.
 *
 * Caller is responsible for cleanup if desired (temp files are written
 * to the OS temp dir and cleaned up on OS reboot at minimum).
 */
import { invoke } from '@tauri-apps/api/core';
import { useTracksStore } from '@/stores/tracks';
import { useAudioStore } from '@/stores/audio';
import { encodeWavFloat32InWorker } from '@/workers/audio-processing-api';
import { writeTempFile } from '@/shared/fs-utils';
import type { ExportEDL, ExportEDLTrack } from '@/shared/types';

/** Maps rendered-WAV time → original timeline time for each clip */
export interface RenderClipMap {
  renderStart: number;  // position in rendered WAV (seconds)
  renderEnd: number;
  timelineStart: number; // original absolute timeline position
}

export async function renderTrackToTempWav(trackId: string): Promise<{ path: string; clipMap: RenderClipMap[] }> {
  const tracksStore = useTracksStore();
  const audioStore = useAudioStore();

  const track = tracksStore.tracks.find(t => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);

  console.log(`[TrackRender] Rendering track ${trackId}, name="${track.name}", duration=${track.duration?.toFixed(2)}s, clips: ${tracksStore.getTrackClips(trackId).length}`);

  // Fast path: try in-memory buffer mix
  const clips = tracksStore.getTrackClips(trackId);
  const mixedBuffer = tracksStore.mixClipsForTrack(trackId, audioStore.getAudioContext());
  if (mixedBuffer) {
    // mixTrackClipsToBuffer preserves gaps — positions are relative to min(clipStart)
    const timelineStart = clips.length > 0 ? Math.min(...clips.map(c => c.clipStart)) : 0;
    const clipMap: RenderClipMap[] = clips.map(c => ({
      renderStart: c.clipStart - timelineStart,
      renderEnd: c.clipStart - timelineStart + c.duration,
      timelineStart: c.clipStart,
    }));
    console.log(`[TrackRender] Fast path: in-memory mix, buffer length=${mixedBuffer.length}, sampleRate=${mixedBuffer.sampleRate}`);
    const wavData = await encodeWavFloat32InWorker(mixedBuffer);
    const path = await writeTempFile(`render_${trackId}_${Date.now()}.wav`, wavData);
    console.log(`[TrackRender] Written temp WAV: ${path}`);
    return { path, clipMap };
  }

  // Fallback: EDL export via Rust (handles EDL/large-file tracks)
  if (clips.length === 0) throw new Error(`Track ${trackId} has no clips to render`);

  const sampleRate = track.audioData.sampleRate || 44100;
  const channels = Math.min(track.audioData.channels || 2, 2) as number;

  const edlTracks: ExportEDLTrack[] = [];
  for (const clip of clips) {
    const sourcePath = clip.sourceFile || track.cachedAudioPath || track.sourcePath;
    if (!sourcePath) throw new Error(`Clip ${clip.id} has no resolvable source path`);

    const envelopeOffset = clip.clipStart - (track.trackStart ?? 0);
    const clipEnvelope = track.volumeEnvelope
      ?.map(p => ({ time: p.time - envelopeOffset, value: p.value }))
      .filter(p => p.time >= 0 && p.time <= clip.duration);

    edlTracks.push({
      source_path: sourcePath,
      track_start: clip.clipStart,
      duration: clip.duration,
      volume: track.volume,
      file_offset: clip.sourceOffset ?? 0,
      volume_envelope: clipEnvelope,
    });
  }

  edlTracks.sort((a, b) => a.track_start - b.track_start);

  // Build clipMap before rebasing (maps rendered position → original timeline position)
  const minStart = Math.min(...edlTracks.map(t => t.track_start));
  const clipMap: RenderClipMap[] = edlTracks.map(t => ({
    renderStart: t.track_start - minStart,
    renderEnd: t.track_start - minStart + t.duration,
    timelineStart: t.track_start,
  }));

  // Rebase to zero (trim leading silence for single-track render)
  if (minStart > 0) {
    for (const t of edlTracks) {
      t.track_start -= minStart;
    }
  }

  const endTime = Math.max(...edlTracks.map(e => e.track_start + e.duration));
  const outputFileName = `render_${trackId}_${Date.now()}.wav`;
  const outputPath = await writeTempFile(outputFileName, new Uint8Array(0));
  // writeTempFile creates the file; we'll overwrite it via export_edl

  const edl: ExportEDL = {
    tracks: edlTracks,
    output_path: outputPath,
    format: 'wav',
    sample_rate: sampleRate,
    channels,
    start_time: 0,
    end_time: endTime,
  };

  await invoke('export_edl', { edl });
  return { path: outputPath, clipMap };
}
