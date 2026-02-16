<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import Button from '@/components/ui/Button.vue';
import Toggle from '@/components/ui/Toggle.vue';
import Slider from '@/components/ui/Slider.vue';
import InfiniteKnob from '@/components/ui/InfiniteKnob.vue';
import SearchBar from '@/components/search/SearchBar.vue';
import CleaningPanel from '@/components/cleaning/CleaningPanel.vue';
import RecordingPanel from '@/components/recording/RecordingPanel.vue';
import { useAudio } from '@/composables/useAudio';
import { usePlayback } from '@/composables/usePlayback';
import { useSelection } from '@/composables/useSelection';
import { useClipping } from '@/composables/useClipping';
import { useVadStore, VAD_PRESETS } from '@/stores/vad';
import type { VadPresetName } from '@/stores/vad';
import { useSilenceStore } from '@/stores/silence';
import { useCleaningStore } from '@/stores/cleaning';
import { useSettingsStore } from '@/stores/settings';
import { useExportStore } from '@/stores/export';
import { usePlaybackStore } from '@/stores/playback';
import { useTranscriptionStore } from '@/stores/transcription';
import { useTracksStore } from '@/stores/tracks';
import { useRecordingStore } from '@/stores/recording';
import MasterMeter from '@/components/tracks/MasterMeter.vue';
import { formatTime } from '@/shared/utils';
import { SUPPORTED_FORMATS, TOOLBAR_ROW_HEIGHT, TOOLBAR_HEIGHT, LOOP_MODES } from '@/shared/constants';
import type { LoopMode } from '@/shared/constants';
import type { ExportProfile } from '@/shared/types';

const emit = defineEmits<{
  openSettings: [];
}>();

const {
  hasFile,
  isPlaying,
  currentTime,
  duration,
  fileName,
  loading,
  loadFile,
  togglePlay,
  setVolume,
} = useAudio();

const {
  volume,
  loopEnabled,
  toggleLoop,
} = usePlayback();

const playbackStore = usePlaybackStore();

const {
  setInPoint,
  setOutPoint,
  inPoint,
  outPoint,
} = useSelection();

const {
  canCreateClip,
  createClip,
} = useClipping();

const vadStore = useVadStore();
const silenceStore = useSilenceStore();
const cleaningStore = useCleaningStore();
const settingsStore = useSettingsStore();
const exportStore = useExportStore();
const transcriptionStore = useTranscriptionStore();
const tracksStore = useTracksStore();
const recordingStore = useRecordingStore();
const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);
const showVadSettings = ref(false);
const showCleaningPanel = ref(false);
const showRecordingPanel = ref(false);
const transportRef = ref<HTMLElement | null>(null);
const recordingPanelStyle = ref<Record<string, string>>({});
const searchFocused = ref(false);

function handleMicClick() {
  if (recordingStore.isRecording) {
    showRecordingPanel.value = !showRecordingPanel.value;
    return;
  }
  showRecordingPanel.value = true;
  recordingStore.quickStart('microphone');
}

function handleSystemClick() {
  if (recordingStore.isRecording) {
    showRecordingPanel.value = !showRecordingPanel.value;
    return;
  }
  showRecordingPanel.value = true;
  recordingStore.quickStart('system');
}

// Close recording panel on window blur when not actively recording
function handleWindowBlur() {
  if (showRecordingPanel.value && !recordingStore.isRecording && !recordingStore.isPreparing) {
    showRecordingPanel.value = false;
  }
}

onMounted(() => window.addEventListener('blur', handleWindowBlur));
onUnmounted(() => window.removeEventListener('blur', handleWindowBlur));

// Compute recording panel max-width when it opens so it doesn't overflow viewport
watch(showRecordingPanel, (show) => {
  if (show) {
    nextTick(() => {
      if (transportRef.value) {
        const rect = transportRef.value.getBoundingClientRect();
        const availW = window.innerWidth - rect.left - 16;
        recordingPanelStyle.value = {
          maxWidth: `${Math.max(320, availW)}px`,
        };
      }
    });
  }
});

// Check for model on load
transcriptionStore.checkModel();

