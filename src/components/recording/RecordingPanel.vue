<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import Button from '@/components/ui/Button.vue';
import LevelMeter from './LevelMeter.vue';
import LiveWaveform from '@/components/waveform/LiveWaveform.vue';
import { useRecordingStore, type RecordingSource } from '@/stores/recording';
import { formatTime } from '@/shared/utils';

const HOLD_TO_STOP_DURATION = 1500; // ms

const emit = defineEmits<{
  close: [];
}>();

const recordingStore = useRecordingStore();

// Timemark UI state
const triggerPhrasesInput = ref('');
const showTriggerPhrases = ref(false);
const markFlash = ref(false);

function handleAddMark() {
  recordingStore.addTimemark();
  // Brief flash animation
  markFlash.value = true;
  setTimeout(() => { markFlash.value = false; }, 400);
}

function handleTriggerPhrasesChange() {
  const phrases = triggerPhrasesInput.value
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  recordingStore.setTriggerPhrases(phrases);
}

// Hold-to-stop state
const holdProgress = ref(0);
let holdTimer: number | null = null;
let holdStartTime = 0;
let holdAnimFrame = 0;

const sources: { value: RecordingSource; label: string; icon: string }[] = [
  { value: 'microphone', label: 'Microphone', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
  { value: 'system', label: 'System Audio', icon: 'M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z' },
];

// Auto-start monitoring when device or source changes
watch(
  () => ({ deviceId: recordingStore.selectedDeviceId, source: recordingStore.source }),
  async (newVal, _oldVal) => {
    if (recordingStore.isRecording) return;

    // Stop previous monitoring if running
    if (recordingStore.isMonitoring) {
      await recordingStore.stopMonitoring();
    }

    // Start monitoring for the new source/device
    const isSystemPwRecord = newVal.source === 'system' &&
      recordingStore.systemAudioInfo?.available &&
      !recordingStore.systemAudioInfo?.cpal_monitor_device;

    if (newVal.deviceId || isSystemPwRecord) {
      await recordingStore.startMonitoring();
    }
  },
  { immediate: true }
);

// Stop monitoring when panel closes
onUnmounted(() => {
  if (recordingStore.isMonitoring && !recordingStore.isRecording) {
    recordingStore.stopMonitoring();
  }
  cancelHold();
});

function toggleLock() {
  if (recordingStore.isLocked) {
    recordingStore.unlockRecording();
  } else {
    recordingStore.lockRecording();
  }
}

// Hold-to-stop: animate progress while mouse/pointer is held down
function startHold() {
  if (!recordingStore.isLocked) return;
  holdStartTime = Date.now();
  holdProgress.value = 0;

  function animate() {
    const elapsed = Date.now() - holdStartTime;
    holdProgress.value = Math.min(elapsed / HOLD_TO_STOP_DURATION, 1);
    if (holdProgress.value < 1) {
      holdAnimFrame = requestAnimationFrame(animate);
    }
  }
  holdAnimFrame = requestAnimationFrame(animate);

  holdTimer = window.setTimeout(async () => {
    holdProgress.value = 1;
    await recordingStore.stopRecording();
    emit('close');
    cancelHold();
  }, HOLD_TO_STOP_DURATION);
}

function cancelHold() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (holdAnimFrame) {
    cancelAnimationFrame(holdAnimFrame);
    holdAnimFrame = 0;
  }
  holdProgress.value = 0;
}

async function handleRecord() {
  if (recordingStore.isRecording) {
    if (recordingStore.isLocked) {
      // Hold-to-stop is handled by startHold/cancelHold
      return;
    }
    await recordingStore.stopRecording();
    emit('close');
  } else {
    // Stop monitoring before recording
    if (recordingStore.isMonitoring) {
      await recordingStore.stopMonitoring();
    }
    await recordingStore.startRecording();
  }
}

async function handleCancel() {
  if (recordingStore.isLocked) return;
  await recordingStore.cancelRecording();
  // Restart monitoring after cancel
  await recordingStore.startMonitoring();
}

async function handleDeviceChange(deviceId: string) {
  if (recordingStore.isMonitoring) {
    await recordingStore.stopMonitoring();
  }
  recordingStore.selectDevice(deviceId);
  await recordingStore.startMonitoring();
}

