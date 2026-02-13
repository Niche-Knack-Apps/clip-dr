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

// Waveform data: from clip or track's main audioData (overview resolution)
const waveformData = computed(() => {
  if (props.clip?.waveformData) return props.clip.waveformData;
  return props.track.audioData.waveformData;
});

// AudioBuffer for on-demand high-res extraction when zoomed in
const audioBuffer = computed(() => {
  if (props.clip?.buffer) return props.clip.buffer;
  return props.track.audioData.buffer;
});

// Waveform color: darker version of track color (~50% opacity)
const waveformColor = computed(() => {
  if (props.track.muted) return 'rgba(75, 85, 99, 0.6)';
  return `${props.track.color}80`; // 80 = 50% opacity
});

// Density check: skip waveform rendering when zoomed out too far
const pxPerSecond = computed(() => {
  if (clipDuration.value <= 0) return Infinity;
  return width.value / clipDuration.value;
});
const showWaveform = computed(() => pxPerSecond.value >= 2);

// Cache for high-res waveform extraction (avoid recomputing every frame)
let hiResCache: { key: string; data: number[] } | null = null;

/**
 * Extract high-resolution peaks directly from the AudioBuffer for the current pixel width.
 * Only called when zoomed in beyond the stored bucket resolution.
 */
function extractHiResPeaks(buffer: AudioBuffer, targetBuckets: number): number[] {
  const cacheKey = `${buffer.length}_${targetBuckets}`;
  if (hiResCache?.key === cacheKey) return hiResCache.data;

  const channelData = buffer.getChannelData(0);
  const samplesPerBucket = Math.ceil(channelData.length / targetBuckets);
  const waveform: number[] = new Array(targetBuckets * 2);

  for (let i = 0; i < targetBuckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, channelData.length);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const s = channelData[j];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    waveform[i * 2] = min;
    waveform[i * 2 + 1] = max;
  }

  hiResCache = { key: cacheKey, data: waveform };
  return waveform;
}

function drawWaveform() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  // When zoomed out too far, clear canvas and let the colored background show through
  if (!showWaveform.value) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const overviewData = waveformData.value;
  if (!overviewData || overviewData.length < 2) return;

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

  const overviewBuckets = overviewData.length / 2;
  const barsNeeded = Math.floor(pixelWidth);

  // Decide whether to use overview data or extract hi-res from AudioBuffer
  // If we need more bars than buckets and buffer is available, extract on-demand
  let data = overviewData;
  let bucketCount = overviewBuckets;

  if (barsNeeded > overviewBuckets * 1.5 && audioBuffer.value) {
    // Zoomed in: extract higher-resolution peaks from the actual audio samples
    const targetBuckets = Math.min(barsNeeded, 8000); // cap to avoid huge arrays
    data = extractHiResPeaks(audioBuffer.value, targetBuckets);
    bucketCount = targetBuckets;
  }

  const centerY = pixelHeight / 2;
  ctx.fillStyle = waveformColor.value;
  ctx.beginPath();

  // Downsample or upsample to fit pixel width
  const barsToRender = Math.min(barsNeeded, bucketCount);
  const barWidth = pixelWidth / barsToRender;
  const bucketStep = bucketCount / barsToRender;

  for (let i = 0; i < barsToRender; i++) {
    const bucketStart = Math.floor(i * bucketStep);
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketStep), bucketCount);

    let min = 0;
    let max = 0;
    for (let b = bucketStart; b < bucketEnd; b++) {
      const bMin = data[b * 2];
      const bMax = data[b * 2 + 1];
      if (bMin < min) min = bMin;
      if (bMax > max) max = bMax;
    }
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

// Redraw when waveform data, width, muted state, or density threshold changes
watch([waveformData, width, waveformColor, showWaveform], () => {
  nextTick(drawWaveform);
});

onMounted(() => {
  nextTick(drawWaveform);
});

// ResizeObserver for the canvas container (debounced with rAF)
let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;
onMounted(() => {
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        drawWaveform();
      });
    });
    resizeObserver.observe(canvasRef.value);
  }
});
onUnmounted(() => {
  resizeObserver?.disconnect();
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId);
  }
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
