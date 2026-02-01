<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  value: number;
  max?: number;
  showLabel?: boolean;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

const props = withDefaults(defineProps<Props>(), {
  max: 100,
  showLabel: false,
  size: 'md',
});

const percentage = computed(() => {
  return Math.min(100, Math.max(0, (props.value / props.max) * 100));
});

const displayLabel = computed(() => {
  return props.label ?? `${Math.round(percentage.value)}%`;
});
</script>

<template>
  <div class="w-full">
    <div
      v-if="showLabel"
      class="flex justify-between text-xs text-gray-400 mb-1"
    >
      <span>{{ displayLabel }}</span>
      <span>{{ Math.round(percentage) }}%</span>
    </div>
    <div
      :class="[
        'w-full bg-gray-700 rounded-full overflow-hidden',
        {
          'h-1': size === 'sm',
          'h-2': size === 'md',
          'h-3': size === 'lg',
        },
      ]"
    >
      <div
        class="h-full bg-waveform-wave transition-all duration-300 ease-out"
        :style="{ width: `${percentage}%` }"
      />
    </div>
  </div>
</template>
