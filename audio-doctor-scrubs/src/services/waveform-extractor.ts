import type { WaveformBucket } from '@/shared/types';

export function extractWaveformBuckets(
  pcmData: Float32Array,
  bucketCount: number
): WaveformBucket[] {
  const samplesPerBucket = Math.ceil(pcmData.length / bucketCount);
  const buckets: WaveformBucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, pcmData.length);

    let min = 0;
    let max = 0;

    for (let j = start; j < end; j++) {
      const sample = pcmData[j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    buckets.push({ min, max });
  }

  return buckets;
}

export function flattenBuckets(buckets: WaveformBucket[]): number[] {
  const flat: number[] = [];
  for (const bucket of buckets) {
    flat.push(bucket.min, bucket.max);
  }
  return flat;
}

export function unflattenBuckets(flat: number[]): WaveformBucket[] {
  const buckets: WaveformBucket[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    buckets.push({ min: flat[i], max: flat[i + 1] });
  }
  return buckets;
}

export function downsampleBuckets(
  buckets: WaveformBucket[],
  targetCount: number
): WaveformBucket[] {
  if (buckets.length <= targetCount) return buckets;

  const ratio = buckets.length / targetCount;
  const result: WaveformBucket[] = [];

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);

    let min = 0;
    let max = 0;

    for (let j = start; j < end; j++) {
      if (buckets[j].min < min) min = buckets[j].min;
      if (buckets[j].max > max) max = buckets[j].max;
    }

    result.push({ min, max });
  }

  return result;
}

export function normalizeBuckets(buckets: WaveformBucket[]): WaveformBucket[] {
  let maxAbs = 0;

  for (const bucket of buckets) {
    maxAbs = Math.max(maxAbs, Math.abs(bucket.min), Math.abs(bucket.max));
  }

  if (maxAbs === 0) return buckets;

  return buckets.map((bucket) => ({
    min: bucket.min / maxAbs,
    max: bucket.max / maxAbs,
  }));
}