function handleReTranscribe() {
  const sel = tracksStore.selectedTrackId;
  if (sel && sel !== 'ALL') {
    transcriptionStore.removeTranscription(sel);
    transcriptionStore.queueTranscription(sel, 'high');
  }
}

async function handleDetectSilence() {
  await vadStore.detectSilence();
  // Automatically create silence overlays from detection results
  silenceStore.initFromVad();
}

function handleAddSilenceRegion() {
  // Add silence region from in/out points
  if (inPoint.value !== null && outPoint.value !== null) {
    silenceStore.addRegion(inPoint.value, outPoint.value);
  }
}

function handleClearSilenceRegions() {
  silenceStore.clear();
  vadStore.clear();
}

async function handleCutSilence() {
  await silenceStore.cutSilenceToNewTrack();
}

async function handleImport() {
  try {
    const lastFolder = settingsStore.settings.lastImportFolder || undefined;

    const selected = await open({
      multiple: false,
      defaultPath: lastFolder,
      filters: [
        {
          name: 'Audio',
          extensions: SUPPORTED_FORMATS.map((f) => f.slice(1)),
        },
      ],
    });

    if (selected && typeof selected === 'string') {
      settingsStore.setLastImportFolder(selected);
      await loadFile(selected);
    }
  } catch (e) {
    console.error('Import error:', e);
  }
}

function profileLabel(profile: ExportProfile): string {
  if (profile.format === 'mp3' && profile.mp3Bitrate) {
    return `MP3 ${profile.mp3Bitrate}`;
  }
  return profile.format.toUpperCase();
}

