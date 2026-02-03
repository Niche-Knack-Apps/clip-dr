<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  level: number; // 0-1
  showDb?: boolean;
}>();

const levelPercent = computed(() => Math.min(100, props.level * 100));

const levelDb = computed(() => {
  if (props.level <= 0) return '-inf';
  const db = 20 * Math.log10(props.level);
  return db.toFixed(1);
});

// Color based on level
const levelColor = computed(() => {
  if (props.level > 0.9) return 'bg-red-500';
  if (props.level > 0.7) return 'bg-yellow-500';
  return 'bg-green-500';
});
</script>

<template>
  <div class="space-y-1">
    <div class="flex items-center gap-2">
      <div class="flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
        <div
          :class="['h-full transition-all duration-75', levelColor]"
          :style="{ width: `${levelPercent}%` }"
        />
      </div>
      <span v-if="showDb" class="text-[10px] text-gray-500 font-mono w-12 text-right">
        {{ levelDb }} dB
      </span>
    </div>

    <!-- Peak indicator marks -->
    <div class="flex justify-between px-1 text-[8px] text-gray-600">
      <span>-60</span>
      <span>-24</span>
      <span>-12</span>
      <span>-6</span>
      <span>0</span>
    </div>
  </div>
</template>
