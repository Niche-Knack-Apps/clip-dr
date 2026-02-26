<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  level: number; // 0-1
}>();

const widthPercent = computed(() => Math.min(100, props.level * 100));

const barColor = computed(() => {
  if (props.level > 0.9) return 'bg-red-500';
  if (props.level > 0.7) return 'bg-yellow-500';
  return 'bg-green-500';
});
</script>

<template>
  <div class="h-1.5 w-16 bg-gray-700 rounded-full overflow-hidden flex-shrink-0">
    <div
      :class="['h-full transition-all duration-75', barColor]"
      :style="{ width: `${widthPercent}%` }"
    />
  </div>
</template>
