<script setup lang="ts">
import { ref } from 'vue';
import { useExportStore } from '@/stores/export';
import { useSettingsStore } from '@/stores/settings';
import type { ExportProfile } from '@/shared/types';

const emit = defineEmits<{
  close: [];
}>();

const exportStore = useExportStore();
const settingsStore = useSettingsStore();

const lastExportedPath = ref<string | null>(null);

const profiles = settingsStore.getExportProfiles();

function formatLabel(profile: ExportProfile): string {
  if (profile.format === 'mp3' && profile.mp3Bitrate) {
    return `${profile.mp3Bitrate} kbps`;
  }
  return profile.format === 'wav' ? 'Lossless' : profile.format.toUpperCase();
}

async function handleProfileClick(profile: ExportProfile) {
  lastExportedPath.value = null;
  const path = await exportStore.exportWithProfile(profile);
  if (path) {
    lastExportedPath.value = path;
    setTimeout(() => {
      emit('close');
    }, 1500);
  }
}

function toggleFavorite(event: Event, profile: ExportProfile) {
  event.stopPropagation();
  settingsStore.setFavoriteProfile(profile.id);
}
</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[280px]">
    <h3 class="text-sm font-medium text-gray-200 mb-3">Export Audio</h3>

    <!-- Active tracks info -->
    <div class="mb-3">
      <span class="text-xs text-gray-400">
        Active Tracks ({{ exportStore.activeTracks.length }}):
        {{ exportStore.activeTracks.map(t => t.name).join(', ') || 'None' }}
      </span>
    </div>

    <!-- Profile cards -->
    <div class="flex flex-wrap gap-2 mb-3">
      <button
        v-for="profile in profiles"
        :key="profile.id"
        :disabled="!exportStore.canExport || exportStore.loading"
        class="relative flex flex-col items-center justify-center w-[88px] h-[64px] rounded-lg border transition-all
               border-gray-600 bg-gray-700 text-gray-200 hover:border-cyan-500 hover:bg-gray-600
               disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-gray-600 disabled:hover:bg-gray-700"
        @click="handleProfileClick(profile)"
      >
        <span class="text-xs font-medium">{{ profile.format.toUpperCase() }}</span>
        <span class="text-[10px] text-gray-400">{{ formatLabel(profile) }}</span>
        <!-- Favorite star -->
        <button
          class="absolute top-1 right-1 text-[10px] leading-none p-0.5 rounded hover:bg-gray-500/50"
          :class="profile.isFavorite ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300'"
          :title="profile.isFavorite ? 'Default for Quick Re-Export' : 'Set as Quick Re-Export default'"
          @click="toggleFavorite($event, profile)"
        >
          {{ profile.isFavorite ? '\u2605' : '\u2606' }}
        </button>
      </button>
    </div>

    <!-- Error display -->
    <div v-if="exportStore.error" class="mb-3 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ exportStore.error }}
    </div>

    <!-- Success message -->
    <div v-if="lastExportedPath" class="mb-3 p-2 bg-green-900/30 border border-green-700 rounded text-xs text-green-400">
      Exported to: {{ lastExportedPath }}
    </div>

    <!-- Loading indicator -->
    <div v-if="exportStore.loading" class="mb-3">
      <div class="w-full h-1 bg-gray-700 rounded overflow-hidden">
        <div class="h-full bg-cyan-500 transition-all" :style="{ width: `${exportStore.progress}%` }" />
      </div>
    </div>

    <p class="text-[10px] text-gray-500 text-center">
      Click a profile to export. <span class="text-yellow-400/70">\u2605</span> = default for Quick Re-Export (Ctrl+Shift+E)
    </p>
  </div>
</template>