async function handleDownloadTranscriptJSON() {
  const trackId = tracksStore.selectedTrackId;
  if (!trackId || trackId === 'ALL') return;
  const json = transcriptionStore.exportAsJSON(trackId);
  if (!json) return;
  const path = await save({
    defaultPath: `transcription_${tracksStore.selectedTrack?.name || 'track'}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (path) await writeTextFile(path, json);
}

async function handleDownloadTranscriptTXT() {
  const trackId = tracksStore.selectedTrackId;
  if (!trackId || trackId === 'ALL') return;
  const txt = transcriptionStore.exportAsText(trackId);
  if (!txt) return;
  const path = await save({
    defaultPath: `transcription_${tracksStore.selectedTrack?.name || 'track'}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (path) await writeTextFile(path, txt);
}

function focusSearch() {
  searchBarRef.value?.focus();
}

defineExpose({ focusSearch });
</script>

<template>
  <div
    class="flex flex-col bg-gray-900 border-b border-gray-800"
    :style="{ height: `${TOOLBAR_HEIGHT}px` }"
  >
    <!-- Row 1: File, Playback, Loop, In/Out, Search, Volume, Settings -->
    <div
      class="flex items-center gap-3 px-3"
      :style="{ height: `${TOOLBAR_ROW_HEIGHT}px` }"
    >
      <!-- File controls -->
      <div class="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          :loading="loading"
          @click="handleImport"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Import
        </Button>

        <span v-if="fileName" class="text-xs text-gray-400 max-w-[100px] truncate">
          {{ fileName }}
        </span>
      </div>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Unified Transport Controls -->
      <div ref="transportRef" class="flex items-center gap-1 bg-gray-800 rounded-lg px-1 py-0.5 relative">
        <!-- Mic record button -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :class="{ 'text-red-500': recordingStore.isRecording && recordingStore.source === 'microphone' }"
          title="Record from microphone"
          @click="handleMicClick"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" :class="recordingStore.isRecording && recordingStore.source === 'microphone' ? 'animate-pulse' : ''">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </Button>

        <!-- System record button -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :class="{ 'text-red-500': recordingStore.isRecording && recordingStore.source === 'system' }"
          title="Record system audio"
          @click="handleSystemClick"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" :class="recordingStore.isRecording && recordingStore.source === 'system' ? 'animate-pulse' : ''">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </Button>

        <!-- Rewind button -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!hasFile"
          title="Rewind (speed down)"
          @click="playbackStore.speedDown()"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
          </svg>
        </Button>

        <!-- Play/Pause button -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!hasFile && !recordingStore.isRecording"
          title="Play/Pause (Space)"
          @click="togglePlay"
        >
          <svg v-if="isPlaying" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
          <svg v-else class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </Button>

        <!-- Fast Forward button -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!hasFile"
          title="Fast forward (speed up)"
          @click="playbackStore.speedUp()"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z" />
          </svg>
        </Button>

        <!-- Speed indicator -->
        <span
          v-if="playbackStore.playbackSpeed !== 1"
          class="text-[10px] font-mono text-cyan-400 ml-1"
        >
          {{ playbackStore.playbackSpeed }}x
        </span>

        <!-- Recording Panel Popover -->
        <div
          v-if="showRecordingPanel"
          class="absolute top-full left-0 mt-2 z-50"
          :style="recordingPanelStyle"
        >
          <RecordingPanel @close="showRecordingPanel = false" />
        </div>
      </div>

      <!-- Time display -->
      <span class="text-xs font-mono text-gray-400 min-w-[70px]">
        {{ recordingStore.isRecording ? formatTime(recordingStore.recordingDuration) : formatTime(currentTime) }} / {{ formatTime(duration) }}
      </span>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Loop controls with mode selection -->
      <div class="flex items-center gap-1">
        <Toggle
          :model-value="loopEnabled"
          label="Loop"
          :disabled="!hasFile"
          @update:model-value="toggleLoop"
        />

        <!-- Loop mode radio buttons -->
        <div v-if="loopEnabled" class="flex items-center gap-0.5 ml-1 bg-gray-800 rounded p-0.5">
          <button
            v-for="mode in LOOP_MODES"
            :key="mode.value"
            type="button"
            :class="[
              'px-1.5 py-0.5 text-[10px] rounded transition-colors',
              playbackStore.loopMode === mode.value
                ? 'bg-cyan-600 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            ]"
            :disabled="!hasFile"
            @click="playbackStore.setLoopMode(mode.value as LoopMode)"
          >
            {{ mode.label }}
          </button>
        </div>
      </div>

      <!-- Spacer -->
      <div class="flex-1" />

      <!-- Search -->
      <div
        :class="[
          'transition-all duration-200',
          searchFocused ? 'max-w-[400px]' : 'max-w-[180px]'
        ]"
      >
        <SearchBar
          ref="searchBarRef"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
        />
      </div>

      <!-- Volume + Master Meter -->
      <div class="flex items-center gap-1.5">
        <MasterMeter />
        <InfiniteKnob
          :model-value="volume"
          :min="0"
          :max="1"
          :step="0.01"
          :default-value="0.8"
          :format-value="(v: number) => `${Math.round(v * 100)}%`"
          @update:model-value="setVolume"
        />
      </div>

      <!-- Settings -->
      <Button
        variant="ghost"
        size="sm"
        icon
        @click="emit('openSettings')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </Button>
    </div>

    <!-- Row 2: Clip, Detect Silence, Clean, Export -->
    <div
      class="flex items-center gap-3 px-3 border-t border-gray-800"
      :style="{ height: `${TOOLBAR_ROW_HEIGHT}px` }"
    >
      <!-- In/Out controls -->
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          :disabled="!hasFile"
          @click="setInPoint"
        >
          <span class="text-green-500 font-bold mr-1 text-xs">I</span>
          <span v-if="inPoint !== null" class="text-[10px] text-gray-500">{{ formatTime(inPoint) }}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          :disabled="!hasFile"
          @click="setOutPoint"
        >
          <span class="text-red-500 font-bold mr-1 text-xs">O</span>
          <span v-if="outPoint !== null" class="text-[10px] text-gray-500">{{ formatTime(outPoint) }}</span>
        </Button>
      </div>

      <!-- Clip button -->
      <Button
        variant="primary"
        size="sm"
        :disabled="!canCreateClip"
        @click="createClip"
      >
        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
        Clip
      </Button>

      <div class="w-px h-5 bg-gray-700" />

      <!-- VAD / Silence Removal -->
      <div class="flex items-center gap-1 relative">
        <Button
          v-if="!silenceStore.hasRegions"
          variant="secondary"
          size="sm"
          :disabled="!hasFile"
          :loading="vadStore.loading"
          @click="handleDetectSilence"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
          Detect Silence
        </Button>

        <template v-else-if="silenceStore.hasRegions">
          <!-- Silence percentage -->
          <span class="text-[10px] text-gray-400">
            {{ silenceStore.activeSilenceRegions.length }} regions
          </span>
          <!-- Skip Silence toggle -->
          <Toggle
            :model-value="silenceStore.compressionEnabled"
            label="Skip"
            @update:model-value="silenceStore.toggleCompression"
          />
          <!-- Saved duration -->
          <span class="text-[10px] text-green-400 font-mono">
            -{{ formatTime(silenceStore.savedDuration) }}
          </span>
          <!-- Cut Silence - creates new track -->
          <Button
            variant="primary"
            size="sm"
            :loading="silenceStore.cutting"
            title="Cut silence and create new track (non-destructive)"
            @click="handleCutSilence"
          >
            <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
            </svg>
            Cut
          </Button>
          <!-- Add manual silence region -->
          <Button
            variant="ghost"
            size="sm"
            :disabled="inPoint === null || outPoint === null"
            title="Add silence region from In/Out points"
            @click="handleAddSilenceRegion"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
          </Button>
          <!-- Clear all -->
          <Button
            variant="ghost"
            size="sm"
            icon
            @click="handleClearSilenceRegions"
            title="Clear all silence regions"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </template>

        <Button
          variant="ghost"
          size="sm"
          icon
          :class="{ 'bg-gray-700': showVadSettings }"
          @click="showVadSettings = !showVadSettings"
          title="VAD settings"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        </Button>

        <!-- VAD Settings Popover -->
        <div
          v-if="showVadSettings"
          class="absolute top-full left-0 mt-2 p-3 bg-gray-800 rounded-lg shadow-xl border border-gray-700 z-50 min-w-[240px]"
        >
          <div class="text-xs text-gray-400 mb-2 font-medium">Silence Detection</div>
          <div class="space-y-3">
            <!-- Preset selector -->
            <div>
              <label class="text-[10px] text-gray-500 block mb-1">Preset</label>
              <div class="flex gap-1">
                <button
                  v-for="preset in VAD_PRESETS"
                  :key="preset.name"
                  type="button"
                  :class="[
                    'px-2 py-1 text-[10px] rounded transition-colors',
                    vadStore.activePreset === preset.name
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-600'
                  ]"
                  :title="preset.description"
                  @click="vadStore.setPreset(preset.name as VadPresetName)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
            <div>
              <label class="text-[10px] text-gray-500 block mb-1">
                Sensitivity: {{ (vadStore.options.energyThreshold * 100).toFixed(0) }}%
              </label>
              <Slider
                :model-value="vadStore.options.energyThreshold"
                :min="0.01"
                :max="0.5"
                :step="0.01"
                @update:model-value="(v: number) => vadStore.setOptions({ energyThreshold: v })"
              />
            </div>
            <div>
              <label class="text-[10px] text-gray-500 block mb-1">
                Padding: {{ (vadStore.options.padding * 1000).toFixed(0) }}ms
              </label>
              <Slider
                :model-value="vadStore.options.padding"
                :min="0"
                :max="0.5"
                :step="0.01"
                @update:model-value="(v: number) => vadStore.setOptions({ padding: v })"
              />
            </div>
            <div>
              <label class="text-[10px] text-gray-500 block mb-1">
                Min Silence: {{ (vadStore.options.minSilenceDuration * 1000).toFixed(0) }}ms
              </label>
              <Slider
                :model-value="vadStore.options.minSilenceDuration"
                :min="0.1"
                :max="2.0"
                :step="0.05"
                @update:model-value="(v: number) => vadStore.setOptions({ minSilenceDuration: v })"
              />
            </div>
            <div>
              <label class="text-[10px] text-gray-500 block mb-1">
                Frame Size: {{ vadStore.options.frameSizeMs }}ms
              </label>
              <div class="flex gap-1">
                <button
                  v-for="fs in [10, 20, 30]"
                  :key="fs"
                  type="button"
                  :class="[
                    'px-2 py-0.5 text-[10px] rounded transition-colors',
                    vadStore.options.frameSizeMs === fs
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-600'
                  ]"
                  @click="vadStore.setOptions({ frameSizeMs: fs })"
                >
                  {{ fs }}ms
                </button>
              </div>
            </div>
            <!-- Detection stats -->
            <div v-if="vadStore.hasResult" class="text-[10px] text-gray-500 pt-1 border-t border-gray-700">
              Speech: {{ vadStore.totalSpeechDuration.toFixed(1) }}s
              | Silence: {{ vadStore.totalSilenceDuration.toFixed(1) }}s
              ({{ vadStore.silencePercentage.toFixed(0) }}%)
            </div>
          </div>
          <div class="mt-3 pt-2 border-t border-gray-700">
            <Button
              variant="secondary"
              size="sm"
              class="w-full"
              :disabled="!hasFile"
              :loading="vadStore.loading"
              @click="handleDetectSilence"
            >
              Re-detect
            </Button>
          </div>
        </div>
      </div>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Audio Cleaning -->
      <div class="flex items-center gap-1 relative">
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasFile || !cleaningStore.canClean"
          :loading="cleaningStore.loading"
          @click="cleaningStore.cleanSelectedTrack()"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          Clean
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon
          :class="{ 'bg-gray-700': showCleaningPanel }"
          @click="showCleaningPanel = !showCleaningPanel"
          title="Cleaning settings"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        </Button>

        <!-- Cleaning Panel Popover -->
        <div
          v-if="showCleaningPanel"
          class="absolute top-full left-0 mt-2 z-50"
        >
          <CleaningPanel />
        </div>
      </div>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Transcription -->
      <div class="flex items-center gap-1 relative">
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasFile || !transcriptionStore.hasModel"
          :loading="transcriptionStore.loading"
          :title="!transcriptionStore.hasModel ? 'Model not available - check Settings' : 'Re-run transcription'"
          @click="handleReTranscribe"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          Re-transcribe
        </Button>
        <!-- Quality selector -->
        <div class="flex items-center gap-0.5 bg-gray-800 rounded p-0.5">
          <button
            v-for="q in ([
              { value: 'fast', label: 'Fast', title: 'Greedy, best_of=1 — fastest' },
              { value: 'balanced', label: 'Bal', title: 'Beam search, beam=3 — balanced' },
              { value: 'best', label: 'Best', title: 'Beam search, beam=5 — most accurate' },
            ] as const)"
            :key="q.value"
            type="button"
            :class="[
              'px-1.5 py-0.5 text-[10px] rounded transition-colors',
              transcriptionStore.transcriptionQuality === q.value
                ? 'bg-cyan-600 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            ]"
            :title="q.title"
            @click="transcriptionStore.setTranscriptionQuality(q.value)"
          >
            {{ q.label }}
          </button>
        </div>

        <!-- Transcript download buttons -->
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!transcriptionStore.hasTranscription"
          title="Download transcription as JSON"
          @click="handleDownloadTranscriptJSON"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 3c-2 0-3 1-3 3v12c0 2 1 3 3 3m8-18c2 0 3 1 3 3v12c0 2-1 3-3 3" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!transcriptionStore.hasTranscription"
          title="Download transcription as TXT"
          @click="handleDownloadTranscriptTXT"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 13h6m-6 2.5h4" />
          </svg>
        </Button>
      </div>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Export Profiles -->
      <div class="flex items-center gap-1 border-l border-gray-700 pl-2">
        <Button
          v-for="profile in settingsStore.getExportProfiles()"
          :key="profile.id"
          variant="ghost"
          size="sm"
          :disabled="!hasFile || !exportStore.canExport"
          :loading="exportStore.loading"
          :title="profile.name"
          @click="exportStore.exportWithProfile(profile)"
        >
          <span class="text-[10px]">
            <span v-if="profile.isFavorite" class="text-yellow-400 mr-0.5">&#9733;</span>{{ profileLabel(profile) }}
          </span>
        </Button>
      </div>

      <!-- Spacer -->
      <div class="flex-1" />
    </div>
  </div>
</template>
