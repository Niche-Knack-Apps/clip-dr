<script setup lang="ts">
import { ref, nextTick, computed } from 'vue';
import type { Word } from '@/shared/types';
import { hexToRgba, lightenHex } from '@/shared/utils';

interface Props {
  word: Word;
  isActive?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
  trackColor?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isActive: false,
  isHighlighted: false,
  isDragging: false,
  trackColor: '#00d4ff',
});

const wordStyle = computed(() => {
  if (isEditing.value) return {};
  const color = props.trackColor;
  if (props.isDragging) {
    return {
      backgroundColor: hexToRgba(color, 0.3),
      color: lightenHex(color),
      boxShadow: `inset 0 0 0 1px ${color}`,
    };
  }
  if (props.isActive) {
    return {
      backgroundColor: hexToRgba(color, 0.2),
      color: lightenHex(color),
    };
  }
  if (props.isHighlighted) {
    return {}; // keep yellow highlight styling from classes
  }
  return {};
});

const emit = defineEmits<{
  click: [word: Word];
  updateText: [wordId: string, newText: string];
}>();

const isEditing = ref(false);
const editText = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

function handleDoubleClick(event: MouseEvent) {
  event.stopPropagation();
  event.preventDefault();
  startEditing();
}

function startEditing() {
  isEditing.value = true;
  editText.value = props.word.text;
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function commitEdit() {
  const trimmed = editText.value.trim();
  if (trimmed && trimmed !== props.word.text) {
    emit('updateText', props.word.id, trimmed);
  }
  isEditing.value = false;
}

function cancelEdit() {
  isEditing.value = false;
  editText.value = props.word.text;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitEdit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEdit();
  }
}

function handleBlur() {
  commitEdit();
}
</script>

<template>
  <div
    :class="[
      'px-1 py-0.5 text-xs font-mono rounded transition-colors select-none',
      {
        'bg-yellow-500/30 text-yellow-300': isHighlighted && !isActive && !isDragging && !isEditing,
        'text-gray-400 hover:text-gray-200 hover:bg-gray-700': !isActive && !isHighlighted && !isDragging && !isEditing,
        'ring-1 ring-cyan-500 bg-gray-800': isEditing,
      },
    ]"
    :style="wordStyle"
    @click="!isEditing && emit('click', word)"
    @dblclick="handleDoubleClick"
  >
    <input
      v-if="isEditing"
      ref="inputRef"
      v-model="editText"
      type="text"
      class="bg-transparent border-none outline-none w-full text-xs font-mono text-cyan-200 p-0 m-0"
      :style="{ minWidth: '30px', width: `${Math.max(editText.length, 3)}ch` }"
      @keydown="handleKeydown"
      @blur="handleBlur"
      @click.stop
      @mousedown.stop
    />
    <span v-else>{{ word.text }}</span>
  </div>
</template>
