<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRecordingStore } from '@/stores/recording';
import { useSettingsStore } from '@/stores/settings';

const props = withDefaults(defineProps<{
  height?: number;
}>(), {
  height: 100,
});

const recordingStore = useRecordingStore();
const settingsStore = useSettingsStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const canvasWidth = ref(800);

// Store recent level samples for waveform visualization
// Plain array (not reactive) - only read by draw(), no need for Vue tracking
let levelHistory: number[] = [];
const maxHistoryLength = 200; // Show last N samples

let rafId: number | null = null;
let lastUpdateTime = 0;
const updateInterval = 50; // ms between visual updates

// Canvas drawing
function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvasWidth.value;
  const height = props.height;
  const color = settingsStore.settings.waveformColor;

  // Clear canvas
  ctx.fillStyle = '#1f2937'; // gray-800
  ctx.fillRect(0, 0, width, height);

  // Draw waveform from level history
  if (levelHistory.length === 0) {
    // Draw waiting indicator
    ctx.fillStyle = '#4b5563'; // gray-600
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for audio...', width / 2, height / 2);
    return;
  }

  const samples = levelHistory;
  const barWidth = width / maxHistoryLength;

  ctx.fillStyle = color;

  for (let i = 0; i < samples.length; i++) {
    const level = samples[i];
    const barHeight = level * height * 0.9; // Leave some margin
    const x = i * barWidth;
    const y = (height - barHeight) / 2;

    // Draw symmetric bar (above and below center line)
    ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
  }

  // Draw center line
  ctx.strokeStyle = '#374151'; // gray-700
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
}

// Animation loop — only runs while recording to avoid idle CPU usage
function animate() {
  if (!recordingStore.isRecording) {
    // Recording stopped: do a final redraw then stop the loop
    if (levelHistory.length > 0) {
      draw();
    }
    rafId = null;
    return;
  }

  const now = performance.now();

  if (now - lastUpdateTime >= updateInterval) {
    levelHistory.push(recordingStore.currentLevel);

    if (levelHistory.length > maxHistoryLength) {
      levelHistory.shift();
    }

    lastUpdateTime = now;
    draw();
  }

  rafId = requestAnimationFrame(animate);
}

function startAnimationLoop() {
  if (rafId !== null) return; // already running
  rafId = requestAnimationFrame(animate);
}

// Watch recording state to start/stop the rAF loop
watch(() => recordingStore.isRecording, (isRecording) => {
  if (isRecording) {
    levelHistory = [];
    startAnimationLoop();
  }
  // Stop is handled inside animate() when isRecording becomes false
});

// Handle container resize
let resizeObserver: ResizeObserver | null = null;

function updateCanvasSize() {
  if (containerRef.value) {
    canvasWidth.value = containerRef.value.clientWidth;
    draw();
  }
}

onMounted(() => {
  updateCanvasSize();

  resizeObserver = new ResizeObserver(updateCanvasSize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }

  // Only start the rAF loop if already recording; otherwise the watcher handles it
  if (recordingStore.isRecording) {
    startAnimationLoop();
  } else {
    draw(); // draw the idle state once
  }
});

onUnmounted(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
  }
  resizeObserver?.disconnect();
});
</script>

<template>
  <div
    ref="containerRef"
    class="w-full rounded overflow-hidden bg-gray-800"
    :style="{ height: `${height}px` }"
  >
    <canvas
      ref="canvasRef"
      :width="canvasWidth"
      :height="height"
      class="w-full h-full"
    />
  </div>
</template>
