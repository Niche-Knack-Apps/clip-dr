<script setup lang="ts">
interface Props {
  modelValue: boolean;
  disabled?: boolean;
  label?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function toggle() {
  if (!props.disabled) {
    emit('update:modelValue', !props.modelValue);
  }
}
</script>

<template>
  <label
    class="inline-flex items-center cursor-pointer"
    :class="{ 'opacity-50 cursor-not-allowed': disabled }"
  >
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :class="[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-gray-900',
        modelValue ? 'bg-waveform-wave' : 'bg-gray-600',
      ]"
      :disabled="disabled"
      @click="toggle"
    >
      <span
        :class="[
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
          modelValue ? 'translate-x-4' : 'translate-x-0',
        ]"
      />
    </button>
    <span v-if="label" class="ml-2 text-sm text-gray-300">{{ label }}</span>
  </label>
</template>
