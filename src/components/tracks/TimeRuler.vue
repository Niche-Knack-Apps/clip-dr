<script setup lang="ts">
import { computed } from 'vue';
import { generateTicks } from './time-ruler-utils';

const props = defineProps<{
  panelWidth: number;
  containerWidth: number;
  timelineDuration: number;
  timeFormat: 'hms' | 'ms';
}>();

const ticks = computed(() =>
  generateTicks(props.containerWidth, props.timelineDuration, props.timeFormat),
);
</script>

<template>
  <div class="relative w-full h-full overflow-hidden pointer-events-none">
    <template v-for="tick in ticks" :key="tick.time">
      <!-- Tick mark -->
      <div
        class="absolute bottom-0 w-px"
        :class="tick.label !== null ? 'h-2 bg-gray-600' : 'h-1 bg-gray-700'"
        :style="{ left: `${panelWidth + tick.x}px` }"
      />
      <!-- Label -->
      <div
        v-if="tick.label !== null"
        class="absolute top-px font-mono text-[9px] text-gray-500 whitespace-nowrap select-none"
        :style="{ left: `${panelWidth + tick.x}px`, transform: 'translateX(-50%)' }"
      >
        {{ tick.label }}
      </div>
    </template>
  </div>
</template>
