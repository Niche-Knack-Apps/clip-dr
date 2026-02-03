<script setup lang="ts">
import { watch, onUnmounted } from 'vue';
import Button from '@/components/ui/Button.vue';
import Toggle from '@/components/ui/Toggle.vue';
import LevelMeter from './LevelMeter.vue';
import LiveWaveform from '@/components/waveform/LiveWaveform.vue';
import { useRecordingStore, type RecordingSource } from '@/stores/recording';
import { formatTime } from '@/shared/utils';

const emit = defineEmits<{
  close: [];
}>();

const recordingStore = useRecordingStore();

const sources: { value: RecordingSource; label: string; icon: string }[] = [
  { value: 'microphone', label: 'Microphone', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
  { value: 'system', label: 'System Audio', icon: 'M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z' },
];

// Auto-start monitoring when device is selected
watch(
  () => recordingStore.selectedDeviceId,
  async (newId, oldId) => {
    if (newId && !recordingStore.isRecording) {
      // Stop previous monitoring if running
      if (recordingStore.isMonitoring) {
        await recordingStore.stopMonitoring();
      }
      // Start monitoring new device
      await recordingStore.startMonitoring();
    }
  }
);

// Start monitoring when panel opens if device is selected
watch(
  () => recordingStore.selectedDeviceId,
  async (deviceId) => {
    if (deviceId && !recordingStore.isRecording && !recordingStore.isMonitoring) {
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
});

async function handleRecord() {
  if (recordingStore.isRecording) {
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

async function handleUnmute() {
  const success = await recordingStore.unmute();
  if (success) {
    // Re-check mute status and restart monitoring to pick up the change
    await recordingStore.checkMuted();
  }
}

async function handleTestDevice() {
  const result = await recordingStore.testDevice();
  if (result) {
    const workingCount = result.working_configs.length;
    const hasSignal = result.working_configs.some(c => c.has_signal);
    alert(`Device: ${result.device_name}\nWorking configs: ${workingCount}\nHas signal: ${hasSignal ? 'YES' : 'NO'}\n\nConfigs:\n${result.working_configs.map(c => `  ${c.channels}ch ${c.sample_format} @ ${c.sample_rate}Hz ${c.has_signal ? '(signal)' : ''}`).join('\n')}\n\nErrors:\n${result.errors.join('\n') || 'None'}`);
  }
}

async function handleResetState() {
  await recordingStore.resetRecordingState();
}
</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[320px]">
    <h3 class="text-sm font-medium text-gray-200 mb-4">Record Audio</h3>

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
          <span v-if="recordingStore.systemAudioInfo.method === 'cpal-monitor'" class="text-gray-500">
            (levels + live transcription)
          </span>
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
        <div class="flex gap-2">
          <button
            class="text-xs text-gray-500 hover:text-gray-300"
            @click="recordingStore.refreshDevices()"
          >
            Refresh
          </button>
          <button
            class="text-xs text-cyan-500 hover:text-cyan-300"
            @click="handleTestDevice"
          >
            Test Device
          </button>
          <button
            class="text-xs text-yellow-500 hover:text-yellow-300"
            @click="handleResetState"
          >
            Reset
          </button>
        </div>
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
        Will capture all system audio playing through your speakers/headphones.
        Level meter will show during recording.
      </p>
      <div class="flex gap-2 mt-2">
        <button
          class="text-xs text-yellow-500 hover:text-yellow-300"
          @click="handleResetState"
        >
          Reset
        </button>
      </div>
    </div>

    <!-- Pre-recording level meter (show when NOT recording but monitoring - only for CPAL devices) -->
    <div v-if="!recordingStore.isRecording && recordingStore.isMonitoring" class="mb-4">
      <label class="block text-xs text-gray-400 mb-2">Input Level</label>
      <LevelMeter :level="recordingStore.currentLevel" />
      <p class="mt-1 text-xs text-gray-500">
        Make sure you see activity above when speaking/playing audio
      </p>
    </div>

    <!-- Info for system audio via subprocess (no pre-recording level meter) -->
    <div v-if="!recordingStore.isRecording && recordingStore.source === 'system' && !recordingStore.systemAudioInfo?.cpal_monitor_device && recordingStore.systemAudioInfo?.available && !recordingStore.isMonitoring" class="mb-4">
      <div class="p-2 bg-blue-900/20 border border-blue-700/50 rounded">
        <p class="text-xs text-blue-400">
          Level meter will appear once recording starts.
        </p>
      </div>
    </div>

    <!-- Muted warning with unmute button -->
    <div v-if="!recordingStore.isRecording && recordingStore.isMuted" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded">
      <div class="flex items-center justify-between">
        <p class="text-xs text-red-400">
          Microphone is muted in system settings.
        </p>
        <button
          class="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded"
          @click="handleUnmute"
        >
          Unmute
        </button>
      </div>
    </div>

    <!-- No signal warning (when not muted) -->
    <div v-else-if="!recordingStore.isRecording && recordingStore.isMonitoring && recordingStore.currentLevel < 0.01" class="mb-4 p-2 bg-yellow-900/30 border border-yellow-700 rounded">
      <p class="text-xs text-yellow-400">
        No signal detected. Check that the correct input device is selected and not muted.
      </p>
    </div>

    <!-- Live transcription toggle (before recording starts) -->
    <div v-if="!recordingStore.isRecording" class="mb-4">
      <Toggle
        :model-value="recordingStore.enableLiveTranscription"
        :disabled="!recordingStore.liveTranscriptionAvailable"
        label="Live transcription"
        @update:model-value="recordingStore.setEnableLiveTranscription"
      />
      <p class="text-[10px] text-gray-500 mt-1 ml-7">
        <template v-if="recordingStore.liveTranscriptionAvailable">
          Transcribe audio in real-time during recording
        </template>
        <template v-else>
          No whisper model found. Configure in Settings.
        </template>
      </p>
    </div>

    <!-- Recording status -->
    <div v-if="recordingStore.isRecording" class="mb-4">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
        <span class="text-sm text-gray-200 font-mono">
          {{ formatTime(recordingStore.recordingDuration) }}
        </span>
        <span v-if="recordingStore.liveTranscription.isActive" class="text-[10px] text-cyan-400">
          Transcribing...
        </span>
      </div>

      <!-- Live waveform -->
      <div class="mb-3">
        <LiveWaveform :height="60" />
      </div>

      <!-- Level meter -->
      <LevelMeter :level="recordingStore.currentLevel" />

      <!-- Live transcription display -->
      <div
        v-if="recordingStore.liveTranscription.isActive || recordingStore.liveTranscription.words.length > 0"
        class="mt-3"
      >
        <label class="block text-[10px] text-gray-500 mb-1">Live Transcription</label>
        <div class="text-sm text-gray-300 bg-gray-900 p-2 rounded max-h-24 overflow-y-auto">
          <span
            v-for="word in recordingStore.liveTranscription.words"
            :key="word.id"
            class="mr-1"
          >{{ word.text }}</span>
          <span v-if="recordingStore.liveTranscription.isActive" class="animate-pulse text-cyan-400">|</span>
          <span v-if="recordingStore.liveTranscription.words.length === 0 && recordingStore.liveTranscription.isActive" class="text-gray-500 italic">
            Waiting for speech...
          </span>
        </div>
      </div>
    </div>

    <!-- Error display -->
    <div v-if="recordingStore.error" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ recordingStore.error }}
    </div>

    <!-- Action buttons -->
    <div class="flex gap-2">
      <Button
        v-if="recordingStore.isRecording"
        variant="secondary"
        size="sm"
        class="flex-1"
        @click="handleCancel"
      >
        Cancel
      </Button>

      <Button
        :variant="recordingStore.isRecording ? 'primary' : 'primary'"
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
    </div>
  </div>
</template>
