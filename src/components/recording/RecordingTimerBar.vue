<script setup lang="ts">
import { computed } from 'vue';
import { useRecordingStore } from '@/stores/recording';

const recordingStore = useRecordingStore();

const formattedDuration = computed(() => {
  const d = recordingStore.recordingDuration;
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  const tenths = Math.floor((d % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${tenths}`;
});

function stopAll() {
  if (recordingStore.isLocked) return;
  // Stop all active sessions (works for both device sessions and main recording)
  const activeSessions = recordingStore.sessions.filter(s => s.active);
  for (const session of activeSessions) {
    recordingStore.stopDeviceSession(session.sessionId);
  }
}
</script>

<template>
  <div class="shrink-0 flex items-center gap-4 px-4 h-10 bg-gray-900 border-t-2 border-red-600 rounded-t-lg">
    <!-- Recording indicator -->
    <div class="flex items-center gap-2">
      <span class="relative flex h-3 w-3">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span class="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
      </span>
      <span class="text-red-400 font-bold text-xs tracking-wider">REC</span>
    </div>

    <!-- Duration -->
    <div class="flex-1 text-center">
      <span class="text-white font-mono text-lg tracking-wide">{{ formattedDuration }}</span>
    </div>

    <!-- Stop All button -->
    <button
      class="px-3 py-1 text-xs font-medium rounded bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      :disabled="recordingStore.isLocked || recordingStore.isFinalizing"
      @click="stopAll"
    >
      {{ recordingStore.isFinalizing ? 'Finalizing...' : 'Stop All' }}
    </button>
  </div>
</template>
