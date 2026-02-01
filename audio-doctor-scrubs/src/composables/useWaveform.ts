import { computed, ref, watch } from 'vue';
import { useAudioStore } from '@/stores/audio';
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
  const audioStore = useAudioStore();

  const waveformData = computed(() => audioStore.currentFile?.waveformData ?? []);
  const duration = computed(() => audioStore.duration);

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
    getBucketsForRange,
    renderWaveform,
    timeToX,
    xToTime,
  };
}
