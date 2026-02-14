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

export function useWaveform() {
  const { effectiveWaveformData, effectiveDuration } = useEffectiveAudio();
  const tracksStore = useTracksStore();

  // Use effective waveform/duration which switches when a processed track is soloed
  const waveformData = effectiveWaveformData;
  const duration = effectiveDuration;

  // Peak tile cache for high-resolution waveform at deep zoom
  const tileVersion = ref(0);
  const tileCache = new Map<string, number[]>();
  let pendingTileKey = '';
  let tileDebounceId: number | null = null;
  const TILE_CACHE_MAX = 16; // LRU eviction limit

  function getBucketsForRange(
    start: number,
    end: number,
    bucketCount: number
  ): WaveformBucket[] {
    if (!waveformData.value.length) return [];

    const data = waveformData.value;
    const totalBuckets = data.length / 2;

    const startBucket = Math.floor((start / duration.value) * totalBuckets);
    const endBucket = Math.ceil((end / duration.value) * totalBuckets);
    const rangeBuckets = endBucket - startBucket;

    // Check if peak tile can provide better detail (single-track with pyramid)
    if (rangeBuckets < bucketCount / 2) {
      const tracks = tracksStore.tracks;
      if (tracks.length === 1 && tracks[0].hasPeakPyramid && tracks[0].sourcePath) {
        const cacheKey = `${start.toFixed(3)}:${end.toFixed(3)}:${bucketCount}`;
        const cached = tileCache.get(cacheKey);
        if (cached && cached.length >= bucketCount * 2) {
          // Return cached tile data
          const buckets: WaveformBucket[] = [];
          for (let i = 0; i < bucketCount; i++) {
            buckets.push({ min: cached[i * 2], max: cached[i * 2 + 1] });
          }
          return buckets;
        }

        // Schedule async tile fetch (debounced)
        if (pendingTileKey !== cacheKey) {
          pendingTileKey = cacheKey;
          if (tileDebounceId !== null) cancelAnimationFrame(tileDebounceId);
          tileDebounceId = requestAnimationFrame(() => {
            tileDebounceId = null;
            fetchPeakTile(tracks[0].sourcePath!, start, end, bucketCount, cacheKey);
          });
        }
      }
    }

    // Fall back to existing 1000-bucket data
    if (rangeBuckets <= bucketCount) {
      const buckets: WaveformBucket[] = [];
      for (let i = startBucket; i < endBucket; i++) {
        const idx = i * 2;
        if (idx < data.length - 1) {
          buckets.push({ min: data[idx], max: data[idx + 1] });
        }
      }
      return buckets;
    }

    const samplesPerBucket = rangeBuckets / bucketCount;
    const buckets: WaveformBucket[] = [];

    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = startBucket + Math.floor(i * samplesPerBucket);
      const bucketEnd = startBucket + Math.floor((i + 1) * samplesPerBucket);

      let min = Infinity;
      let max = -Infinity;

      for (let j = bucketStart; j < bucketEnd; j++) {
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

      // LRU eviction
      if (tileCache.size >= TILE_CACHE_MAX) {
        const firstKey = tileCache.keys().next().value;
        if (firstKey !== undefined) tileCache.delete(firstKey);
      }

      tileCache.set(cacheKey, tileData);
      tileVersion.value++; // Trigger re-render
    } catch (e) {
      // Peak tile not available — silently fall back to 1000-bucket data
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
