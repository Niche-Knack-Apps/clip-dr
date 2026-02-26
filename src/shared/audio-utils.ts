import type { TrackClip } from '@/shared/types';

const MAX_WAV_BYTES = 1_073_741_824; // 1GB
const MAX_MIX_DURATION = 7200; // 2 hours

function writeWavString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encode an AudioBuffer to WAV format (16-bit PCM).
 * Throws if total size exceeds 1GB.
 */
export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  if (totalSize > MAX_WAV_BYTES) {
    throw new Error(
      `WAV encoding would require ${(totalSize / 1_073_741_824).toFixed(1)}GB — exceeds 1GB limit. ` +
      `Try a shorter selection (${buffer.length} samples, ${numChannels} channels).`
    );
  }

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeWavString(view, 8, 'WAVE');

  // fmt chunk
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeWavString(view, 36, 'data');
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

/**
 * Encode an AudioBuffer to WAV format (32-bit float).
 * Used for temporary cached playback files (cut/delete) so Rust can mmap directly.
 * Files are 2x larger than 16-bit but avoid the int→float conversion path.
 */
export function encodeWavFloat32(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  if (totalSize > MAX_WAV_BYTES) {
    throw new Error(
      `WAV encoding would require ${(totalSize / 1_073_741_824).toFixed(1)}GB — exceeds 1GB limit. ` +
      `Try a shorter selection (${buffer.length} samples, ${numChannels} channels).`
    );
  }

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeWavString(view, 8, 'WAVE');

  // fmt chunk (audioFormat = 3 for IEEE float)
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeWavString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and write float32 samples
  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, channels[ch][i], true);
      offset += 4;
    }
  }

  return new Uint8Array(arrayBuffer);
}

/**
 * Mix a track's clips into a single AudioBuffer.
 * Throws if total duration exceeds 2 hours.
 * Returns null if no buffered clips are available.
 */
export function mixTrackClipsToBuffer(
  clips: TrackClip[],
  audioContext: AudioContext,
): AudioBuffer | null {
  if (clips.length === 0) return null;

  // Filter to clips with AudioBuffers (large-file tracks have null buffers)
  const bufferedClips = clips.filter(
    (c): c is TrackClip & { buffer: AudioBuffer } => c.buffer !== null
  );
  if (bufferedClips.length === 0) return null;

  let timelineStart = Infinity;
  let timelineEnd = 0;
  let sampleRate = 44100;

  for (const clip of bufferedClips) {
    timelineStart = Math.min(timelineStart, clip.clipStart);
    timelineEnd = Math.max(timelineEnd, clip.clipStart + clip.duration);
    sampleRate = clip.buffer.sampleRate;
  }

  const totalDuration = timelineEnd - timelineStart;

  if (totalDuration > MAX_MIX_DURATION) {
    throw new Error(
      `Mix duration is ${(totalDuration / 60).toFixed(0)} minutes — exceeds 2-hour limit. ` +
      `Try processing a shorter selection.`
    );
  }

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
