<script setup lang="ts">
import { computed } from 'vue';
import type { Track } from '@/shared/types';

interface Props {
  track: Track;
  containerWidth: number;
  duration: number;
}

const props = defineProps<Props>();

const left = computed(() => {
  return (props.track.start / props.duration) * props.containerWidth;
});

const width = computed(() => {
  const trackDuration = props.track.end - props.track.start;
  return (trackDuration / props.duration) * props.containerWidth;
});
</script>

<template>
  <div
    class="absolute top-1 bottom-1 rounded"
    :class="[
      track.muted ? 'bg-gray-600/50' : 'bg-waveform-clip/30',
      track.solo ? 'ring-2 ring-yellow-500' : '',
    ]"
    :style="{
      left: `${left}px`,
      width: `${width}px`,
    }"
  >
    <div
      class="absolute inset-0 border rounded"
      :class="track.muted ? 'border-gray-600' : 'border-waveform-clip'"
    />
  </div>
</template>
