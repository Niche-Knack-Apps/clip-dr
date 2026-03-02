<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRecordingStore } from '@/stores/recording';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  schedule: [config: { deviceIds: string[]; startTime: number; endTime: number }];
}>();

const recordingStore = useRecordingStore();

// Form state
const selectedDeviceIds = ref<string[]>([]);
const startDate = ref('');
const startTime = ref('');
const endDate = ref('');
const endTime = ref('');
const durationHours = ref(0);
const durationMinutes = ref(30);
const durationSeconds = ref(0);

// Which field drives the end: 'endtime' or 'duration'
const endMode = ref<'endtime' | 'duration'>('duration');

const validationError = ref('');

// Smart defaults when modal becomes visible
watch(() => props.visible, (visible) => {
  if (visible) {
    setSmartDefaults();
  }
});

function setSmartDefaults() {
  const now = new Date();
  // Round up to next minute + 1 min
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 2);

  startDate.value = formatDateInput(now);
  startTime.value = formatTimeInput(now);

  // Default duration: 30 minutes
  durationHours.value = 0;
  durationMinutes.value = 30;
  durationSeconds.value = 0;
  endMode.value = 'duration';

  // Compute end from duration
  recomputeEnd();

  // Default device: currently selected or first available
  const defaultId = recordingStore.selectedDeviceId || recordingStore.devices[0]?.id || '';
  selectedDeviceIds.value = defaultId ? [defaultId] : [];
  validationError.value = '';
}

