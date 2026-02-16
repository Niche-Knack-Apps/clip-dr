<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';

interface Props {
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  sensitivity?: number;
  defaultValue?: number;
  label?: string;
  formatValue?: (v: number) => string;
  logarithmic?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  step: 0.1,
  sensitivity: 2,
  defaultValue: undefined,
  label: undefined,
  formatValue: undefined,
  logarithmic: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

const isDragging = ref(false);
let dragStartX = 0;
let dragStartValue = 0;
let rafId: number | null = null;
let pendingEvent: MouseEvent | null = null;

const displayValue = computed(() => {
  if (props.formatValue) return props.formatValue(props.modelValue);
  return props.modelValue.toFixed(1);
});

// Position of thumb indicator within the track (0-100%)
const positionPercent = computed(() => {
  if (props.logarithmic) {
    const logMin = Math.log(Math.max(props.min, 1e-10));
    const logMax = Math.log(props.max);
    const logVal = Math.log(Math.max(props.modelValue, props.min));
    return Math.max(0, Math.min(100, ((logVal - logMin) / (logMax - logMin)) * 100));
  }
  if (props.max === props.min) return 0;
  return Math.max(0, Math.min(100, ((props.modelValue - props.min) / (props.max - props.min)) * 100));
});

function clamp(value: number): number {
  const stepped = Math.round(value / props.step) * props.step;
  return Math.max(props.min, Math.min(props.max, stepped));
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  isDragging.value = true;
  dragStartX = event.clientX;
  dragStartValue = props.logarithmic
    ? Math.log(Math.max(props.min, props.modelValue))
    : props.modelValue;
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  pendingEvent = event;
  if (rafId === null) {
    rafId = requestAnimationFrame(flushDrag);
  }
}

function flushDrag() {
  rafId = null;
  if (!pendingEvent) return;
  const deltaX = pendingEvent.clientX - dragStartX;
  pendingEvent = null;

  if (props.logarithmic) {
    const logMin = Math.log(Math.max(props.min, 1e-10));
    const logMax = Math.log(props.max);
    const logRange = logMax - logMin;
    const logDelta = (deltaX / (props.sensitivity * 100)) * logRange;
    const newLog = Math.max(logMin, Math.min(logMax, dragStartValue + logDelta));
    emit('update:modelValue', clamp(Math.exp(newLog)));
  } else {
    const valueDelta = (deltaX / props.sensitivity) * props.step;
    emit('update:modelValue', clamp(dragStartValue + valueDelta));
  }
}

function handleMouseUp() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingEvent = null;
  isDragging.value = false;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}

function handleDoubleClick() {
  if (props.defaultValue !== undefined) {
    emit('update:modelValue', props.defaultValue);
  }
}

onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
});
</script>

<template>
  <div
    class="flex items-center gap-1.5 select-none"
    :class="isDragging ? 'cursor-grabbing' : 'cursor-ew-resize'"
    @mousedown="handleMouseDown"
    @dblclick="handleDoubleClick"
  >
    <span v-if="label" class="text-[8px] text-gray-500 leading-none shrink-0">{{ label }}</span>
    <!-- Trim slider track with fill, thumb, and grip ridges -->
    <div
      class="relative h-3.5 flex-1 min-w-[40px] bg-gray-800 rounded-sm overflow-hidden border transition-colors"
      :class="isDragging ? 'border-cyan-500/60' : 'border-gray-600/40'"
    >
      <!-- Fill bar showing current position -->
      <div
        class="absolute inset-y-0 left-0 bg-cyan-600/25"
        :style="{ width: `${positionPercent}%` }"
      />
      <!-- Thumb indicator line -->
      <div
        class="absolute top-0 bottom-0 w-0.5 bg-cyan-400"
        :style="{ left: `${positionPercent}%` }"
      />
      <!-- Grip ridges for drag affordance -->
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div class="flex gap-[3px]">
          <div class="w-px h-2 bg-gray-400/30" />
          <div class="w-px h-2 bg-gray-400/30" />
          <div class="w-px h-2 bg-gray-400/30" />
          <div class="w-px h-2 bg-gray-400/30" />
          <div class="w-px h-2 bg-gray-400/30" />
        </div>
      </div>
    </div>
    <span class="text-[10px] font-mono text-gray-300 whitespace-nowrap shrink-0">{{ displayValue }}</span>
  </div>
</template>
