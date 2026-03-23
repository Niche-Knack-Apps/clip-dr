<script setup lang="ts">
import { ref, computed } from 'vue';
import { useTimelineViewport } from '@/composables/useTimelineViewport';
import { clientXToLocalX } from '@/shared/timeline-coordinates';

interface Props {
  position: number;
  containerWidth: number;
  startTime: number;
  endTime: number;
  color?: string;
  draggable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  color: '#ff3366',
  draggable: false,
});

const emit = defineEmits<{
  dragStart: [];
  drag: [time: number];
  dragEnd: [];
  click: [time: number];
}>();

const isDragging = ref(false);
const hasDragged = ref(false);
const playheadRef = ref<HTMLDivElement | null>(null);

// rAF-based throttle for mousemove during drag
let dragRafId: number | null = null;
let pendingDragClientX: number | null = null;

const { timeToX, xToTimeClamped } = useTimelineViewport(
  () => props.startTime,
  () => props.endTime,
  () => props.containerWidth,
);

const xPosition = computed(() => {
  return timeToX(props.position);
});

const isVisible = computed(() => {
  return props.position >= props.startTime && props.position <= props.endTime;
});

function xToTime(clientX: number): number {
  const el = playheadRef.value?.parentElement;
  if (!el) return props.startTime;
  return xToTimeClamped(clientXToLocalX(clientX, el));
}

function handleMouseDown(event: MouseEvent) {
  if (!props.draggable || event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();

  isDragging.value = true;
  hasDragged.value = false;
  emit('dragStart');

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

function handleMouseMove(event: MouseEvent) {
  if (!isDragging.value) return;
  hasDragged.value = true;
  pendingDragClientX = event.clientX;
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDrag);
  }
}

function flushDrag() {
  dragRafId = null;
  if (pendingDragClientX !== null && isDragging.value) {
    const time = xToTime(pendingDragClientX);
    pendingDragClientX = null;
    emit('drag', time);
  }
}

function handleMouseUp(event: MouseEvent) {
  // Flush any pending drag before ending
  if (pendingDragClientX !== null) {
    const time = xToTime(pendingDragClientX);
    pendingDragClientX = null;
    emit('drag', time);
  }
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }

  // If user clicked the playhead without dragging, treat as a seek click
  if (!hasDragged.value) {
    const time = xToTime(event.clientX);
    emit('click', time);
  }

  isDragging.value = false;
  hasDragged.value = false;
  emit('dragEnd');
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
}
</script>

<template>
  <div
    v-if="isVisible"
    ref="playheadRef"
    :class="[
      'absolute top-0 bottom-0 z-20',
      draggable ? 'cursor-ew-resize' : 'pointer-events-none',
    ]"
    :style="{
      transform: `translateX(${xPosition}px)`,
      willChange: 'transform',
      width: draggable ? '12px' : '2px',
      marginLeft: draggable ? '-6px' : '0',
    }"
    @mousedown="handleMouseDown"
  >
    <!-- Visible line -->
    <div
      class="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5"
      :style="{ backgroundColor: color }"
    />

    <!-- Top handle -->
    <div
      class="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0"
      :style="{
        borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent',
        borderTop: `6px solid ${color}`,
      }"
    />
  </div>
</template>
