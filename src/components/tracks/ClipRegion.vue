<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { Track, TrackClip } from '@/shared/types';

interface Props {
  track: Track;
  clip?: TrackClip;
  containerWidth: number;
  duration: number;
  isDragging?: boolean;
  draggingClipId?: string | null;
  isSelected?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isDragging: false,
  draggingClipId: null,
  isSelected: false,
});

const emit = defineEmits<{
  dragStart: [clipId: string, event: MouseEvent];
}>();

// Use clip position if provided, otherwise fall back to track position
const clipId = computed(() => props.clip?.id ?? props.track.id + '-main');
const clipStart = computed(() => props.clip?.clipStart ?? props.track.trackStart);
const clipDuration = computed(() => props.clip?.duration ?? props.track.duration);

// Only show as dragging if this specific clip is being dragged
const isThisClipDragging = computed(() =>
  props.isDragging && props.draggingClipId === clipId.value
);

// Calculate pixel position and width
const left = computed(() => {
  if (props.duration <= 0) return 0;
  return (clipStart.value / props.duration) * props.containerWidth;
});

const width = computed(() => {
  if (props.duration <= 0) return 0;
  return (clipDuration.value / props.duration) * props.containerWidth;
});

// Use track's color with opacity
const bgColor = computed(() => {
  if (props.track.muted) return 'rgba(75, 85, 99, 0.5)'; // gray-600/50
  return `${props.track.color}30`; // 30 = ~19% opacity
});

const borderColor = computed(() => {
  if (props.track.muted) return 'rgb(75, 85, 99)'; // gray-600
  if (props.isSelected) return 'rgba(255, 255, 255, 0.6)';
  return props.track.color;
});

// Waveform canvas
const canvasRef = ref<HTMLCanvasElement | null>(null);

// Waveform data: from clip or track's main audioData
const waveformData = computed(() => {
  if (props.clip?.waveformData) return props.clip.waveformData;
  return props.track.audioData.waveformData;
});

// Waveform color: darker version of track color (~50% opacity)
const waveformColor = computed(() => {
  if (props.track.muted) return 'rgba(75, 85, 99, 0.6)';
  return `${props.track.color}80`; // 80 = 50% opacity
});

function drawWaveform() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const data = waveformData.value;
  if (!data || data.length < 2) return;

  const pixelWidth = Math.max(2, width.value);
  const pixelHeight = canvas.clientHeight;
  if (pixelWidth <= 0 || pixelHeight <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = pixelWidth * dpr;
  canvas.height = pixelHeight * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);

  // Data is flattened min/max pairs: [min0, max0, min1, max1, ...]
  const bucketCount = data.length / 2;
  const centerY = pixelHeight / 2;

  ctx.fillStyle = waveformColor.value;
  ctx.beginPath();

  // Downsample or upsample to fit pixel width
  const barsToRender = Math.min(Math.floor(pixelWidth), bucketCount);
  const barWidth = pixelWidth / barsToRender;
  const bucketStep = bucketCount / barsToRender;

  for (let i = 0; i < barsToRender; i++) {
    // Map bar index to bucket range
    const bucketStart = Math.floor(i * bucketStep);
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketStep), bucketCount);

    // Find min/max across the bucket range
    let min = 0;
    let max = 0;
    for (let b = bucketStart; b < bucketEnd; b++) {
      const bMin = data[b * 2];
      const bMax = data[b * 2 + 1];
      if (bMin < min) min = bMin;
      if (bMax > max) max = bMax;
    }
    // If bucketEnd === bucketStart, use single bucket
    if (bucketEnd === bucketStart) {
      min = data[bucketStart * 2] ?? 0;
      max = data[bucketStart * 2 + 1] ?? 0;
    }

    const x = i * barWidth;
    const topY = centerY - max * centerY;
    const bottomY = centerY - min * centerY;
    const barH = Math.max(1, bottomY - topY);

    ctx.rect(x, topY, barWidth, barH);
  }

  ctx.fill();
}

// Redraw when waveform data, width, or muted state changes
watch([waveformData, width, waveformColor], () => {
  nextTick(drawWaveform);
});

onMounted(() => {
  nextTick(drawWaveform);
});

// ResizeObserver for the canvas container
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(() => drawWaveform());
    resizeObserver.observe(canvasRef.value);
  }
});
onUnmounted(() => {
  resizeObserver?.disconnect();
});

function handleMouseDown(event: MouseEvent) {
  // Prevent default to avoid text selection during drag
  event.preventDefault();
  // Stop propagation so parent track click doesn't fire (which would clear clip selection)
  event.stopPropagation();
  emit('dragStart', clipId.value, event);
}
</script>

<template>
  <div
    class="absolute top-1 bottom-1 rounded cursor-grab active:cursor-grabbing select-none overflow-hidden"
    :class="[
      track.solo ? 'ring-2 ring-yellow-500' : '',
      isThisClipDragging ? 'opacity-70 ring-2 ring-cyan-400' : '',
      isSelected && !isThisClipDragging && !track.solo ? 'ring-2 ring-white/60 shadow-lg shadow-white/10' : '',
    ]"
    :style="{
      left: `${left}px`,
      width: `${Math.max(2, width)}px`,
      backgroundColor: bgColor,
    }"
    @mousedown="handleMouseDown"
    @click.stop
  >
    <!-- Waveform canvas -->
    <canvas
      ref="canvasRef"
      class="absolute inset-0 w-full h-full pointer-events-none"
    />
    <div
      class="absolute inset-0 border rounded pointer-events-none"
      :style="{ borderColor: borderColor }"
    />
    <!-- Drag indicator when dragging -->
    <div
      v-if="isThisClipDragging"
      class="absolute inset-0 flex items-center justify-center text-[10px] text-cyan-400 font-medium"
    >
      {{ clipStart.toFixed(2) }}s
    </div>
  </div>
</template>
