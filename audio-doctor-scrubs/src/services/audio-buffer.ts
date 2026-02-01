export function createAudioBufferFromRegion(
  sourceBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): AudioBuffer {
  const sampleRate = sourceBuffer.sampleRate;
  const channels = sourceBuffer.numberOfChannels;

  const startSample = Math.floor(startTime * sampleRate);
  const endSample = Math.ceil(endTime * sampleRate);
  const length = endSample - startSample;

  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  const newBuffer = ctx.createBuffer(channels, length, sampleRate);

  for (let channel = 0; channel < channels; channel++) {
    const sourceData = sourceBuffer.getChannelData(channel);
    const destData = newBuffer.getChannelData(channel);

    for (let i = 0; i < length; i++) {
      destData[i] = sourceData[startSample + i] || 0;
    }
  }

  return newBuffer;
}

export function mergeAudioBuffers(
  buffers: { buffer: AudioBuffer; offset: number }[],
  totalDuration: number,
  sampleRate: number,
  channels: number
): AudioBuffer {
  const totalSamples = Math.ceil(totalDuration * sampleRate);
  const ctx = new OfflineAudioContext(channels, totalSamples, sampleRate);
  const mergedBuffer = ctx.createBuffer(channels, totalSamples, sampleRate);

  for (const { buffer, offset } of buffers) {
    const startSample = Math.floor(offset * sampleRate);

    for (let channel = 0; channel < channels; channel++) {
      const sourceData = buffer.getChannelData(channel);
      const destData = mergedBuffer.getChannelData(channel);

      for (let i = 0; i < sourceData.length; i++) {
        const destIndex = startSample + i;
        if (destIndex < destData.length) {
          destData[destIndex] += sourceData[i];
        }
      }
    }
  }

  return mergedBuffer;
}

export function audioBufferToFloat32Array(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const interleaved = new Float32Array(length * channels);

  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      interleaved[i * channels + channel] = buffer.getChannelData(channel)[i];
    }
  }

  return interleaved;
}

export function float32ArrayToAudioBuffer(
  data: Float32Array,
  channels: number,
  sampleRate: number
): AudioBuffer {
  const samplesPerChannel = Math.floor(data.length / channels);
  const ctx = new OfflineAudioContext(channels, samplesPerChannel, sampleRate);
  const buffer = ctx.createBuffer(channels, samplesPerChannel, sampleRate);

  for (let channel = 0; channel < channels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < samplesPerChannel; i++) {
      channelData[i] = data[i * channels + channel];
    }
  }

  return buffer;
}

export function calculateRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

export function calculatePeak(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}
