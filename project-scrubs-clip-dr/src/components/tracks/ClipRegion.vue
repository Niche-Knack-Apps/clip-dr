<script setup lang="ts">
import { computed } from 'vue';
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
    class="absolute top-1 bottom-1 rounded cursor-grab active:cursor-grabbing select-none"
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
