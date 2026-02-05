<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  showValue?: boolean;
  formatValue?: (value: number) => string;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 100,
  step: 1,
  disabled: false,
  showValue: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

const percentage = computed(() => {
  return ((props.modelValue - props.min) / (props.max - props.min)) * 100;
});

const displayValue = computed(() => {
  if (props.formatValue) {
    return props.formatValue(props.modelValue);
  }
  return props.modelValue.toString();
});

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', parseFloat(target.value));
}
</script>

<template>
  <div class="flex items-center gap-2">
    <div class="relative flex-1">
      <input
        type="range"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        :disabled="disabled"
        class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
        :style="{ '--percentage': `${percentage}%` }"
        @input="handleInput"
      />
    </div>
    <span v-if="showValue" class="text-xs text-gray-400 min-w-[3rem] text-right">
      {{ displayValue }}
    </span>
  </div>
</template>

<style scoped>
.slider {
  background: linear-gradient(
    to right,
    #00d4ff 0%,
    #00d4ff var(--percentage),
    #374151 var(--percentage),
    #374151 100%
  );
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  background: #00d4ff;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.1s;
}

.slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}

.slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: #00d4ff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}

.slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.slider:disabled::-webkit-slider-thumb {
  cursor: not-allowed;
}
</style>
