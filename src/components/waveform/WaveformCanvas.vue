<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useWaveform } from '@/composables/useWaveform';

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
let resizeRafId: number | null = null;

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

  renderWaveform(ctx, buckets, {
    width: width.value,
    height: props.height,
    color: props.color,
    backgroundColor: props.backgroundColor,
  });
}

function updateSize() {
  if (containerRef.value) {
    const newWidth = containerRef.value.clientWidth;
    if (newWidth === width.value) return; // No change, skip redraw
    width.value = newWidth;
    render();
  }
}

// Debounce ResizeObserver to avoid redundant redraws during zoom/resize
function handleResize() {
  if (resizeRafId !== null) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    updateSize();
  });
}

onMounted(() => {
  updateSize();

  resizeObserver = new ResizeObserver(handleResize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

// rAF-throttled render to coalesce rapid startTime/endTime changes during playback
let renderRafId: number | null = null;

function scheduleRender() {
  if (renderRafId !== null) return;
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null;
    render();
  });
}

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
  }
  if (renderRafId !== null) {
    cancelAnimationFrame(renderRafId);
  }
});

// Watch for props changes and waveform data changes (when tracks are modified)
watch([() => props.startTime, () => props.endTime, () => props.color, waveformVersion, duration], scheduleRender, { immediate: true });
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
