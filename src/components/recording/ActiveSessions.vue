<script setup lang="ts">
import DeviceMeter from './DeviceMeter.vue';
import { useRecordingStore } from '@/stores/recording';

const recordingStore = useRecordingStore();

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
</script>

<template>
  <div v-if="recordingStore.sessions.length > 1" class="space-y-1">
    <div class="text-[10px] font-medium text-amber-400 uppercase tracking-wide px-1">
      Active Sessions ({{ recordingStore.sessions.length }})
    </div>
    <div
      v-for="session in recordingStore.sessions"
      :key="session.sessionId"
      class="flex items-center gap-2 px-2 py-1 rounded bg-gray-800/50 border border-gray-700/50"
    >
      <!-- Recording indicator dot -->
      <div class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />

      <div class="flex-1 min-w-0">
        <div class="text-[10px] text-gray-300 truncate">{{ session.deviceName }}</div>
        <div class="text-[9px] text-gray-500">{{ formatTime(session.duration) }}</div>
      </div>

      <!-- Per-session VU meter -->
      <DeviceMeter :level="session.level" />
    </div>
  </div>
</template>
