<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SilenceRegion } from '@/shared/types';

interface Props {
  region: SilenceRegion;
  containerWidth: number;
  startTime: number;  // Visible range start
  endTime: number;    // Visible range end
}

const props = defineProps<Props>();

const emit = defineEmits<{
  resize: [id: string, updates: { start?: number; end?: number }];
  move: [id: string, delta: number];
  delete: [id: string];
  restore: [id: string];
}>();

const overlayRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);
const isResizingStart = ref(false);
const isResizingEnd = ref(false);
const lastX = ref(0);
const isHovered = ref(false);

const visibleDuration = computed(() => props.endTime - props.startTime);

const pixelsPerSecond = computed(() => {
  if (visibleDuration.value <= 0) return 1;
  return props.containerWidth / visibleDuration.value;
});

// Calculate visible portion of region
const visibleStart = computed(() => Math.max(props.region.start, props.startTime));
const visibleEnd = computed(() => Math.min(props.region.end, props.endTime));

const left = computed(() => {
  return ((visibleStart.value - props.startTime) / visibleDuration.value) * props.containerWidth;
});

const width = computed(() => {
  const w = ((visibleEnd.value - visibleStart.value) / visibleDuration.value) * props.containerWidth;
  return Math.max(0, w);
});

// Check if region is fully visible or clipped
const isClippedStart = computed(() => props.region.start < props.startTime);
const isClippedEnd = computed(() => props.region.end > props.endTime);

function getContainerLeft(): number {
  if (overlayRef.value?.parentElement) {
    return overlayRef.value.parentElement.getBoundingClientRect().left;
  }
  return 0;
}

function xToTime(clientX: number): number {
  const containerLeft = getContainerLeft();
  const x = clientX - containerLeft;
  return (x / props.containerWidth) * visibleDuration.value + props.startTime;
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  if (!props.region.enabled) return;

  isDragging.value = true;
  lastX.value = event.clientX;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleResizeStartMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  if (!props.region.enabled) return;
  event.stopPropagation();

  isResizingStart.value = true;

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleResizeEndMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  if (!props.region.enabled) return;
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
    emit('move', props.region.id, deltaTime);
  } else if (isResizingStart.value) {
    const newStart = xToTime(event.clientX);
    emit('resize', props.region.id, { start: newStart });
  } else if (isResizingEnd.value) {
    const newEnd = xToTime(event.clientX);
    emit('resize', props.region.id, { end: newEnd });
  }
}

function handleMouseUp() {
  isDragging.value = false;
  isResizingStart.value = false;
  isResizingEnd.value = false;

  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}

function handleDelete(event: MouseEvent) {
  event.stopPropagation();
  emit('delete', props.region.id);
}

function handleRestore(event: MouseEvent) {
  event.stopPropagation();
  emit('restore', props.region.id);
}
</script>

<template>
  <div
    v-if="width > 0"
    ref="overlayRef"
    :class="[
      'absolute top-0 bottom-0 transition-opacity',
      region.enabled ? 'cursor-move' : 'cursor-pointer',
    ]"
    :style="{
      left: `${left}px`,
      width: `${width}px`,
    }"
    @mousedown="handleMouseDown"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <!-- Red overlay background -->
    <div
      :class="[
        'absolute inset-0 transition-colors',
        region.enabled
          ? 'bg-red-500/30 border-y border-red-500/50'
          : 'bg-red-500/10 border-y border-red-500/20',
      ]"
    />

    <!-- Left resize handle (only if not clipped) -->
    <div
      v-if="region.enabled && !isClippedStart"
      class="absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize hover:bg-red-400/50 transition-colors z-10"
      @mousedown="handleResizeStartMouseDown"
    />

    <!-- Right resize handle (only if not clipped) -->
    <div
      v-if="region.enabled && !isClippedEnd"
      class="absolute top-0 bottom-0 right-0 w-2 cursor-ew-resize hover:bg-red-400/50 transition-colors z-10"
      @mousedown="handleResizeEndMouseDown"
    />

    <!-- Delete/Restore button (on hover) -->
    <div
      v-if="isHovered && width > 20"
      class="absolute top-1 right-1 z-20"
    >
      <button
        v-if="region.enabled"
        type="button"
        class="w-5 h-5 flex items-center justify-center bg-red-600 hover:bg-red-500 text-white rounded-full text-xs shadow-lg transition-colors"
        title="Restore this audio (remove silence mark)"
        @click="handleDelete"
      >
        &times;
      </button>
      <button
        v-else
        type="button"
        class="w-5 h-5 flex items-center justify-center bg-gray-600 hover:bg-gray-500 text-white rounded-full text-xs shadow-lg transition-colors"
        title="Mark as silence again"
        @click="handleRestore"
      >
        +
      </button>
    </div>

    <!-- Duration indicator (on hover for larger regions) -->
    <div
      v-if="isHovered && width > 60"
      class="absolute bottom-1 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-black/70 text-white text-[10px] font-mono rounded whitespace-nowrap"
    >
      {{ ((region.end - region.start) * 1000).toFixed(0) }}ms
    </div>
  </div>
</template>