function formatDateInput(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeInput(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseDateTime(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return 0;
  return new Date(`${dateStr}T${timeStr}`).getTime();
}

const startMs = computed(() => parseDateTime(startDate.value, startTime.value));
const endMs = computed(() => parseDateTime(endDate.value, endTime.value));
const durationMs = computed(() =>
  (durationHours.value * 3600 + durationMinutes.value * 60 + durationSeconds.value) * 1000
);

// Format computed duration for the dimmed display when in endtime mode
const computedDurationDisplay = computed(() => {
  if (endMs.value <= startMs.value) return '--:--:--';
  const totalSec = Math.round((endMs.value - startMs.value) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
});

// Format computed end time for the dimmed display when in duration mode
const computedEndDisplay = computed(() => {
  if (!startMs.value || durationMs.value < 1000) return '--';
  const end = new Date(startMs.value + durationMs.value);
  return end.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
});

function recomputeEnd() {
  if (!startMs.value || durationMs.value < 1000) return;
  const end = new Date(startMs.value + durationMs.value);
  endDate.value = formatDateInput(end);
  endTime.value = formatTimeInput(end);
}

function recomputeDuration() {
  if (!startMs.value || !endMs.value || endMs.value <= startMs.value) return;
  const diff = endMs.value - startMs.value;
  const totalSec = Math.round(diff / 1000);
  durationHours.value = Math.floor(totalSec / 3600);
  durationMinutes.value = Math.floor((totalSec % 3600) / 60);
  durationSeconds.value = totalSec % 60;
}

function onStartChanged() {
  if (endMode.value === 'duration') {
    recomputeEnd();
  } else {
    recomputeDuration();
  }
}

function onEndChanged() {
  recomputeDuration();
}

function onDurationChanged() {
  recomputeEnd();
}

function validate(): boolean {
  const now = Date.now();
  if (selectedDeviceIds.value.length === 0) {
    validationError.value = 'Please select at least one device';
    return false;
  }
  if (!startMs.value) {
    validationError.value = 'Invalid start date/time';
    return false;
  }
  if (startMs.value <= now) {
    validationError.value = 'Start time must be in the future';
    return false;
  }

  const effectiveEnd = endMode.value === 'duration'
    ? startMs.value + durationMs.value
    : endMs.value;

  if (!effectiveEnd || effectiveEnd <= startMs.value) {
    validationError.value = 'End time must be after start time';
    return false;
  }
  if (effectiveEnd - startMs.value < 1000) {
    validationError.value = 'Duration must be at least 1 second';
    return false;
  }
  validationError.value = '';
  return true;
}

function handleSchedule() {
  if (!validate()) return;

  const effectiveEnd = endMode.value === 'duration'
    ? startMs.value + durationMs.value
    : endMs.value;

  emit('schedule', {
    deviceIds: selectedDeviceIds.value,
    startTime: startMs.value,
    endTime: effectiveEnd,
  });
}

function handleClose() {
  emit('close');
}

function toggleDevice(id: string) {
  const idx = selectedDeviceIds.value.indexOf(id);
  if (idx >= 0) {
    selectedDeviceIds.value = selectedDeviceIds.value.filter(d => d !== id);
  } else {
    selectedDeviceIds.value = [...selectedDeviceIds.value, id];
  }
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('schedule-overlay')) {
    handleClose();
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    handleClose();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="schedule-overlay fixed inset-0 flex items-center justify-center z-50 bg-black/50"
      @click="onOverlayClick"
    >
      <div class="bg-gray-800 rounded-lg shadow-xl border border-gray-700 w-full max-w-sm p-5" @click.stop>
        <h2 class="text-sm font-medium text-gray-200 mb-4">Schedule Recording</h2>

        <!-- Devices -->
        <div class="mb-3">
          <label class="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">
            Devices
            <span v-if="selectedDeviceIds.length > 0" class="text-gray-500 normal-case ml-1">({{ selectedDeviceIds.length }} selected)</span>
          </label>
          <div class="max-h-32 overflow-y-auto border border-gray-600 rounded bg-gray-700 p-1.5 space-y-0.5">
            <label
              v-for="device in recordingStore.devices"
              :key="device.id"
              class="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer hover:bg-gray-600/50 transition-colors"
            >
              <input
                type="checkbox"
                :checked="selectedDeviceIds.includes(device.id)"
                class="accent-cyan-500"
                @change="toggleDevice(device.id)"
              />
              <span class="text-xs text-gray-200 truncate">{{ device.name }}</span>
              <span v-if="device.is_default" class="text-[9px] text-cyan-500/70 ml-auto shrink-0">default</span>
            </label>
          </div>
        </div>

        <!-- Start Date + Time -->
        <div class="mb-3">
          <label class="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Start</label>
          <div class="flex gap-2">
            <input
              v-model="startDate"
              type="date"
              class="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-xs text-gray-200 focus:outline-none focus:border-cyan-500"
              @change="onStartChanged"
            />
            <input
              v-model="startTime"
              type="time"
              class="w-28 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-xs text-gray-200 focus:outline-none focus:border-cyan-500"
              @change="onStartChanged"
            />
          </div>
        </div>

        <!-- End Mode Toggle -->
        <div class="flex items-center gap-3 mb-3">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              :checked="endMode === 'endtime'"
              class="accent-cyan-500"
              @change="endMode = 'endtime'"
            />
            <span class="text-[10px] text-gray-300">End Time</span>
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              :checked="endMode === 'duration'"
              class="accent-cyan-500"
              @change="endMode = 'duration'"
            />
            <span class="text-[10px] text-gray-300">Duration</span>
          </label>
        </div>

        <!-- End Date + Time -->
        <div class="mb-3">
          <label class="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">
            End Time
            <span v-if="endMode === 'duration'" class="text-gray-500 normal-case ml-1">({{ computedEndDisplay }})</span>
          </label>
          <div class="flex gap-2">
            <input
              v-model="endDate"
              type="date"
              :disabled="endMode === 'duration'"
              :class="[
                'flex-1 px-2 py-1.5 border rounded text-xs focus:outline-none',
                endMode === 'duration'
                  ? 'bg-gray-750 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 border-gray-600 text-gray-200 focus:border-cyan-500'
              ]"
              @change="onEndChanged"
            />
            <input
              v-model="endTime"
              type="time"
              :disabled="endMode === 'duration'"
              :class="[
                'w-28 px-2 py-1.5 border rounded text-xs focus:outline-none',
                endMode === 'duration'
                  ? 'bg-gray-750 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 border-gray-600 text-gray-200 focus:border-cyan-500'
              ]"
              @change="onEndChanged"
            />
          </div>
        </div>

        <!-- Duration H:M:S -->
        <div class="mb-4">
          <label class="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">
            Duration
            <span v-if="endMode === 'endtime'" class="text-gray-500 normal-case ml-1">({{ computedDurationDisplay }})</span>
          </label>
          <div class="flex items-center gap-1">
            <input
              v-model.number="durationHours"
              type="number"
              min="0"
              max="99"
              :disabled="endMode === 'endtime'"
              :class="[
                'w-14 px-2 py-1.5 border rounded text-xs text-center focus:outline-none',
                endMode === 'endtime'
                  ? 'bg-gray-750 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 border-gray-600 text-gray-200 focus:border-cyan-500'
              ]"
              @input="onDurationChanged"
            />
            <span class="text-[10px] text-gray-500">h</span>
            <input
              v-model.number="durationMinutes"
              type="number"
              min="0"
              max="59"
              :disabled="endMode === 'endtime'"
              :class="[
                'w-14 px-2 py-1.5 border rounded text-xs text-center focus:outline-none',
                endMode === 'endtime'
                  ? 'bg-gray-750 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 border-gray-600 text-gray-200 focus:border-cyan-500'
              ]"
              @input="onDurationChanged"
            />
            <span class="text-[10px] text-gray-500">m</span>
            <input
              v-model.number="durationSeconds"
              type="number"
              min="0"
              max="59"
              :disabled="endMode === 'endtime'"
              :class="[
                'w-14 px-2 py-1.5 border rounded text-xs text-center focus:outline-none',
                endMode === 'endtime'
                  ? 'bg-gray-750 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 border-gray-600 text-gray-200 focus:border-cyan-500'
              ]"
              @input="onDurationChanged"
            />
            <span class="text-[10px] text-gray-500">s</span>
          </div>
        </div>

        <!-- Validation error -->
        <div v-if="validationError" class="mb-3 text-[10px] text-red-400">
          {{ validationError }}
        </div>

        <!-- Buttons -->
        <div class="flex justify-end gap-2">
          <button
            class="px-3 py-1.5 rounded text-xs text-gray-300 bg-gray-700 hover:bg-gray-600 transition-colors"
            @click="handleClose"
          >
            Cancel
          </button>
          <button
            class="px-3 py-1.5 rounded text-xs text-white bg-cyan-600 hover:bg-cyan-500 transition-colors"
            @click="handleSchedule"
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
