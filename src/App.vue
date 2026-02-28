<script setup lang="ts">
import { ref, provide, computed } from 'vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import SettingsView from '@/views/SettingsView.vue';
import EditorView from '@/views/EditorView.vue';
import FloatingMeter from '@/components/ui/FloatingMeter.vue';
import { useSettingsStore } from '@/stores/settings';

const settingsStore = useSettingsStore();
const showSettings = ref(false);

function openSettings() {
  showSettings.value = true;
}

provide('openSettings', openSettings);

const missingDeps = computed(() => {
  if (settingsStore.systemDepsWarningDismissed) return [];
  return settingsStore.systemDeps?.missing ?? [];
});
</script>

<template>
  <!-- System dependency warning banner -->
  <Teleport to="body">
    <div
      v-if="missingDeps.length > 0"
      class="fixed top-0 left-0 right-0 z-50 bg-amber-900/95 border-b border-amber-600/50 px-4 py-2.5 text-sm"
    >
      <div class="flex items-start gap-3 max-w-4xl mx-auto">
        <svg class="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div class="flex-1 min-w-0">
          <p class="text-amber-200 font-medium">Missing system dependencies</p>
          <div v-for="dep in missingDeps" :key="dep.name" class="mt-1">
            <p class="text-amber-300/80">
              <span class="font-mono text-amber-200">{{ dep.name }}</span> — {{ dep.reason }}
            </p>
            <pre class="text-[11px] text-amber-400/70 mt-0.5 whitespace-pre-wrap">{{ dep.install_hint }}</pre>
          </div>
        </div>
        <button
          class="text-amber-400/60 hover:text-amber-300 shrink-0 p-1"
          title="Dismiss"
          @click="settingsStore.dismissSystemDepsWarning()"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  </Teleport>

  <AppLayout @open-settings="showSettings = true">
    <EditorView />
  </AppLayout>

  <SettingsView
    v-if="showSettings"
    @close="showSettings = false"
  />

  <FloatingMeter />
</template>
