<script setup lang="ts">
import { ref, provide } from 'vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import SettingsView from '@/views/SettingsView.vue';
import EditorView from '@/views/EditorView.vue';
import FloatingMeter from '@/components/ui/FloatingMeter.vue';

const showSettings = ref(false);

function openSettings() {
  showSettings.value = true;
}

provide('openSettings', openSettings);
</script>

<template>
  <AppLayout @open-settings="showSettings = true">
    <EditorView />
  </AppLayout>

  <SettingsView
    v-if="showSettings"
    @close="showSettings = false"
  />

  <FloatingMeter />
</template>
