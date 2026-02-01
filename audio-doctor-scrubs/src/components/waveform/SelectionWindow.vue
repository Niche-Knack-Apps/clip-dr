<script setup lang="ts">
import { ref, computed } from 'vue';

interface Props {
  start: number;
  end: number;
  containerWidth: number;
  containerLeft: number;
  duration: number;
  color?: string;
}

const props = withDefaults(defineProps<Props>(), {
  color: 'rgba(0, 212, 255, 0.3)',
  containerLeft: 0,
});

const emit = defineEmits<{
  move: [delta: number];
  resizeStart: [newStart: number];
  resizeEnd: [newEnd: number];
}>();

const windowRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);
const isResizingStart = ref(false);
const isResizingEnd = ref(false);
const lastX = ref(0);

const pixelsPerSecond = computed(() => {
  if (props.duration <= 0) return 1;
  return props.containerWidth / props.duration;
});

const left = computed(() => {
  return (props.start / props.duration) * props.containerWidth;
});

const width = computed(() => {
  return ((props.end - props.start) / props.duration) * props.containerWidth;
});

function getContainerLeft(): number {
  if (windowRef.value?.parentElement) {
    return windowRef.value.parentElement.getBoundingClientRect().left;
  }
  return props.containerLeft;
}

function xToTime(clientX: number): number {
  const containerLeft = getContainerLeft();
  const x = clientX - containerLeft;
  return Math.max(0, Math.min((x / props.containerWidth) * props.duration, props.duration));
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;

  isDragging.value = true;
  lastX.value = event.clientX;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleResizeStartMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  event.stopPropagation();

  isResizingStart.value = true;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleResizeEndMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  event.stopPropagation();

  isResizingEnd.value = true;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  if (isDragging.value) {
    const deltaX = event.clientX - lastX.value;
    lastX.value = event.clientX;
    const deltaTime = deltaX / pixelsPerSecond.value;
    emit('move', deltaTime);
  } else if (isResizingStart.value) {
    const newStart = xToTime(event.clientX);
    emit('resizeStart', newStart);
  } else if (isResizingEnd.value) {
    const newEnd = xToTime(event.clientX);
    emit('resizeEnd', newEnd);
  }
}

function handleMouseUp() {
  isDragging.value = false;
  isResizingStart.value = false;
  isResizingEnd.value = false;

  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}
</script>

<template>
  <div
    ref="windowRef"
    class="absolute top-0 bottom-0 cursor-move"
    :style="{
      left: `${left}px`,
      width: `${width}px`,
      backgroundColor: color,
    }"
    @mousedown="handleMouseDown"
  >
    <!-- Left resize handle -->
    <div
      class="absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize hover:bg-cyan-400/50 transition-colors"
      @mousedown="handleResizeStartMouseDown"
    />

    <!-- Right resize handle -->
    <div
      class="absolute top-0 bottom-0 right-0 w-2 cursor-ew-resize hover:bg-cyan-400/50 transition-colors"
      @mousedown="handleResizeEndMouseDown"
    />

    <!-- Selection border -->
    <div
      class="absolute inset-0 border-2 border-waveform-wave pointer-events-none"
    />
  </div>
</template>
