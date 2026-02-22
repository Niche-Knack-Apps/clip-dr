import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useTracksStore } from '@/stores/tracks';
import type { WaveformBucket } from '@/shared/types';

export interface WaveformRenderOptions {
  width: number;
  height: number;
  color?: string;
  backgroundColor?: string;
  startTime?: number;
  endTime?: number;
}

// Peak tile cache — shared across all useWaveform() instances for cross-instance reuse
const tileCache = new Map<string, number[]>();
const TILE_CACHE_MAX = 256;

// LRU-aware cache access: move accessed key to end of Map iteration order
function getCachedTile(key: string): number[] | undefined {
  const data = tileCache.get(key);
  if (data) {
    tileCache.delete(key);
    tileCache.set(key, data);
  }
  return data;
}

function setCachedTile(key: string, data: number[]): void {
  while (tileCache.size >= TILE_CACHE_MAX) {
    const firstKey = tileCache.keys().next().value;
    if (firstKey !== undefined) tileCache.delete(firstKey);
    else break;
  }
  tileCache.set(key, data);
}

// Quantize time range to a grid so small pan/zoom changes hit the cache
function quantizeRange(start: number, end: number, trackDuration: number) {
  const sliceSize = Math.max(trackDuration / 128, 0.01);
  const qStart = Math.floor(start / sliceSize) * sliceSize;
  const qEnd = Math.ceil(end / sliceSize) * sliceSize;
  return { qStart, qEnd };
}

