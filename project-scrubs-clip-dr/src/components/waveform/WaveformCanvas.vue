<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useWaveform } from '@/composables/useWaveform';
import type { WaveformBucket } from '@/shared/types';

interface Props {
  startTime: number;
  endTime: number;
  color?: string;
  backgroundColor?: string;
  height?: number;
}

const props = withDefaults(defineProps<Props>(), {
  color: '#00d4ff',
  backgroundColor: 'transparent',
  height: 100,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const width = ref(0);

const { getBucketsForRange, renderWaveform, waveformData, duration } = useWaveform();

let resizeObserver: ResizeObserver | null = null;

// Version counter that increments whenever waveform data reference changes.
// Watching the array reference directly ensures re-render on any track
// manipulation (cut, delete, drag) since computed arrays return new refs.
const waveformVersion = ref(0);
watch(waveformData, () => { waveformVersion.value++; });

function render() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width.value * dpr;
  canvas.height = props.height * dpr;
  ctx.scale(dpr, dpr);

  const buckets = getBucketsForRange(props.startTime, props.endTime, width.value);

  console.log('[WaveformCanvas] render called, buckets:', buckets.length, 'waveform length:', waveformData.value.length, 'hash:', waveformDataHash.value);

  renderWaveform(ctx, buckets, {
    width: width.value,
    height: props.height,
    color: props.color,
    backgroundColor: props.backgroundColor,
  });
}

function updateSize() {
  if (containerRef.value) {
    width.value = containerRef.value.clientWidth;
    render();
  }
}

onMounted(() => {
  updateSize();

  resizeObserver = new ResizeObserver(updateSize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

// Watch for props changes and waveform data changes (when tracks are modified)
watch([() => props.startTime, () => props.endTime, () => props.color, waveformVersion, duration], render, { immediate: true });
</script>

<template>
  <div ref="containerRef" class="w-full" :style="{ height: `${height}px` }">
    <canvas
      ref="canvasRef"
      class="w-full h-full"
      :style="{ width: `${width}px`, height: `${height}px` }"
    />
  </div>
</template>
