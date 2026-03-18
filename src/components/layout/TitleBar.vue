<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

function minimize() {
  appWindow.minimize();
}

function toggleMaximize() {
  appWindow.toggleMaximize();
}

function close() {
  appWindow.close();
}
</script>

<template>
  <div
    class="h-9 bg-gray-900 flex items-center justify-between px-2 select-none shrink-0"
    style="-webkit-app-region: drag"
  >
    <!-- Left: icon + title -->
    <div class="flex items-center gap-2">
      <svg class="text-cyan-400" style="width: 30px; height: 30px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 20L14.5 9.5C15.5 8.5 17 8 18.5 8.5L20 4L15.5 5.5C15 7 14.5 8.5 13.5 9.5L3 20" />
        <path d="M4 20C4 20 6 18 7 17" stroke-linecap="round" />
      </svg>
      <span class="text-sm font-medium text-gray-400">Clip Dr.</span>
    </div>

    <!-- Right: window controls -->
    <div class="flex items-center" style="-webkit-app-region: no-drag">
      <button
        class="w-8 h-8 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors rounded-sm"
        title="Minimize"
        @click="minimize"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="w-8 h-8 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors rounded-sm"
        title="Maximize"
        @click="toggleMaximize"
      >
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="4" y="4" width="16" height="16" rx="1" />
        </svg>
      </button>
      <button
        class="w-8 h-8 flex items-center justify-center text-gray-400 hover:bg-red-600 hover:text-white transition-colors rounded-sm"
        title="Close"
        @click="close"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M6 6l12 12M6 18L18 6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>
