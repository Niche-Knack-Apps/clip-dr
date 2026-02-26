<script setup lang="ts">
import { useRecordingStore } from '@/stores/recording';

const recordingStore = useRecordingStore();

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function handleRecover(path: string) {
  await recordingStore.recoverRecording(path);
}
</script>

<template>
  <div
    v-if="recordingStore.orphanedRecordings.length > 0"
    class="bg-amber-900/30 border border-amber-600/50 rounded-lg p-3 mb-3"
  >
    <div class="flex items-center gap-2 mb-2">
      <svg class="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span class="text-xs font-medium text-amber-300">
        {{ recordingStore.orphanedRecordings.length }} interrupted recording{{ recordingStore.orphanedRecordings.length !== 1 ? 's' : '' }} found
      </span>
      <button
        class="ml-auto text-[10px] text-gray-500 hover:text-gray-400"
        @click="recordingStore.dismissOrphans()"
      >
        Dismiss
      </button>
    </div>

    <div class="space-y-1.5">
      <div
        v-for="orphan in recordingStore.orphanedRecordings"
        :key="orphan.path"
        class="flex items-center gap-2 text-[10px]"
      >
        <div class="flex-1 min-w-0">
          <div class="text-gray-300 truncate" :title="orphan.path">
            {{ orphan.path.split('/').pop() }}
          </div>
          <div class="text-gray-500">
            {{ formatSize(orphan.size_bytes) }} ~ {{ formatDuration(orphan.estimated_duration) }}
          </div>
        </div>
        <button
          class="px-2 py-0.5 bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 rounded text-[10px] transition-colors shrink-0"
          @click="handleRecover(orphan.path)"
        >
          Recover
        </button>
      </div>
    </div>
  </div>
</template>
