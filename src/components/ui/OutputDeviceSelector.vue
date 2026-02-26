<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { usePlaybackStore } from '@/stores/playback';
import { useRecordingStore } from '@/stores/recording';

const playbackStore = usePlaybackStore();
const recordingStore = useRecordingStore();

const outputDevices = computed(() => recordingStore.outputDevices);
const selectedId = computed(() => playbackStore.outputDeviceId);

function handleChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  const value = select.value || null;
  playbackStore.setOutputDevice(value);
}

// Ensure output devices are enumerated
onMounted(() => {
  if (recordingStore.allDevices.length === 0) {
    recordingStore.refreshAllDevices();
  }
});
</script>

<template>
  <div v-if="outputDevices.length > 1" class="flex items-center gap-1.5">
    <svg class="w-3 h-3 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
    </svg>
    <select
      class="bg-gray-800 border border-gray-700 text-gray-300 text-[10px] rounded px-1.5 py-0.5 focus:outline-none focus:border-cyan-500 max-w-[140px] truncate"
      :value="selectedId || ''"
      @change="handleChange"
    >
      <option value="">System Default</option>
      <option
        v-for="device in outputDevices"
        :key="device.id"
        :value="device.id"
      >
        {{ device.name }}
      </option>
    </select>
  </div>
</template>
