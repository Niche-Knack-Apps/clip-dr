<script setup lang="ts">
import { ref, computed } from 'vue';
import Button from '@/components/ui/Button.vue';
import { useExportStore, type Mp3Bitrate } from '@/stores/export';
import type { ExportFormat } from '@/shared/types';

const emit = defineEmits<{
  close: [];
}>();

const exportStore = useExportStore();

const selectedFormat = ref<ExportFormat>('wav');
const lastExportedPath = ref<string | null>(null);

const showBitrateOptions = computed(() => selectedFormat.value === 'mp3');

const formats: { value: ExportFormat; label: string; description: string }[] = [
  { value: 'wav', label: 'WAV', description: 'Uncompressed, highest quality' },
  { value: 'flac', label: 'FLAC', description: 'Lossless compression' },
  { value: 'mp3', label: 'MP3', description: 'Compressed, widely compatible' },
  { value: 'ogg', label: 'OGG', description: 'Compressed, open format' },
];

const bitrates: { value: Mp3Bitrate; label: string }[] = [
  { value: 128, label: '128 kbps' },
  { value: 192, label: '192 kbps' },
  { value: 256, label: '256 kbps' },
  { value: 320, label: '320 kbps' },
];

async function handleExport() {
  lastExportedPath.value = null;
  const path = await exportStore.exportActiveTracks(selectedFormat.value);
  if (path) {
    lastExportedPath.value = path;
    // Close panel after short delay to show success
    setTimeout(() => {
      emit('close');
    }, 1500);
  }
}
</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[280px]">
    <h3 class="text-sm font-medium text-gray-200 mb-4">Export Audio</h3>

    <!-- Active tracks info -->
    <div class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Active Tracks ({{ exportStore.activeTracks.length }})</label>
      <div v-if="exportStore.activeTracks.length === 0" class="text-xs text-gray-500 italic">
        No active tracks to export
      </div>
      <div v-else class="space-y-1 max-h-24 overflow-y-auto">
        <div
          v-for="track in exportStore.activeTracks"
          :key="track.id"
          class="text-xs py-1 px-2 bg-gray-700 rounded text-gray-300"
        >
          {{ track.name }}
        </div>
      </div>
    </div>

    <!-- Format selection -->
    <div class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Format</label>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="format in formats"
          :key="format.value"
          :class="[
            'px-3 py-2 text-left rounded border transition-colors',
            selectedFormat === format.value
              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
              : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-gray-500'
          ]"
          @click="selectedFormat = format.value"
        >
          <div class="text-sm font-medium">{{ format.label }}</div>
          <div class="text-[10px] text-gray-500">{{ format.description }}</div>
        </button>
      </div>
    </div>

    <!-- MP3 Bitrate selection -->
    <div v-if="showBitrateOptions" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Bitrate</label>
      <div class="flex gap-2">
        <button
          v-for="bitrate in bitrates"
          :key="bitrate.value"
          :class="[
            'flex-1 px-2 py-1.5 text-xs rounded border transition-colors',
            exportStore.mp3Bitrate === bitrate.value
              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
              : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-gray-500'
          ]"
          @click="exportStore.setMp3Bitrate(bitrate.value)"
        >
          {{ bitrate.label }}
        </button>
      </div>
    </div>

    <!-- Error display -->
    <div v-if="exportStore.error" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ exportStore.error }}
    </div>

    <!-- Success message -->
    <div v-if="lastExportedPath" class="mb-4 p-2 bg-green-900/30 border border-green-700 rounded text-xs text-green-400">
      Exported to: {{ lastExportedPath }}
    </div>

    <!-- Export button -->
    <Button
      variant="primary"
      class="w-full"
      :disabled="!exportStore.canExport"
      :loading="exportStore.loading"
      @click="handleExport"
    >
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      Export
    </Button>
  </div>
</template>
