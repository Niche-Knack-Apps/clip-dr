<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRecordingStore } from '@/stores/recording';
import { useSettingsStore } from '@/stores/settings';
import type { RecordingSession } from '@/stores/recording';

const props = defineProps<{
  session: RecordingSession;
  height: number;
}>();

const recordingStore = useRecordingStore();
const settingsStore = useSettingsStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
let canvasWidth = 0;
let canvasHeight = 0;

// Dirty tracking (checked by parent's centralized render loop)
let lastVersion = -1;
let lastWidth = 0;
let lastHeight = 0;

// ResizeObserver for canvas container
let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;

function updateCanvasSize() {
  if (!containerRef.value || !canvasRef.value) return;
  const dpr = window.devicePixelRatio || 1;
  canvasWidth = containerRef.value.clientWidth;
  canvasHeight = containerRef.value.clientHeight;
  canvasRef.value.width = Math.floor(canvasWidth * dpr);
  canvasRef.value.height = Math.floor(canvasHeight * dpr);
}

function handleResize() {
  if (resizeRafId !== null) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    updateCanvasSize();
  });
}

onMounted(() => {
  updateCanvasSize();
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
});

/** Check if this lane needs redrawing (called by parent's render scheduler) */
function isDirty(): boolean {
  const view = recordingStore.getWaveformView(props.session.sessionId);
  const v = view?.version ?? -1;
  return v !== lastVersion || canvasWidth !== lastWidth || canvasHeight !== lastHeight;
}

/** Draw the waveform (called by parent when isDirty() returns true) */
function draw() {
  const canvas = canvasRef.value;
  if (!canvas || canvasWidth === 0 || canvasHeight === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = canvasWidth;
  const h = canvasHeight;
  const color = settingsStore.settings.waveformColor;

  // Clear
  ctx.fillStyle = '#111827'; // gray-900
  ctx.fillRect(0, 0, w, h);

  const view = recordingStore.getWaveformView(props.session.sessionId);
  if (!view || view.count === 0) {
    // Empty state
    ctx.fillStyle = '#4b5563';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for audio...', w / 2, h / 2 + 4);
    lastVersion = view?.version ?? -1;
    lastWidth = canvasWidth;
    lastHeight = canvasHeight;
    return;
  }

  // Draw scrolling peak envelope from ring buffer (zero-copy iteration)
  const { buffer, head, count } = view;
  const maxBars = Math.min(count, Math.floor(w / 2)); // ~2px per bar minimum
  const barWidth = w / maxBars;
  const centerY = h / 2;

  ctx.fillStyle = color;

  // Read from oldest to newest
  const startIdx = (head - maxBars + buffer.length) % buffer.length;
  for (let i = 0; i < maxBars; i++) {
    const idx = (startIdx + i) % buffer.length;
    const sample = buffer[idx];
    const barH = sample.peak * h * 0.9;
    const x = i * barWidth;
    // Symmetric around center
    ctx.fillRect(x, centerY - barH / 2, Math.max(1, barWidth - 0.5), barH);
  }

  // Center line
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.stroke();

  // Update dirty tracking
  lastVersion = view.version;
  lastWidth = canvasWidth;
  lastHeight = canvasHeight;
}

// Format duration as M:SS
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function stopSession() {
  if (recordingStore.sessions.length > 1) {
    recordingStore.stopDeviceSession(props.session.sessionId);
  } else {
    recordingStore.stopRecording();
  }
}

// Convert linear level (0-1) to dB-scaled pixel height for VU meter
function levelToPixels(level: number, meterH: number): number {
  if (level <= 0.001) return 0;
  const db = Math.max(-60, 20 * Math.log10(level));
  return ((db + 60) / 60) * meterH;
}

// Expose for parent's centralized render loop
defineExpose({ isDirty, draw });
</script>

<template>
  <div
    class="flex bg-gray-900 rounded-lg overflow-hidden border border-gray-700/50"
    :style="{ height: `${height}px` }"
  >
    <!-- Header -->
    <div class="shrink-0 w-40 flex flex-col justify-between p-2 bg-gray-800/60 border-r border-gray-700/50">
      <!-- Device name -->
      <div class="text-xs text-gray-200 font-medium truncate" :title="session.deviceName">
        {{ session.deviceName }}
      </div>

      <!-- Duration -->
      <div class="text-lg font-mono text-white/90 tracking-wide">
        {{ formatDuration(session.duration) }}
      </div>

      <!-- Quality badge -->
      <div class="text-[10px] text-gray-400">
        Stereo
      </div>

      <!-- Stop button -->
      <button
        v-if="session.active && !recordingStore.isLocked"
        class="mt-1 flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-red-600/80 hover:bg-red-500 text-white transition-colors"
        @click.stop="stopSession"
      >
        <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1" /></svg>
        Stop
      </button>
      <div v-else-if="recordingStore.isFinalizing" class="text-[10px] text-amber-400">
        Finalizing...
      </div>
    </div>

    <!-- Waveform canvas -->
    <div ref="containerRef" class="flex-1 min-w-0">
      <canvas ref="canvasRef" class="w-full h-full" />
    </div>

    <!-- VU Meter -->
    <div class="shrink-0 w-8 flex items-end justify-center p-1 bg-gray-800/40 border-l border-gray-700/50">
      <div
        class="relative w-4 rounded-sm overflow-hidden"
        :style="{ height: `${Math.max(40, height - 16)}px` }"
      >
        <!-- Gradient background (green → yellow → red, bottom to top) -->
        <div
          class="absolute inset-0"
          style="background: linear-gradient(to top, #22c55e 0%, #22c55e 60%, #eab308 75%, #ef4444 100%)"
        />
        <!-- Dark overlay that reveals gradient from bottom -->
        <div
          class="absolute inset-0 bg-gray-800 origin-top transition-transform duration-75"
          :style="{ transform: `scaleY(${1 - Math.min(1, session.level)})` }"
        />
        <!-- Clip indicator -->
        <div
          v-if="session.level >= 0.99"
          class="absolute top-0 left-0 right-0 h-1.5 bg-red-500 rounded-sm"
        />
      </div>
    </div>
  </div>
</template>
