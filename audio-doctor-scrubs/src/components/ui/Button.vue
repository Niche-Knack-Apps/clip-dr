<script setup lang="ts">
interface Props {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  disabled: false,
  loading: false,
  icon: false,
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

function handleClick(event: MouseEvent) {
  if (!props.disabled && !props.loading) {
    emit('click', event);
  }
}
</script>

<template>
  <button
    :class="[
      'inline-flex items-center justify-center font-medium transition-colors rounded focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900',
      {
        'bg-waveform-wave text-gray-900 hover:bg-cyan-400 focus:ring-cyan-500': variant === 'primary',
        'bg-gray-700 text-gray-100 hover:bg-gray-600 focus:ring-gray-500': variant === 'secondary',
        'bg-transparent text-gray-300 hover:bg-gray-800 focus:ring-gray-600': variant === 'ghost',
        'bg-red-600 text-white hover:bg-red-500 focus:ring-red-500': variant === 'danger',
        'px-2 py-1 text-xs': size === 'sm' && !icon,
        'px-3 py-2 text-sm': size === 'md' && !icon,
        'px-4 py-2.5 text-base': size === 'lg' && !icon,
        'p-1': size === 'sm' && icon,
        'p-2': size === 'md' && icon,
        'p-3': size === 'lg' && icon,
        'opacity-50 cursor-not-allowed': disabled || loading,
      },
    ]"
    :disabled="disabled || loading"
    @click="handleClick"
  >
    <svg
      v-if="loading"
      class="animate-spin -ml-1 mr-2 h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
    <slot />
  </button>
</template>
