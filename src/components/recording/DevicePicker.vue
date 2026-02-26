<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import DeviceMeter from './DeviceMeter.vue';
import { useRecordingStore } from '@/stores/recording';

const emit = defineEmits<{
  select: [deviceId: string];
}>();

const recordingStore = useRecordingStore();

// Group input devices
const micDevices = computed(() => recordingStore.microphoneDevices);
const loopbackDev = computed(() => recordingStore.loopbackDevices);

// Track which device is hovered for preview
const hoveredDeviceId = ref<string | null>(null);
let hoverTimeout: number | null = null;

function handleDeviceClick(deviceId: string) {
  recordingStore.selectDevice(deviceId);
  emit('select', deviceId);
}

function handleDeviceHover(deviceId: string) {
  hoveredDeviceId.value = deviceId;
  // Debounce preview start to avoid rapid stream creation
  if (hoverTimeout) clearTimeout(hoverTimeout);
  hoverTimeout = window.setTimeout(() => {
    if (hoveredDeviceId.value === deviceId) {
      recordingStore.startDevicePreview(deviceId);
    }
  }, 300);
}

function handleDeviceLeave() {
  hoveredDeviceId.value = null;
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  recordingStore.stopDevicePreview();
}

// Load all devices when picker mounts
onMounted(() => {
  recordingStore.refreshAllDevices();
});

// Cleanup preview on unmount
onUnmounted(() => {
  if (hoverTimeout) clearTimeout(hoverTimeout);
  recordingStore.stopDevicePreview();
});

function formatChannels(ch: number): string {
  if (ch === 1) return 'Mono';
  if (ch === 2) return 'Stereo';
  return `${ch}ch`;
}
</script>

<template>
  <div class="space-y-1">
    <!-- Microphones group -->
    <div v-if="micDevices.length > 0">
      <div class="flex items-center gap-1.5 px-1 py-1">
        <svg class="w-3 h-3 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
        <span class="text-[10px] font-medium text-cyan-400 uppercase tracking-wide">Microphones</span>
      </div>
      <div class="space-y-0.5">
        <button
          v-for="device in micDevices"
          :key="device.id"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
          :class="[
            recordingStore.selectedDeviceId === device.id
              ? 'bg-cyan-500/15 border border-cyan-500/40'
              : 'hover:bg-gray-700/60 border border-transparent',
          ]"
          @click="handleDeviceClick(device.id)"
          @mouseenter="handleDeviceHover(device.id)"
          @mouseleave="handleDeviceLeave"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-gray-200 truncate">{{ device.name }}</span>
              <span v-if="device.is_default" class="text-[9px] text-cyan-500/70 shrink-0">default</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-[9px] text-gray-500">{{ formatChannels(device.channels) }}</span>
              <span v-if="device.sample_rates.length > 0" class="text-[9px] text-gray-500">
                {{ device.sample_rates.includes(48000) ? '48k' : device.sample_rates.includes(44100) ? '44.1k' : `${(device.sample_rates[0] / 1000).toFixed(1)}k` }}
              </span>
            </div>
          </div>
          <!-- VU meter shown when this device is being previewed -->
          <DeviceMeter
            v-if="recordingStore.previewDeviceId === device.id"
            :level="recordingStore.previewLevel"
          />
        </button>
      </div>
    </div>

    <!-- System Audio / Loopback group -->
    <div v-if="loopbackDev.length > 0">
      <div class="flex items-center gap-1.5 px-1 py-1 mt-1">
        <svg class="w-3 h-3 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <span class="text-[10px] font-medium text-purple-400 uppercase tracking-wide">System Audio</span>
      </div>
      <div class="space-y-0.5">
        <button
          v-for="device in loopbackDev"
          :key="device.id"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
          :class="[
            recordingStore.selectedDeviceId === device.id
              ? 'bg-purple-500/15 border border-purple-500/40'
              : 'hover:bg-gray-700/60 border border-transparent',
          ]"
          @click="handleDeviceClick(device.id)"
          @mouseenter="handleDeviceHover(device.id)"
          @mouseleave="handleDeviceLeave"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-gray-200 truncate">{{ device.name }}</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-[9px] text-gray-500">{{ formatChannels(device.channels) }}</span>
            </div>
          </div>
          <DeviceMeter
            v-if="recordingStore.previewDeviceId === device.id"
            :level="recordingStore.previewLevel"
          />
        </button>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="micDevices.length === 0 && loopbackDev.length === 0" class="py-4 text-center">
      <span class="text-xs text-gray-500">No audio devices found</span>
    </div>
  </div>
</template>