export function useWaveform() {
  const { effectiveWaveformData, effectiveDuration } = useEffectiveAudio();
  const tracksStore = useTracksStore();

  // Use effective waveform/duration which switches when a processed track is soloed
  const waveformData = effectiveWaveformData;
  const duration = effectiveDuration;

  // Per-instance tile state (not shared across WaveformCanvas instances)
  const tileVersion = ref(0);
  let currentGeneration = 0;
  const inFlightKeys = new Set<string>();

  function getBucketsForRange(
    start: number,
    end: number,
    bucketCount: number
  ): WaveformBucket[] {
    if (!waveformData.value.length || bucketCount <= 0) return [];

    const data = waveformData.value;
    const totalBuckets = data.length / 2;

    const startBucket = Math.floor((start / duration.value) * totalBuckets);
    const endBucket = Math.ceil((end / duration.value) * totalBuckets);
    const rangeBuckets = endBucket - startBucket;

    // Use peak tiles when overview data is insufficient (< 2x the output resolution)
    // or when deeply zoomed. The Rust backend selects the optimal LOD automatically.
    if (rangeBuckets < bucketCount * 2) {
      const candidateTrack = tracksStore.tracks.find(t =>
        t.hasPeakPyramid && t.sourcePath &&
        t.trackStart < end && (t.trackStart + t.duration) > start
      );
      if (candidateTrack) {
        const relStart = Math.max(0, start - candidateTrack.trackStart);
        const relEnd = Math.min(candidateTrack.duration, end - candidateTrack.trackStart);
        const { qStart, qEnd } = quantizeRange(relStart, relEnd, candidateTrack.duration);
        const cacheKey = `${candidateTrack.sourcePath}:${qStart.toFixed(4)}:${qEnd.toFixed(4)}:${bucketCount}`;

        const cached = getCachedTile(cacheKey);
        if (cached && cached.length >= bucketCount * 2) {
          const buckets: WaveformBucket[] = [];
          for (let i = 0; i < bucketCount; i++) {
            buckets.push({ min: cached[i * 2], max: cached[i * 2 + 1] });
          }
          return buckets;
        }

        // Fire fetch if not already in-flight for this key
        if (!inFlightKeys.has(cacheKey)) {
          inFlightKeys.add(cacheKey);
          const gen = ++currentGeneration;
          fetchPeakTile(candidateTrack.sourcePath!, qStart, qEnd, bucketCount, cacheKey, gen);
        }
      }
    }

    // Fall back to existing 1000-bucket data, stretched to fill bucketCount
    return stretchFallbackBuckets(data, startBucket, endBucket, totalBuckets, bucketCount);
  }

  // Stretch/resample available 1000-bucket data to fill the requested bucketCount.
  // When deeply zoomed, rangeBuckets might be 1-3 but canvas needs ~1200 buckets.
  // Without stretching, the waveform would disappear at deep zoom.
  function stretchFallbackBuckets(
    data: number[],
    startBucket: number,
    endBucket: number,
    totalBuckets: number,
    bucketCount: number,
  ): WaveformBucket[] {
    const clampedStart = Math.max(0, Math.min(startBucket, totalBuckets - 1));
    const clampedEnd = Math.max(clampedStart + 1, Math.min(endBucket, totalBuckets));
    const rangeBuckets = clampedEnd - clampedStart;

    if (rangeBuckets >= bucketCount) {
      // Downsample: more source buckets than output buckets
      const samplesPerBucket = rangeBuckets / bucketCount;
      const buckets: WaveformBucket[] = [];
      for (let i = 0; i < bucketCount; i++) {
        const bStart = clampedStart + Math.floor(i * samplesPerBucket);
        const bEnd = clampedStart + Math.floor((i + 1) * samplesPerBucket);
        let min = Infinity;
        let max = -Infinity;
        for (let j = bStart; j < bEnd; j++) {
          const idx = j * 2;
          if (idx < data.length - 1) {
            min = Math.min(min, data[idx]);
            max = Math.max(max, data[idx + 1]);
          }
        }
        if (min === Infinity) min = 0;
        if (max === -Infinity) max = 0;
        buckets.push({ min, max });
      }
      return buckets;
    }

    // Upsample: fewer source buckets than output — stretch to fill canvas
    const buckets: WaveformBucket[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const srcIdx = clampedStart + Math.floor((i / bucketCount) * rangeBuckets);
      const idx = Math.min(srcIdx, totalBuckets - 1) * 2;
      if (idx < data.length - 1) {
        buckets.push({ min: data[idx], max: data[idx + 1] });
      } else {
        buckets.push({ min: 0, max: 0 });
      }
    }

    // If all upsampled buckets are zero, try expanding the neighborhood to find non-zero data
    const allZero = buckets.every(b => b.min === 0 && b.max === 0);
    if (allZero && rangeBuckets > 0) {
      const expandedStart = Math.max(0, clampedStart - 2);
      const expandedEnd = Math.min(totalBuckets, clampedEnd + 2);
      for (let j = expandedStart; j < expandedEnd; j++) {
        const idx = j * 2;
        if (idx < data.length - 1 && (data[idx] !== 0 || data[idx + 1] !== 0)) {
          return buckets.map(() => ({ min: data[idx], max: data[idx + 1] }));
        }
      }
    }

    return buckets;
  }

  async function fetchPeakTile(
    sourcePath: string,
    startTime: number,
    endTime: number,
    bucketCount: number,
    cacheKey: string,
    generation: number,
  ): Promise<void> {
    try {
      const tileData = await invoke<number[]>('get_peak_tile', {
        path: sourcePath,
        startTime,
        endTime,
        bucketCount,
      });

      setCachedTile(cacheKey, tileData);

      // Only trigger re-render if this generation is still current
      if (generation === currentGeneration) {
        tileVersion.value++;
      }
    } catch (e) {
      console.warn('[Waveform] Peak tile fetch failed:', e);
    } finally {
      inFlightKeys.delete(cacheKey);
    }
  }

  function renderWaveform(
    ctx: CanvasRenderingContext2D,
    buckets: WaveformBucket[],
    options: WaveformRenderOptions
  ): void {
    const {
      width,
      height,
      color = '#00d4ff',
      backgroundColor = 'transparent',
    } = options;

    ctx.clearRect(0, 0, width, height);

    if (backgroundColor !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    if (!buckets.length) return;

    const centerY = height / 2;
    const barWidth = width / buckets.length;

    ctx.fillStyle = color;
    ctx.beginPath();

    for (let i = 0; i < buckets.length; i++) {
      const { min, max } = buckets[i];
      const x = i * barWidth;
      const minY = centerY - min * centerY;
      const maxY = centerY - max * centerY;

      ctx.moveTo(x, minY);
      ctx.lineTo(x, maxY);
      ctx.lineTo(x + barWidth - 1, maxY);
      ctx.lineTo(x + barWidth - 1, minY);
      ctx.closePath();
    }

    ctx.fill();
  }

  function timeToX(time: number, width: number, start: number, end: number): number {
    return ((time - start) / (end - start)) * width;
  }

  function xToTime(x: number, width: number, start: number, end: number): number {
    return (x / width) * (end - start) + start;
  }

  return {
    waveformData,
    duration,
    tileVersion,
    getBucketsForRange,
    renderWaveform,
    timeToX,
    xToTime,
  };
}
