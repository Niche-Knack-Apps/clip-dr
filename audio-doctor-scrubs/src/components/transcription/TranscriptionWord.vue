<script setup lang="ts">
import type { Word } from '@/shared/types';

interface Props {
  word: Word;
  isActive?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isActive: false,
  isHighlighted: false,
  isDragging: false,
});

const emit = defineEmits<{
  click: [word: Word];
}>();
</script>

<template>
  <div
    :class="[
      'px-1 py-0.5 text-xs font-mono rounded transition-colors select-none',
      {
        'bg-cyan-600/50 text-cyan-200 ring-1 ring-cyan-400': isDragging,
        'bg-waveform-wave/30 text-cyan-300': isActive && !isDragging,
        'bg-yellow-500/30 text-yellow-300': isHighlighted && !isActive && !isDragging,
        'text-gray-400 hover:text-gray-200 hover:bg-gray-700': !isActive && !isHighlighted && !isDragging,
      },
    ]"
    @click="emit('click', word)"
  >
    {{ word.text }}
  </div>
</template>
