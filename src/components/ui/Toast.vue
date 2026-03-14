<script setup lang="ts">
import { useUIStore } from '@/stores/ui';

const uiStore = useUIStore();
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="uiStore.toastMessage"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md px-4 py-2.5 rounded-lg shadow-xl text-sm whitespace-pre-line"
        :class="{
          'bg-gray-800 border border-gray-600 text-gray-100': uiStore.toastType === 'info',
          'bg-amber-900/90 border border-amber-600/50 text-amber-200': uiStore.toastType === 'warn',
          'bg-red-900/90 border border-red-600/50 text-red-200': uiStore.toastType === 'error',
        }"
      >
        {{ uiStore.toastMessage }}
      </div>
    </Transition>
  </Teleport>
</template>
