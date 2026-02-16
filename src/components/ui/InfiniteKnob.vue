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
    class="inline-flex flex-col items-center select-none"
    :class="isDragging ? 'cursor-grabbing' : 'cursor-ew-resize'"
    @mousedown="handleMouseDown"
    @dblclick="handleDoubleClick"
  >
    <span v-if="label" class="text-[8px] text-gray-500 leading-none mb-0.5">{{ label }}</span>
    <div
      class="px-2 py-0.5 rounded-full text-[10px] font-mono text-gray-300 bg-gray-700/80 hover:bg-gray-600/80 transition-colors whitespace-nowrap min-w-[3rem] text-center"
      :class="{ 'bg-cyan-900/60 ring-1 ring-cyan-500/50': isDragging }"
    >
      {{ displayValue }}
    </div>
  </div>
</template>
