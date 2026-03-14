/**
 * Promise-based API for the audio processing Web Worker.
 * Offloads CPU-intensive waveform generation and WAV encoding from the main thread.
 * Falls back to synchronous inline computation when Worker is unavailable (test env).
 */

const MAX_WAV_BYTES = 1_073_741_824; // 1GB

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./audio-processing.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
        const { id, result } = e.data;
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.resolve(result);
        }
      };
      worker.onerror = (e) => {
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error(`Worker error: ${e.message}`));
        }
      };
    } catch {
      // Worker not available (test environment, SSR, etc.)
      workerFailed = true;
      return null;
    }
  }
  return worker;
}

function postToWorker(message: Record<string, unknown>, transfer?: Transferable[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const w = getWorker()!;
    if (transfer) {
      w.postMessage({ ...message, id }, transfer);
    } else {
      w.postMessage({ ...message, id });
    }
  });
}

/** Synchronous waveform generation fallback (used when Worker is unavailable). */
function generateWaveformSync(channelData: Float32Array, bucketCount: number): number[] {
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

/**
 * Generate waveform data (min/max pairs) from an AudioBuffer.
 * Uses Web Worker when available, falls back to synchronous computation.
 */
export async function generateWaveformInWorker(
  buffer: AudioBuffer,
  bucketCount: number
): Promise<number[]> {
  const w = getWorker();
  if (!w) {
    return generateWaveformSync(buffer.getChannelData(0), bucketCount);
  }

  const channelData = new Float32Array(buffer.getChannelData(0));
  const result = await postToWorker(
    { type: 'generateWaveform', channelData, bucketCount },
    [channelData.buffer]
  );
  return result as number[];
}

/**
 * Encode audio to 32-bit float WAV.
 * Uses Web Worker when available, falls back to synchronous encoding.
 */
export async function encodeWavFloat32InWorker(buffer: AudioBuffer): Promise<Uint8Array> {
  const numChannels = buffer.numberOfChannels;
  const totalSize = 44 + buffer.length * numChannels * 4;
  if (totalSize > MAX_WAV_BYTES) {
    throw new Error(
      `WAV encoding would require ${(totalSize / 1_073_741_824).toFixed(1)}GB — exceeds 1GB limit. ` +
      `Try a shorter selection (${buffer.length} samples, ${numChannels} channels).`
    );
  }

  const w = getWorker();
  if (!w) {
    // Fallback: import sync encoder
    const { encodeWavFloat32 } = await import('@/shared/audio-utils');
    return encodeWavFloat32(buffer);
  }

  const channels: Float32Array[] = [];
  const transfer: Transferable[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const copy = new Float32Array(buffer.getChannelData(ch));
    channels.push(copy);
    transfer.push(copy.buffer);
  }

  const result = await postToWorker(
    { type: 'encodeWavFloat32', channels, sampleRate: buffer.sampleRate, length: buffer.length },
    transfer
  );
  return result as Uint8Array;
}

/**
 * Encode audio to 16-bit PCM WAV.
 * Uses Web Worker when available, falls back to synchronous encoding.
 */
export async function encodeWav16InWorker(buffer: AudioBuffer): Promise<Uint8Array> {
  const numChannels = buffer.numberOfChannels;
  const totalSize = 44 + buffer.length * numChannels * 2;
  if (totalSize > MAX_WAV_BYTES) {
    throw new Error(
      `WAV encoding would require ${(totalSize / 1_073_741_824).toFixed(1)}GB — exceeds 1GB limit. ` +
      `Try a shorter selection (${buffer.length} samples, ${numChannels} channels).`
    );
  }

  const w = getWorker();
  if (!w) {
    const { encodeWav } = await import('@/shared/audio-utils');
    return encodeWav(buffer);
  }

  const channels: Float32Array[] = [];
  const transfer: Transferable[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const copy = new Float32Array(buffer.getChannelData(ch));
    channels.push(copy);
    transfer.push(copy.buffer);
  }

  const result = await postToWorker(
    { type: 'encodeWav16', channels, sampleRate: buffer.sampleRate, length: buffer.length },
    transfer
  );
  return result as Uint8Array;
}
