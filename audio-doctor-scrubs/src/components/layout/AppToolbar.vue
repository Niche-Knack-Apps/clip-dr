<script setup lang="ts">
import { ref, computed } from 'vue';
import { open } from '@tauri-apps/plugin-dialog';
import Button from '@/components/ui/Button.vue';
import Toggle from '@/components/ui/Toggle.vue';
import Slider from '@/components/ui/Slider.vue';
import SearchBar from '@/components/search/SearchBar.vue';
import CleaningPanel from '@/components/cleaning/CleaningPanel.vue';
import ExportPanel from '@/components/export/ExportPanel.vue';
import { useAudio } from '@/composables/useAudio';
import { usePlayback } from '@/composables/usePlayback';
import { useSelection } from '@/composables/useSelection';
import { useClipping } from '@/composables/useClipping';
import { useVadStore } from '@/stores/vad';
import { useSilenceStore } from '@/stores/silence';
import { useCleaningStore } from '@/stores/cleaning';
import { useSettingsStore } from '@/stores/settings';
import { useExportStore } from '@/stores/export';
import { usePlaybackStore } from '@/stores/playback';
import { useTranscriptionStore } from '@/stores/transcription';
import { formatTime } from '@/shared/utils';
import { SUPPORTED_FORMATS, TOOLBAR_ROW_HEIGHT, TOOLBAR_HEIGHT, LOOP_MODES } from '@/shared/constants';
import type { LoopMode } from '@/shared/constants';

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
const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);
const showVadSettings = ref(false);
const showCleaningPanel = ref(false);
const showExportPanel = ref(false);

// Check for model on load
transcriptionStore.checkModel();

async function handleReTranscribe() {
  await transcriptionStore.reTranscribe();
}

async function handleDetectSilence() {
  await vadStore.detectSilence();
}

function handleRemoveSilence() {
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

      <!-- Playback controls -->
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon
          :disabled="!hasFile"
          @click="togglePlay"
        >
          <svg v-if="isPlaying" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
          <svg v-else class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </Button>

        <span class="text-xs font-mono text-gray-400 min-w-[70px]">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </span>
      </div>

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
      <div class="max-w-[180px]">
        <SearchBar ref="searchBarRef" />
      </div>

      <!-- Volume -->
      <div class="flex items-center gap-1.5 w-24">
        <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <Slider
          :model-value="volume"
          :min="0"
          :max="1"
          :step="0.01"
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
          v-if="!vadStore.hasResult && !silenceStore.hasRegions"
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

        <template v-else-if="vadStore.hasResult && !silenceStore.hasRegions">
          <span class="text-[10px] text-gray-400">
            {{ vadStore.silencePercentage.toFixed(0) }}% silence
          </span>
          <Button
            variant="primary"
            size="sm"
            @click="handleRemoveSilence"
          >
            Remove Silence
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon
            @click="vadStore.clear()"
            title="Clear detection"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </template>

        <template v-else-if="silenceStore.hasRegions">
          <!-- Skip Silence toggle -->
          <Toggle
            :model-value="silenceStore.compressionEnabled"
            label="Skip"
            @update:model-value="silenceStore.toggleCompression"
          />
          <!-- Saved duration -->
          <span class="text-[10px] text-green-400 font-mono">
            Saves: {{ formatTime(silenceStore.savedDuration) }}
          </span>
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
          class="absolute top-full left-0 mt-2 p-3 bg-gray-800 rounded-lg shadow-xl border border-gray-700 z-50 min-w-[200px]"
        >
          <div class="text-xs text-gray-400 mb-2 font-medium">Silence Detection</div>
          <div class="space-y-3">
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

      <!-- Export -->
      <div class="flex items-center gap-1 relative">
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasFile || !exportStore.canExport"
          :loading="exportStore.loading"
          @click="showExportPanel = !showExportPanel"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </Button>

        <!-- Export Panel Popover -->
        <div
          v-if="showExportPanel"
          class="absolute top-full left-0 mt-2 z-50"
        >
          <ExportPanel />
        </div>
      </div>

      <div class="w-px h-5 bg-gray-700" />

      <!-- Transcription -->
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

      <!-- Spacer -->
      <div class="flex-1" />
    </div>
  </div>
</template>
