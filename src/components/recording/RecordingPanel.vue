<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import DeviceMeter from './DeviceMeter.vue';
import MiniWaveform from './MiniWaveform.vue';
import OrphanRecovery from './OrphanRecovery.vue';
import { useRecordingStore } from '@/stores/recording';
import { useSettingsStore } from '@/stores/settings';
import { formatTime } from '@/shared/utils';

const HOLD_TO_STOP_DURATION = 1500; // ms

defineEmits<{
  close: [];
}>();

const recordingStore = useRecordingStore();
const settingsStore = useSettingsStore();

// Timemark UI state
const triggerPhrasesInput = ref('');
const showTriggerPhrases = ref(false);
const markFlash = ref(false);

function handleAddMark() {
  recordingStore.addTimemark();
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

// Per-device hold-to-stop state
const holdStates = ref(new Map<string, { progress: number; timer: number | null; startTime: number; animFrame: number }>());

function sessionIdFor(deviceId: string): string {
  return `rec_${deviceId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50)}`;
}

async function handleRecord(deviceId: string) {
  const sid = sessionIdFor(deviceId);
  await recordingStore.startDeviceSession(deviceId, sid);
}

async function handleStop(deviceId: string) {
  const session = recordingStore.getDeviceSession(deviceId);
  if (!session) return;
  await recordingStore.stopDeviceSession(session.sessionId);
  // Previews for non-recording devices are already running — no need to restart them.
  // Restarting here caused a churn storm (stop_all_previews + sleep + re-open for every stop).
}

/** Restart previews for devices that are not currently recording */
async function refreshPreviews() {
  const ids = recordingStore.devices
    .map(d => d.id)
    .filter(id => !recordingStore.isDeviceRecording(id));
  if (ids.length > 0) {
    await recordingStore.startDevicePreviews(ids);
  }
}

function toggleLock() {
  if (recordingStore.isLocked) {
    recordingStore.unlockRecording();
  } else {
    recordingStore.lockRecording();
  }
}

function startHold(deviceId: string) {
  if (!recordingStore.isLocked) return;
  const state = { progress: 0, timer: null as number | null, startTime: Date.now(), animFrame: 0 };

  function animate() {
    const elapsed = Date.now() - state.startTime;
    state.progress = Math.min(elapsed / HOLD_TO_STOP_DURATION, 1);
    holdStates.value = new Map(holdStates.value.set(deviceId, state));
    if (state.progress < 1) {
      state.animFrame = requestAnimationFrame(animate);
    }
  }
  state.animFrame = requestAnimationFrame(animate);

  state.timer = window.setTimeout(async () => {
    state.progress = 1;
    holdStates.value = new Map(holdStates.value.set(deviceId, state));
    await handleStop(deviceId);
    cancelHold(deviceId);
  }, HOLD_TO_STOP_DURATION);

  holdStates.value = new Map(holdStates.value.set(deviceId, state));
}

function cancelHold(deviceId: string) {
  const state = holdStates.value.get(deviceId);
  if (state) {
    if (state.timer) clearTimeout(state.timer);
    if (state.animFrame) cancelAnimationFrame(state.animFrame);
  }
  holdStates.value.delete(deviceId);
  holdStates.value = new Map(holdStates.value);
}

function getHoldProgress(deviceId: string): number {
  return holdStates.value.get(deviceId)?.progress ?? 0;
}

const anyRecording = computed(() => recordingStore.sessions.some(s => s.active));
const activeSessionCount = computed(() => recordingStore.sessions.filter(s => s.active).length);

// Hide unused devices toggle
const hideUnused = ref(false);

const visibleMicDevices = computed(() => {
  if (!hideUnused.value) return recordingStore.microphoneDevices;
  return recordingStore.microphoneDevices.filter(d =>
    recordingStore.isDeviceRecording(d.id) || recordingStore.getDeviceLevel(d.id) > 0
  );
});

const visibleLoopbackDevices = computed(() => {
  if (!hideUnused.value) return recordingStore.loopbackDevices;
  return recordingStore.loopbackDevices.filter(d =>
    recordingStore.isDeviceRecording(d.id) || recordingStore.getDeviceLevel(d.id) > 0
  );
});

const hiddenCount = computed(() => {
  if (!hideUnused.value) return 0;
  return (recordingStore.microphoneDevices.length - visibleMicDevices.value.length)
    + (recordingStore.loopbackDevices.length - visibleLoopbackDevices.value.length);
});

async function handleStopAll() {
  const activeSessions = recordingStore.sessions.filter(s => s.active);
  for (const session of activeSessions) {
    const sess = recordingStore.getDeviceSession(session.deviceId);
    if (sess) {
      await recordingStore.stopDeviceSession(sess.sessionId);
    }
  }
  // Refresh previews once after all stops are done (not per-stop)
  refreshPreviews();
}

// Start previews for all devices on mount
onMounted(async () => {
  recordingStore.scanOrphanedRecordings();
  await recordingStore.refreshAllDevices();
  const inputDeviceIds = recordingStore.devices.map(d => d.id);
  if (inputDeviceIds.length > 0) {
    await recordingStore.startDevicePreviews(inputDeviceIds);
  }
});

// Stop previews on unmount (unless recording)
onUnmounted(() => {
  if (!anyRecording.value) {
    recordingStore.stopDevicePreviews();
  }
  if (recordingStore.isMonitoring && !recordingStore.isRecording) {
    recordingStore.stopMonitoring();
  }
  for (const [deviceId] of holdStates.value) {
    cancelHold(deviceId);
  }
});
</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[320px] max-h-[calc(100vh-6rem)] overflow-y-auto">
    <div class="flex items-center gap-2 mb-3">
      <h3 class="text-sm font-medium text-gray-200">Record Audio</h3>
      <div class="ml-auto flex items-center gap-2">
        <!-- Stop All button (when 2+ sources recording) -->
        <button
          v-if="activeSessionCount > 1"
          class="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/80 hover:bg-red-600 text-white text-[10px] font-medium transition-colors"
          @click="handleStopAll"
        >
          <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          Stop All
        </button>
        <!-- Hide unused toggle -->
        <button
          class="flex items-center gap-1 text-[10px] transition-colors"
          :class="hideUnused ? 'text-cyan-400' : 'text-gray-500 hover:text-gray-400'"
          @click="hideUnused = !hideUnused"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path v-if="!hideUnused" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path v-if="!hideUnused" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            <path v-if="hideUnused" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
          </svg>
          <span v-if="hideUnused && hiddenCount > 0">{{ hiddenCount }} hidden</span>
          <span v-else-if="hideUnused">Hide unused</span>
          <span v-else>Hide unused</span>
        </button>
      </div>
    </div>

    <!-- Orphaned recording recovery banner -->
    <OrphanRecovery />

    <!-- ========== Microphones Section ========== -->
    <div v-if="recordingStore.microphoneDevices.length > 0" class="mb-3">
      <div class="flex items-center gap-1.5 px-1 mb-1.5">
        <svg class="w-3 h-3 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
        <span class="text-[10px] font-medium text-cyan-400 uppercase tracking-wide">Microphones</span>
      </div>
      <div class="space-y-1">
        <div
          v-for="device in visibleMicDevices"
          :key="device.id"
          :class="[
            'rounded-lg border px-3 py-2 transition-colors',
            recordingStore.isDeviceRecording(device.id) ? 'border-red-500/40 bg-red-950/20' : 'border-gray-700/50 bg-gray-800/50'
          ]"
        >
          <!-- Device name + duration -->
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-xs text-gray-200 truncate flex-1">{{ device.name }}</span>
            <span v-if="device.is_default && !recordingStore.isDeviceRecording(device.id)" class="text-[9px] text-cyan-500/70 shrink-0">default</span>
            <span
              v-if="recordingStore.isDeviceRecording(device.id)"
              class="text-[10px] font-mono text-red-400 shrink-0"
            >
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse mr-1 align-middle" />
              {{ formatTime(recordingStore.getDeviceSession(device.id)?.duration ?? 0) }}
            </span>
          </div>

          <!-- VU meter (when NOT recording) -->
          <div v-if="!recordingStore.isDeviceRecording(device.id)" class="flex items-center gap-2">
            <div class="flex-1">
              <DeviceMeter :level="recordingStore.getDeviceLevel(device.id)" />
            </div>
            <button
              class="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white text-[10px] font-medium transition-colors"
              @click="handleRecord(device.id)"
            >
              <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>
              Rec
            </button>
          </div>

          <!-- Waveform + controls (when recording) -->
          <div v-else>
            <div class="mb-1.5">
              <MiniWaveform :level="recordingStore.getDeviceLevel(device.id)" />
            </div>
            <div class="flex items-center gap-1.5 justify-end">
              <!-- Lock toggle -->
              <button
                :class="[
                  'p-1 rounded transition-colors',
                  recordingStore.isLocked ? 'text-amber-400 bg-amber-500/15' : 'text-gray-500 hover:text-gray-300'
                ]"
                :title="recordingStore.isLocked ? 'Unlock' : 'Lock (prevent accidental stop)'"
                @click="toggleLock"
              >
                <svg v-if="recordingStore.isLocked" class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <svg v-else class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              </button>
              <!-- Stop button (normal) -->
              <button
                v-if="!recordingStore.isLocked"
                class="flex items-center gap-1 px-2 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white text-[10px] font-medium transition-colors"
                @click="handleStop(device.id)"
              >
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                Stop
              </button>
              <!-- Hold-to-stop button (when locked) -->
              <button
                v-else
                class="relative flex items-center gap-1 px-2 py-1 rounded bg-gray-700 text-white text-[10px] font-medium overflow-hidden select-none"
                @mousedown="startHold(device.id)"
                @mouseup="cancelHold(device.id)"
                @mouseleave="cancelHold(device.id)"
                @touchstart.prevent="startHold(device.id)"
                @touchend.prevent="cancelHold(device.id)"
                @touchcancel.prevent="cancelHold(device.id)"
              >
                <div class="absolute inset-0 bg-amber-500/30" :style="{ width: `${getHoldProgress(device.id) * 100}%` }" />
                <span class="relative flex items-center gap-1">
                  <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  {{ getHoldProgress(device.id) > 0 ? 'Hold...' : 'Hold' }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== System Audio Section ========== -->
    <div v-if="recordingStore.loopbackDevices.length > 0" class="mb-3">
      <div class="flex items-center gap-1.5 px-1 mb-1.5">
        <svg class="w-3 h-3 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <span class="text-[10px] font-medium text-purple-400 uppercase tracking-wide">System Audio</span>
      </div>
      <div class="space-y-1">
        <div
          v-for="device in visibleLoopbackDevices"
          :key="device.id"
          :class="[
            'rounded-lg border px-3 py-2 transition-colors',
            recordingStore.isDeviceRecording(device.id) ? 'border-red-500/40 bg-red-950/20' : 'border-gray-700/50 bg-gray-800/50'
          ]"
        >
          <!-- Device name + duration -->
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-xs text-gray-200 truncate flex-1">{{ device.name }}</span>
            <span
              v-if="recordingStore.isDeviceRecording(device.id)"
              class="text-[10px] font-mono text-red-400 shrink-0"
            >
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse mr-1 align-middle" />
              {{ formatTime(recordingStore.getDeviceSession(device.id)?.duration ?? 0) }}
            </span>
          </div>

          <!-- VU meter (when NOT recording) -->
          <div v-if="!recordingStore.isDeviceRecording(device.id)" class="flex items-center gap-2">
            <div class="flex-1">
              <DeviceMeter :level="recordingStore.getDeviceLevel(device.id)" />
            </div>
            <button
              class="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white text-[10px] font-medium transition-colors"
              @click="handleRecord(device.id)"
            >
              <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>
              Rec
            </button>
          </div>

          <!-- Waveform + controls (when recording) -->
          <div v-else>
            <div class="mb-1.5">
              <MiniWaveform :level="recordingStore.getDeviceLevel(device.id)" />
            </div>
            <div class="flex items-center gap-1.5 justify-end">
              <!-- Lock toggle -->
              <button
                :class="[
                  'p-1 rounded transition-colors',
                  recordingStore.isLocked ? 'text-amber-400 bg-amber-500/15' : 'text-gray-500 hover:text-gray-300'
                ]"
                :title="recordingStore.isLocked ? 'Unlock' : 'Lock (prevent accidental stop)'"
                @click="toggleLock"
              >
                <svg v-if="recordingStore.isLocked" class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <svg v-else class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              </button>
              <!-- Stop button (normal) -->
              <button
                v-if="!recordingStore.isLocked"
                class="flex items-center gap-1 px-2 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white text-[10px] font-medium transition-colors"
                @click="handleStop(device.id)"
              >
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                Stop
              </button>
              <!-- Hold-to-stop button (when locked) -->
              <button
                v-else
                class="relative flex items-center gap-1 px-2 py-1 rounded bg-gray-700 text-white text-[10px] font-medium overflow-hidden select-none"
                @mousedown="startHold(device.id)"
                @mouseup="cancelHold(device.id)"
                @mouseleave="cancelHold(device.id)"
                @touchstart.prevent="startHold(device.id)"
                @touchend.prevent="cancelHold(device.id)"
                @touchcancel.prevent="cancelHold(device.id)"
              >
                <div class="absolute inset-0 bg-amber-500/30" :style="{ width: `${getHoldProgress(device.id) * 100}%` }" />
                <span class="relative flex items-center gap-1">
                  <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  {{ getHoldProgress(device.id) > 0 ? 'Hold...' : 'Hold' }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== Channel Mode + Timemark Controls ========== -->
    <div class="flex items-center justify-between gap-2 mb-3">
      <!-- Mono/Stereo -->
      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-gray-500">Channels:</span>
        <div class="flex items-center gap-1">
          <button
            v-for="mode in (['mono', 'stereo'] as const)"
            :key="mode"
            type="button"
            :class="[
              'px-2 py-0.5 text-[10px] rounded transition-colors',
              settingsStore.settings.recordingChannelMode === mode
                ? 'bg-cyan-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-600'
            ]"
            @click="settingsStore.setRecordingChannelMode(mode)"
          >
            {{ mode === 'mono' ? 'Mono' : 'Stereo' }}
          </button>
        </div>
      </div>

      <!-- Timemark button (only when recording) -->
      <button
        v-if="anyRecording"
        :class="[
          'flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium transition-all',
          markFlash
            ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300 mark-flash'
            : 'border-gray-600 bg-gray-700 text-gray-300 hover:border-cyan-500 hover:text-cyan-400'
        ]"
        title="Add timemark (M)"
        @click="handleAddMark"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        Mark
        <span v-if="recordingStore.timemarks.length > 0" class="text-gray-500 ml-0.5">
          ({{ recordingStore.timemarks.length }})
        </span>
      </button>
    </div>

    <!-- Recent timemarks (when recording, last 3) -->
    <div v-if="anyRecording && recordingStore.timemarks.length > 0" class="mb-3 max-h-[60px] overflow-y-auto">
      <div
        v-for="mark in recordingStore.timemarks.slice(-3).reverse()"
        :key="mark.id"
        class="flex items-center gap-2 text-[10px] py-0.5 group/mark"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :style="{ backgroundColor: mark.color || (mark.source === 'manual' ? '#00d4ff' : '#fbbf24') }"
        />
        <span class="text-gray-400 font-mono">{{ formatTime(mark.time) }}</span>
        <span class="text-gray-300 truncate flex-1">{{ mark.label }}</span>
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

    <!-- Collapsible trigger phrases (when recording) -->
    <div v-if="anyRecording" class="mb-3">
      <button
        class="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-300 transition-colors"
        @click="showTriggerPhrases = !showTriggerPhrases"
      >
        <svg
          class="w-2.5 h-2.5 transition-transform"
          :class="showTriggerPhrases ? 'rotate-90' : ''"
          fill="currentColor" viewBox="0 0 20 20"
        >
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>
        Trigger Phrases
      </button>
      <div v-if="showTriggerPhrases" class="mt-1.5">
        <input
          v-model="triggerPhrasesInput"
          type="text"
          placeholder="e.g. chapter, section, note"
          class="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-[10px] text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          @input="handleTriggerPhrasesChange"
        />
        <p class="mt-1 text-[9px] text-gray-500">
          Comma-separated. Auto-marks added after transcription completes.
        </p>
      </div>
    </div>

    <!-- Error display -->
    <div v-if="recordingStore.error" class="mt-2 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ recordingStore.error }}
    </div>

    <!-- No devices -->
    <div v-if="recordingStore.microphoneDevices.length === 0 && recordingStore.loopbackDevices.length === 0" class="py-4 text-center">
      <span class="text-xs text-gray-500">No audio devices found</span>
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
</style>
