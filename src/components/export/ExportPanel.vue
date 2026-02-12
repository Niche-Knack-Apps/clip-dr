<script setup lang="ts">
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { useExportStore, type Mp3Bitrate } from '@/stores/export';
import { useSettingsStore } from '@/stores/settings';

const emit = defineEmits<{
  close: [];
}>();

const exportStore = useExportStore();
const settingsStore = useSettingsStore();

const selectedBitrate = ref<Mp3Bitrate>(settingsStore.settings.defaultMp3Bitrate || 192);
const lastExportedPath = ref<string | null>(null);

const bitrates: { value: Mp3Bitrate; label: string }[] = [
  { value: 128, label: '128 kbps' },
  { value: 192, label: '192 kbps' },
  { value: 256, label: '256 kbps' },
  { value: 320, label: '320 kbps' },
];

async function handleExport() {
  lastExportedPath.value = null;

  // Persist bitrate preference and sync to export store
  settingsStore.setDefaultMp3Bitrate(selectedBitrate.value);
  exportStore.setMp3Bitrate(selectedBitrate.value);

  // Opens native save dialog with all format options
  const path = await exportStore.exportMixedTracks();
  if (path) {
    lastExportedPath.value = path;
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

    <!-- MP3 quality (applies when user picks .mp3 in save dialog) -->
    <div class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">MP3 Quality</label>
      <div class="flex gap-2">
        <button
          v-for="bitrate in bitrates"
          :key="bitrate.value"
          :class="[
            'flex-1 px-2 py-1.5 text-xs rounded border transition-colors',
            selectedBitrate === bitrate.value
              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
              : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-gray-500'
          ]"
          @click="selectedBitrate = bitrate.value"
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

    <!-- Export button - opens native save dialog with format picker -->
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
      Save As...
    </Button>

    <p class="text-[10px] text-gray-500 mt-2 text-center">Choose format (MP3, WAV, FLAC, OGG) in the save dialog</p>
  </div>
</template>
