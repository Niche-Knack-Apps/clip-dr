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
  const w = containerRef.value.clientWidth;
  const h = containerRef.value.clientHeight;
  if (w === 0 || h === 0) return; // not laid out yet
  canvasWidth = w;
  canvasHeight = h;
  canvasRef.value.width = Math.floor(w * dpr);
  canvasRef.value.height = Math.floor(h * dpr);
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
  // Re-measure if needed (container may have been laid out since last check)
  if (canvasWidth === 0 && containerRef.value) {
    updateCanvasSize();
  }
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
  const maxBars = Math.min(count, Math.floor(w / 2));
  const barWidth = w / maxBars;
  const centerY = h / 2;

  ctx.fillStyle = color;

  const startIdx = (head - maxBars + buffer.length) % buffer.length;
  for (let i = 0; i < maxBars; i++) {
    const idx = (startIdx + i) % buffer.length;
    const sample = buffer[idx];
    const barH = sample.peak * h * 0.9;
    const x = i * barWidth;
    ctx.fillRect(x, centerY - barH / 2, Math.max(1, barWidth - 0.5), barH);
  }

  // Center line
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.stroke();

  lastVersion = view.version;
  lastWidth = canvasWidth;
  lastHeight = canvasHeight;
}

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

defineExpose({ isDirty, draw });
</script>

<template>
  <div
    class="flex bg-gray-900 rounded-lg overflow-hidden border border-gray-700/50"
    :style="{ height: `${height}px` }"
  >
    <!-- Compact header -->
    <div class="shrink-0 w-40 flex flex-col gap-1 p-2 bg-gray-800/60 border-r border-gray-700/50">
      <div class="text-xs text-gray-200 font-medium truncate" :title="session.deviceName">
        {{ session.deviceName }}
      </div>
      <div class="text-base font-mono text-white/90">{{ formatDuration(session.duration) }}</div>
      <div class="text-[10px] text-gray-500">Stereo</div>
      <button
        v-if="session.active && !recordingStore.isLocked"
        class="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-red-600/80 hover:bg-red-500 text-white transition-colors w-fit"
        @click.stop="stopSession"
      >
        <svg class="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1" /></svg>
        Stop
      </button>
      <div v-else-if="recordingStore.isFinalizing" class="text-[10px] text-amber-400">Finalizing...</div>
    </div>

    <!-- Waveform canvas -->
    <div ref="containerRef" class="flex-1 min-w-0">
      <canvas ref="canvasRef" class="w-full h-full" />
    </div>

    <!-- VU Meter -->
    <div class="shrink-0 w-7 flex items-end justify-center py-1 bg-gray-800/40 border-l border-gray-700/50">
      <div
        class="relative w-3.5 rounded-sm overflow-hidden"
        :style="{ height: `${Math.max(30, height - 12)}px` }"
      >
        <div
          class="absolute inset-0"
          style="background: linear-gradient(to top, #22c55e 0%, #22c55e 60%, #eab308 75%, #ef4444 100%)"
        />
        <div
          class="absolute inset-0 bg-gray-800 origin-top transition-transform duration-75"
          :style="{ transform: `scaleY(${1 - Math.min(1, session.level)})` }"
        />
        <div
          v-if="session.level >= 0.99"
          class="absolute top-0 left-0 right-0 h-1 bg-red-500 rounded-sm"
        />
      </div>
    </div>
  </div>
</template>
