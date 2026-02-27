<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  level: number; // 0-1, updated at ~80ms polling intervals
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const levels: number[] = [];
const maxBars = 60;
let rafId: number | null = null;

function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const barWidth = w / maxBars;

  ctx.fillStyle = '#1f2937';
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < levels.length; i++) {
    const barHeight = Math.max(1, levels[i] * h * 0.9);
    const x = i * barWidth;
    const y = (h - barHeight) / 2;

    if (levels[i] > 0.9) ctx.fillStyle = '#ef4444';
    else if (levels[i] > 0.7) ctx.fillStyle = '#eab308';
    else ctx.fillStyle = '#22c55e';

    ctx.fillRect(x, y, Math.max(1, barWidth - 0.5), barHeight);
  }
}

watch(() => props.level, (newLevel) => {
  levels.push(newLevel);
  if (levels.length > maxBars) levels.shift();
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      draw();
      rafId = null;
    });
  }
});

onMounted(() => draw());
onUnmounted(() => { if (rafId) cancelAnimationFrame(rafId); });
</script>

<template>
  <canvas
    ref="canvasRef"
    class="w-full h-5 rounded bg-gray-800"
    :width="240"
    :height="20"
  />
</template>