</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[320px] max-h-[calc(100vh-6rem)] overflow-y-auto">
    <h3 class="text-sm font-medium text-gray-200 mb-4">Record Audio</h3>

    <!-- Trigger phrases config (before recording starts) -->
    <div v-if="!recordingStore.isRecording" class="mb-4">
      <button
        class="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300 transition-colors"
        @click="showTriggerPhrases = !showTriggerPhrases"
      >
        <svg
          class="w-3 h-3 transition-transform"
          :class="showTriggerPhrases ? 'rotate-90' : ''"
          fill="currentColor" viewBox="0 0 20 20"
        >
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>
        Auto-mark trigger phrases
      </button>
      <div v-if="showTriggerPhrases" class="mt-2">
        <input
          v-model="triggerPhrasesInput"
          type="text"
          placeholder="e.g. chapter, section, note"
          class="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          @input="handleTriggerPhrasesChange"
        />
        <p class="mt-1 text-[10px] text-gray-500">
          Comma-separated words/phrases. Auto-marks placed when detected in live transcription.
        </p>
      </div>
    </div>

    <!-- Source selection -->
    <div v-if="!recordingStore.isRecording" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Source</label>
      <div class="flex gap-2">
        <button
          v-for="src in sources"
          :key="src.value"
          :disabled="recordingStore.systemAudioProbing"
          :class="[
            'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border transition-colors',
            recordingStore.source === src.value
              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
              : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-gray-500',
            recordingStore.systemAudioProbing ? 'opacity-50 cursor-wait' : ''
          ]"
          @click="recordingStore.setSource(src.value)"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="src.icon" />
          </svg>
          <span class="text-xs">{{ src.label }}</span>
        </button>
      </div>
      <!-- System audio method indicator -->
      <div v-if="recordingStore.source === 'system' && recordingStore.systemAudioInfo" class="mt-2 text-[10px]">
        <span v-if="recordingStore.systemAudioProbing" class="text-gray-500">
          Probing system audio...
        </span>
        <span v-else-if="recordingStore.systemAudioInfo.available" class="text-green-500">
          System audio: {{ recordingStore.systemAudioInfo.method }}
        </span>
        <span v-else class="text-red-400">
          {{ recordingStore.systemAudioInfo.test_result || 'System audio not available' }}
        </span>
      </div>
    </div>

    <!-- Device selection (show for microphone or CPAL-based system audio) -->
    <div v-if="!recordingStore.isRecording && (recordingStore.source === 'microphone' || recordingStore.systemAudioInfo?.cpal_monitor_device)" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Device</label>
      <select
        :value="recordingStore.selectedDeviceId"
        class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-cyan-500"
        @change="handleDeviceChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="device in recordingStore.devices" :key="device.id" :value="device.id">
          {{ device.name }}{{ device.is_default ? ' (Default)' : '' }}{{ device.is_loopback ? ' (System)' : '' }}
        </option>
      </select>
      <div class="flex justify-between items-center mt-2">
        <button
          class="text-xs text-gray-500 hover:text-gray-300"
          @click="recordingStore.refreshDevices()"
        >
          Refresh
        </button>
        <span v-if="recordingStore.isMonitoring" class="text-xs text-green-500">
          Monitoring active
        </span>
      </div>
    </div>

    <!-- System audio via PipeWire (no device selection needed) -->
    <div v-if="!recordingStore.isRecording && recordingStore.source === 'system' && !recordingStore.systemAudioInfo?.cpal_monitor_device && recordingStore.systemAudioInfo?.available" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Audio Source</label>
      <div class="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-gray-300">
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Default Audio Output (PipeWire)</span>
        </div>
      </div>
      <p class="mt-1 text-[10px] text-gray-500">
        Captures all system audio playing through your speakers/headphones.
      </p>
    </div>

    <!-- Pre-recording level meter (show when NOT recording but monitoring) -->
    <div v-if="!recordingStore.isRecording && recordingStore.isMonitoring" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Input Level</label>
      <LevelMeter :level="recordingStore.currentLevel" />
    </div>

    <!-- Recording status -->
    <div v-if="recordingStore.isRecording" class="mb-4">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
        <span class="text-sm text-gray-200 font-mono">
          {{ formatTime(recordingStore.recordingDuration) }}
        </span>

        <!-- Lock toggle button -->
        <button
          :class="[
            'ml-auto flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-all',
            recordingStore.isLocked
              ? 'border-amber-500 bg-amber-500/15 text-amber-400 recording-lock-pulse'
              : 'border-gray-600 bg-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
          ]"
          :title="recordingStore.isLocked ? 'Unlock recording (click stop freely)' : 'Lock recording (prevent accidental stop)'"
          @click="toggleLock"
        >
          <!-- Locked padlock -->
          <svg v-if="recordingStore.isLocked" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <!-- Unlocked padlock -->
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
          </svg>
          {{ recordingStore.isLocked ? 'Locked' : 'Lock' }}
        </button>
      </div>

      <!-- Live waveform -->
      <div class="mb-3">
        <LiveWaveform :height="60" />
      </div>

      <!-- Timemark controls -->
      <div class="mb-3 flex items-center gap-2">
        <button
          :class="[
            'flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium transition-all',
            markFlash
              ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300 mark-flash'
              : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-cyan-500 hover:text-cyan-400'
          ]"
          title="Add timemark (M)"
          @click="handleAddMark"
        >
          <!-- Flag/bookmark icon -->
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          Mark
        </button>
        <span v-if="recordingStore.timemarks.length > 0" class="text-[10px] text-gray-400">
          {{ recordingStore.timemarks.length }} mark{{ recordingStore.timemarks.length !== 1 ? 's' : '' }}
        </span>
      </div>

      <!-- Recent timemarks list (last 5) -->
      <div v-if="recordingStore.timemarks.length > 0" class="mb-3 max-h-[80px] overflow-y-auto">
        <div
          v-for="mark in recordingStore.timemarks.slice(-5).reverse()"
          :key="mark.id"
          class="flex items-center gap-2 text-[10px] py-0.5 group/mark"
        >
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0"
            :style="{ backgroundColor: mark.color || (mark.source === 'manual' ? '#00d4ff' : '#fbbf24') }"
          />
          <span class="text-gray-400 font-mono">{{ formatTime(mark.time) }}</span>
          <span class="text-gray-300 truncate flex-1">{{ mark.label }}</span>
          <span v-if="mark.source === 'auto'" class="text-amber-500/70 text-[9px]">auto</span>
          <button
            class="text-gray-600 hover:text-red-400 opacity-0 group-hover/mark:opacity-100 transition-opacity shrink-0"
            title="Remove mark"
            @click.stop="recordingStore.removeTimemark(mark.id)"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Level meter -->
      <LevelMeter :level="recordingStore.currentLevel" />
    </div>

    <!-- Error display -->
    <div v-if="recordingStore.error" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ recordingStore.error }}
    </div>

    <!-- Action buttons -->
    <div class="flex gap-2">
      <!-- Cancel button -->
      <Button
        v-if="recordingStore.isRecording"
        variant="secondary"
        size="sm"
        class="flex-1 relative"
        :disabled="recordingStore.isLocked"
        @click="handleCancel"
      >
        <!-- Lock overlay on cancel when locked -->
        <svg v-if="recordingStore.isLocked" class="w-3 h-3 mr-1 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        Cancel
      </Button>

      <!-- Stop/Record button -->
      <Button
        v-if="!recordingStore.isRecording || !recordingStore.isLocked"
        variant="primary"
        size="sm"
        class="flex-1"
        :loading="recordingStore.isPreparing"
        @click="handleRecord"
      >
        <svg v-if="!recordingStore.isRecording" class="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="6" />
        </svg>
        <svg v-else class="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
        {{ recordingStore.isRecording ? 'Stop' : 'Record' }}
      </Button>

      <!-- Hold-to-stop button (replaces Stop when locked) -->
      <button
        v-if="recordingStore.isRecording && recordingStore.isLocked"
        class="flex-1 relative inline-flex items-center justify-center font-medium text-xs px-2 py-1 rounded overflow-hidden transition-colors bg-gray-700 text-gray-100 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-gray-500 select-none"
        @mousedown="startHold"
        @mouseup="cancelHold"
        @mouseleave="cancelHold"
        @touchstart.prevent="startHold"
        @touchend.prevent="cancelHold"
        @touchcancel.prevent="cancelHold"
      >
        <!-- Hold progress fill -->
        <div
          class="absolute inset-0 bg-amber-500/30 transition-none"
          :style="{ width: `${holdProgress * 100}%` }"
        />
        <span class="relative flex items-center">
          <svg class="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          {{ holdProgress > 0 ? 'Hold...' : 'Hold to Stop' }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mark-flash {
  animation: mark-flash-anim 0.4s ease-out;
}

@keyframes mark-flash-anim {
  0% {
    background-color: rgb(0 212 255 / 0.3);
    box-shadow: 0 0 12px 0 rgb(0 212 255 / 0.4);
  }
  100% {
    background-color: transparent;
    box-shadow: 0 0 0 0 transparent;
  }
}

.recording-lock-pulse {
  animation: lock-pulse 2s ease-in-out infinite;
}

@keyframes lock-pulse {
  0%, 100% {
    border-color: rgb(245 158 11 / 0.5);
    box-shadow: 0 0 0 0 rgb(245 158 11 / 0.2);
  }
  50% {
    border-color: rgb(245 158 11);
    box-shadow: 0 0 8px 0 rgb(245 158 11 / 0.3);
  }
}
</style>
