<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
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

// Track when waveform data changes to force re-render
const waveformDataLength = computed(() => waveformData.value.length);
const waveformDataHash = computed(() => {
  // Create a simple hash to detect when waveform content changes
  const data = waveformData.value;
  if (data.length === 0) return 0;
  // Sample a few values to create a hash
  return data[0] + (data[Math.floor(data.length / 2)] || 0) + (data[data.length - 1] || 0);
});

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

// Watch for props changes and waveform data changes (when selected track switches)
// Use waveformDataHash to detect actual content changes, not just reference changes
watch([() => props.startTime, () => props.endTime, () => props.color, waveformDataHash, duration], render, { immediate: true });
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
