/**
 * Web Worker for CPU-intensive audio processing operations.
 * Offloads waveform generation and WAV encoding from the main thread.
 */

interface GenerateWaveformMessage {
  type: 'generateWaveform';
  id: number;
  channelData: Float32Array;
  bucketCount: number;
}

interface EncodeWavFloat32Message {
  type: 'encodeWavFloat32';
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

interface EncodeWav16Message {
  type: 'encodeWav16';
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

type WorkerMessage = GenerateWaveformMessage | EncodeWavFloat32Message | EncodeWav16Message;

function generateWaveform(channelData: Float32Array, bucketCount: number): number[] {
  const samplesPerBucket = Math.ceil(channelData.length / bucketCount);
  const waveform: number[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, channelData.length);

    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const sample = channelData[j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    waveform.push(min, max);
  }

  return waveform;
}

function writeWavString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function encodeWavFloat32(channels: Float32Array[], sampleRate: number, length: number): Uint8Array {
  const numChannels = channels.length;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeWavString(view, 8, 'WAVE');

  // fmt chunk (audioFormat = 3 for IEEE float)
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeWavString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  if (numChannels === 1) {
    new Float32Array(arrayBuffer, headerSize).set(channels[0]);
  } else {
    const floatView = new Float32Array(arrayBuffer, headerSize);
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        floatView[i * numChannels + ch] = channels[ch][i];
      }
    }
  }

  return new Uint8Array(arrayBuffer);
}

function encodeWav16(channels: Float32Array[], sampleRate: number, length: number): Uint8Array {
  const numChannels = channels.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

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

  const int16View = new Int16Array(arrayBuffer, headerSize);
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      int16View[i * numChannels + ch] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
  }

  return new Uint8Array(arrayBuffer);
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'generateWaveform': {
      const result = generateWaveform(msg.channelData, msg.bucketCount);
      self.postMessage({ id: msg.id, result });
      break;
    }
    case 'encodeWavFloat32': {
      const result = encodeWavFloat32(msg.channels, msg.sampleRate, msg.length);
      self.postMessage({ id: msg.id, result }, [result.buffer] as never);
      break;
    }
    case 'encodeWav16': {
      const result = encodeWav16(msg.channels, msg.sampleRate, msg.length);
      self.postMessage({ id: msg.id, result }, [result.buffer] as never);
      break;
    }
  }
};
