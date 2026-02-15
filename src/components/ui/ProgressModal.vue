<script setup lang="ts">
import ProgressBar from '@/components/ui/ProgressBar.vue';

interface Props {
  visible: boolean;
  title: string;
  progress: number;
  subtitle?: string;
}

defineProps<Props>();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 flex items-end justify-center z-50 p-4 pointer-events-none"
    >
      <div class="bg-gray-900 rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4 pointer-events-auto mb-12">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-medium text-gray-100">{{ title }}</h2>
          <span class="text-sm text-gray-400">{{ Math.round(progress) }}%</span>
        </div>
        <ProgressBar :value="progress" size="lg" />
        <p v-if="subtitle" class="text-sm text-gray-400 truncate">{{ subtitle }}</p>
      </div>
    </div>
  </Teleport>
</template>
