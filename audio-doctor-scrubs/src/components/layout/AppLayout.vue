<script setup lang="ts">
import { ref, provide, onMounted, onUnmounted } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import AppToolbar from './AppToolbar.vue';
import { TOOLBAR_HEIGHT, SUPPORTED_FORMATS } from '@/shared/constants';
import { useAudioStore } from '@/stores/audio';
import { useSettingsStore } from '@/stores/settings';

const emit = defineEmits<{
  openSettings: [];
}>();

const audioStore = useAudioStore();
const settingsStore = useSettingsStore();
const toolbarRef = ref<InstanceType<typeof AppToolbar> | null>(null);
const isDragging = ref(false);

let unlistenDrop: (() => void) | null = null;

function focusSearch() {
  toolbarRef.value?.focusSearch();
}

provide('focusSearch', focusSearch);

onMounted(async () => {
  try {
    const webview = getCurrentWebview();
    unlistenDrop = await webview.onDragDropEvent(async (event) => {
      if (event.payload.type === 'over') {
        isDragging.value = true;
      } else if (event.payload.type === 'drop') {
        isDragging.value = false;
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          // Find first audio file
          for (const path of paths) {
            const ext = '.' + path.split('.').pop()?.toLowerCase();
            if (SUPPORTED_FORMATS.includes(ext)) {
              settingsStore.setLastImportFolder(path);
              await audioStore.loadFile(path);
              return;
            }
          }
        }
      } else if (event.payload.type === 'leave' || event.payload.type === 'cancel') {
        isDragging.value = false;
      }
    });
  } catch (e) {
    console.error('Failed to set up drag drop listener:', e);
  }
});

onUnmounted(() => {
  if (unlistenDrop) {
    unlistenDrop();
  }
});
</script>

<template>
  <div class="h-screen flex flex-col bg-gray-950 text-gray-100 relative">
    <AppToolbar
      ref="toolbarRef"
      @open-settings="emit('openSettings')"
    />

    <main
      class="flex-1 overflow-hidden"
      :style="{ height: `calc(100vh - ${TOOLBAR_HEIGHT}px)` }"
    >
      <slot />
    </main>

    <!-- Drag overlay -->
    <div
      v-if="isDragging"
      class="absolute inset-0 bg-cyan-500/20 border-4 border-dashed border-cyan-400 flex items-center justify-center z-50 pointer-events-none"
    >
      <div class="bg-gray-900 px-6 py-4 rounded-lg shadow-xl">
        <p class="text-lg font-medium text-cyan-400">Drop audio file here</p>
      </div>
    </div>
  </div>
</template>
