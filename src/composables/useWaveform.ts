import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useEffectiveAudio } from '@/composables/useEffectiveAudio';
import { useTracksStore } from '@/stores/tracks';
import type { WaveformBucket, WaveformLayer } from '@/shared/types';

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

// Quantize time range to a grid so small pan/zoom changes hit the cache.
// Grid size is based on the visible range (not track duration) to avoid
// producing tiles vastly wider than the view for long files.
function quantizeRange(start: number, end: number) {
  const range = end - start;
  // 1/8 of the visible range → quantized range is at most ~1.25x the view
  const sliceSize = Math.max(range / 8, 0.001);
  const qStart = Math.floor(start / sliceSize) * sliceSize;
  const qEnd = Math.ceil(end / sliceSize) * sliceSize;
  return { qStart, qEnd };
}

export function useWaveform() {
  const { effectiveWaveformData, effectiveDuration, waveformLayers } = useEffectiveAudio();
  const tracksStore = useTracksStore();

  // Use effective waveform/duration which switches when a processed track is soloed
  const waveformData = effectiveWaveformData;
  const duration = effectiveDuration;

  // Reactive flag: true when any track has a peak pyramid available.
  // Used to trigger re-render when pyramid becomes ready mid-session.
  const hasPyramid = computed(() => tracksStore.tracks.some(t => t.hasPeakPyramid));

  // Per-instance tile state (not shared across WaveformCanvas instances)
  const tileVersion = ref(0);
  const inFlightKeys = new Set<string>();
  function getBucketsForRange(
    start: number,
    end: number,
    bucketCount: number
  ): WaveformBucket[] {
    if (!waveformData.value.length || bucketCount <= 0) return [];

    const data = waveformData.value;
    const totalBuckets = data.length / 2;
    const dur = duration.value;

    // Guard against invalid duration (NaN, 0, Infinity)
    if (!dur || !isFinite(dur) || dur <= 0) {
      console.warn('[Waveform] Invalid duration:', dur, 'dataLen:', data.length);
      return [];
    }

    const startBucket = Math.floor((start / dur) * totalBuckets);
    const endBucket = Math.ceil((end / dur) * totalBuckets);
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
        const { qStart, qEnd } = quantizeRange(relStart, relEnd);
        const cacheKey = `${candidateTrack.sourcePath}:${qStart.toFixed(4)}:${qEnd.toFixed(4)}:${bucketCount}`;

        const cached = getCachedTile(cacheKey);
        if (cached && cached.length >= bucketCount * 2) {
          // Extract only the view portion from the (potentially wider) quantized tile
          const tileRange = qEnd - qStart;
          const fracStart = Math.max(0, (relStart - qStart) / tileRange);
          const fracEnd = Math.min(1, (relEnd - qStart) / tileRange);
          const fracSpan = fracEnd - fracStart;

          const buckets: WaveformBucket[] = [];
          for (let i = 0; i < bucketCount; i++) {
            const frac = fracStart + (i / bucketCount) * fracSpan;
            const srcIdx = Math.min(Math.floor(frac * bucketCount), bucketCount - 1);
            buckets.push({ min: cached[srcIdx * 2], max: cached[srcIdx * 2 + 1] });
          }
          return buckets;
        }

        // Fire fetch if not already in-flight for this key
        if (!inFlightKeys.has(cacheKey)) {
          inFlightKeys.add(cacheKey);
          fetchPeakTile(candidateTrack.sourcePath!, qStart, qEnd, bucketCount, cacheKey);
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
  ): Promise<void> {
    try {
      const tileData = await invoke<number[]>('get_peak_tile', {
        path: sourcePath,
        startTime,
        endTime,
        bucketCount,
      });

      setCachedTile(cacheKey, tileData);

      // Always trigger re-render — the cache is keyed by range so stale
      // tiles don't affect rendering of the current view
      tileVersion.value++;
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
    const barWidth = Math.max(width / buckets.length, 1);

    ctx.fillStyle = color;
    ctx.beginPath();

    for (let i = 0; i < buckets.length; i++) {
      const { min, max } = buckets[i];
      const x = i * barWidth;
      const topY = centerY - max * centerY;
      const bottomY = centerY - min * centerY;
      const barH = bottomY - topY;

      if (barH < 0.5) continue; // skip zero/negligible bars
      ctx.rect(x, topY, barWidth, barH);
    }

    ctx.fill();
  }

  function getBucketsForRangeForLayer(
    layer: WaveformLayer,
    start: number,
    end: number,
    bucketCount: number
  ): WaveformBucket[] {
    const data = layer.waveformData;
    if (!data.length || bucketCount <= 0) return [];

    const dur = duration.value;
    if (!dur || !isFinite(dur) || dur <= 0) return [];

    const totalBuckets = data.length / 2;
    const startBucket = Math.floor((start / dur) * totalBuckets);
    const endBucket = Math.ceil((end / dur) * totalBuckets);
    const rangeBuckets = endBucket - startBucket;

    // Use peak tiles when overview data is insufficient
    if (rangeBuckets < bucketCount * 2 && layer.hasPeakPyramid && layer.sourcePath) {
      const relStart = Math.max(0, start - layer.trackStart);
      const relEnd = Math.min(layer.duration, end - layer.trackStart);
      const { qStart, qEnd } = quantizeRange(relStart, relEnd);
      const cacheKey = `${layer.sourcePath}:${qStart.toFixed(4)}:${qEnd.toFixed(4)}:${bucketCount}`;

      const cached = getCachedTile(cacheKey);
      if (cached && cached.length >= bucketCount * 2) {
        const tileRange = qEnd - qStart;
        const fracStart = Math.max(0, (relStart - qStart) / tileRange);
        const fracEnd = Math.min(1, (relEnd - qStart) / tileRange);
        const fracSpan = fracEnd - fracStart;

        const buckets: WaveformBucket[] = [];
        for (let i = 0; i < bucketCount; i++) {
          const frac = fracStart + (i / bucketCount) * fracSpan;
          const srcIdx = Math.min(Math.floor(frac * bucketCount), bucketCount - 1);
          buckets.push({ min: cached[srcIdx * 2], max: cached[srcIdx * 2 + 1] });
        }
        return buckets;
      }

      if (!inFlightKeys.has(cacheKey)) {
        inFlightKeys.add(cacheKey);
        fetchPeakTile(layer.sourcePath, qStart, qEnd, bucketCount, cacheKey);
      }
    }

    return stretchFallbackBuckets(data, startBucket, endBucket, totalBuckets, bucketCount);
  }

  function renderLayeredWaveform(
    ctx: CanvasRenderingContext2D,
    layerBuckets: { color: string; buckets: WaveformBucket[] }[],
    options: WaveformRenderOptions
  ): void {
    const { width, height, backgroundColor = 'transparent' } = options;

    ctx.clearRect(0, 0, width, height);

    if (backgroundColor !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    if (layerBuckets.length === 0) return;

    const centerY = height / 2;
    const singleLayer = layerBuckets.length === 1;

    for (const layer of layerBuckets) {
      if (!layer.buckets.length) continue;

      ctx.globalAlpha = singleLayer ? 1.0 : 0.7;
      ctx.fillStyle = layer.color;
      ctx.beginPath();

      const barWidth = Math.max(width / layer.buckets.length, 1);
      for (let i = 0; i < layer.buckets.length; i++) {
        const { min, max } = layer.buckets[i];
        const x = i * barWidth;
        const topY = centerY - max * centerY;
        const bottomY = centerY - min * centerY;
        const barH = bottomY - topY;
        if (barH < 0.5) continue;
        ctx.rect(x, topY, barWidth, barH);
      }

      ctx.fill();
    }

    ctx.globalAlpha = 1.0;
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
    hasPyramid,
    waveformLayers,
    getBucketsForRange,
    getBucketsForRangeForLayer,
    renderWaveform,
    renderLayeredWaveform,
    timeToX,
    xToTime,
  };
}
