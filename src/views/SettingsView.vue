<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { appLocalDataDir } from '@tauri-apps/api/path';
import Button from '@/components/ui/Button.vue';
import Toggle from '@/components/ui/Toggle.vue';
import Slider from '@/components/ui/Slider.vue';
import AboutPanel from '@/components/settings/AboutPanel.vue';
import LoggingPanel from '@/components/settings/LoggingPanel.vue';
import { useSettingsStore } from '@/stores/settings';
import { useTranscriptionStore } from '@/stores/transcription';
import type { ExportFormat, ExportProfile } from '@/shared/types';
import { ALL_SHORTCUT_HINTS, DEFAULT_SETTINGS } from '@/shared/constants';

const APP_VERSION = '0.13.3';

const emit = defineEmits<{
  close: [];
}>();

const settingsStore = useSettingsStore();
const transcriptionStore = useTranscriptionStore();
const loadingModels = ref(false);
const debugFiles = ref<string[]>([]);
const debugError = ref<string | null>(null);
const downloadingModel = ref<string | null>(null);
const downloadError = ref<string | null>(null);
const bundledModelPath = ref<string | null>(null);
const defaultProjectFolder = ref<string>('');
const defaultModelsPath = computed(() => {
  if (!defaultProjectFolder.value) return '';
  const base = defaultProjectFolder.value;
  return base.endsWith('/') || base.endsWith('\\') ? `${base}models/` : `${base}/models/`;
});

// Export profile management
const showNewProfileForm = ref(false);
const newProfileName = ref('');
const newProfileFormat = ref<ExportFormat>('mp3');
const newProfileBitrate = ref(192);

function handleAddProfile() {
  if (!newProfileName.value.trim()) return;
  const id = `custom-${Date.now()}`;
  const profile: ExportProfile = {
    id,
    name: newProfileName.value.trim(),
    format: newProfileFormat.value,
    ...(newProfileFormat.value === 'mp3' ? { mp3Bitrate: newProfileBitrate.value } : {}),
  };
  settingsStore.addExportProfile(profile);
  showNewProfileForm.value = false;
  newProfileName.value = '';
  newProfileFormat.value = 'mp3';
  newProfileBitrate.value = 192;
}

function handleDeleteProfile(id: string) {
  settingsStore.deleteExportProfile(id);
}

function toggleHint(id: string) {
  const current = settingsStore.settings.shortcutHints;
  if (current.includes(id)) {
    settingsStore.setShortcutHints(current.filter(h => h !== id));
  } else {
    settingsStore.setShortcutHints([...current, id]);
  }
}

function resetHints() {
  settingsStore.setShortcutHints([...DEFAULT_SETTINGS.shortcutHints]);
}

const displayPath = computed(() => {
  const path = settingsStore.settings.modelsPath;
  return path && path.trim() !== '' ? path : 'Using default location';
});

const hasCustomPath = computed(() => {
  const path = settingsStore.settings.modelsPath;
  return path && path.trim() !== '';
});

async function handleBrowseModelsPath() {
  const newPath = await settingsStore.browseModelsPath();
  if (newPath) {
    await refreshModels();
  }
}

async function handleResetModelsPath() {
  settingsStore.resetModelsPath();
  await refreshModels();
}

async function refreshModels() {
  loadingModels.value = true;
  debugError.value = null;
  debugFiles.value = [];

  try {
    await transcriptionStore.loadAvailableModels();
    await transcriptionStore.checkModel();

    // Check for bundled model
    try {
      bundledModelPath.value = await invoke<string | null>('get_bundled_model_info');
    } catch (e) {
      bundledModelPath.value = null;
    }

    // Debug: list files in custom directory
    const customPath = settingsStore.settings.modelsPath;
    if (customPath && customPath.trim() !== '') {
      try {
        debugFiles.value = await invoke<string[]>('debug_list_directory', { path: customPath });
      } catch (e) {
        debugError.value = String(e);
      }
    }
  } finally {
    loadingModels.value = false;
  }
}

async function downloadModel(model: { name: string; filename: string; downloadUrl: string }) {
  if (!model.downloadUrl) return;

  downloadingModel.value = model.name;
  downloadError.value = null;

  try {
    const customPath = settingsStore.settings.modelsPath || null;
    await invoke('download_model', {
      url: model.downloadUrl,
      filename: model.filename,
      customPath,
    });

    // Refresh models list after download
    await refreshModels();
  } catch (e) {
    console.error('Failed to download model:', e);
    downloadError.value = `Failed to download ${model.name}: ${e}`;
  } finally {
    downloadingModel.value = null;
  }
}

onMounted(async () => {
  refreshModels();
  try {
    defaultProjectFolder.value = await appLocalDataDir();
  } catch {
    defaultProjectFolder.value = '(app data directory)';
  }
});
</script>

<template>
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-gray-900 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h2 class="text-lg font-medium">Settings</h2>
        <button
          type="button"
          class="p-1 text-gray-400 hover:text-gray-200 transition-colors"
          @click="emit('close')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="px-6 py-4 space-y-6 overflow-y-auto flex-1">
        <!-- Playback -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Playback</h3>
          <div class="space-y-3">
            <Toggle
              :model-value="settingsStore.settings.loopByDefault"
              label="Loop by default"
              @update:model-value="settingsStore.setLoopByDefault"
            />
            <Toggle
              :model-value="settingsStore.settings.holdToPlay"
              label="Hold Space to play"
              @update:model-value="settingsStore.setHoldToPlay"
            />
            <p class="text-[10px] text-gray-500 -mt-2 ml-6">
              When enabled, release Space to stop. When disabled, Space toggles play/pause.
            </p>
            <Toggle
              :model-value="settingsStore.settings.reverseWithAudio"
              label="Reverse playback with audio"
              @update:model-value="settingsStore.setReverseWithAudio"
            />
            <p class="text-[10px] text-gray-500 -mt-2 ml-6">
              When enabled, holding Alt plays audio in reverse (uses more CPU).
            </p>
          </div>
        </div>

        <!-- Clipboard -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Clipboard</h3>
          <div class="space-y-3">
            <div class="flex items-center gap-4">
              <label class="text-xs text-gray-400">Copy region from:</label>
              <div class="flex gap-2">
                <label class="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="clipboardSource"
                    :checked="settingsStore.settings.clipboardUsesInOutPoints"
                    class="text-cyan-500"
                    @change="settingsStore.setClipboardUsesInOutPoints(true)"
                  />
                  <span class="text-gray-300">In/Out points</span>
                </label>
                <label class="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="clipboardSource"
                    :checked="!settingsStore.settings.clipboardUsesInOutPoints"
                    class="text-cyan-500"
                    @change="settingsStore.setClipboardUsesInOutPoints(false)"
                  />
                  <span class="text-gray-300">Selected track</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Project Folder -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Project Folder</h3>
          <div class="space-y-2">
            <div class="flex gap-2">
              <div class="flex-1 h-8 px-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 flex items-center overflow-hidden">
                <span class="truncate" :class="{ 'text-gray-500 italic': !settingsStore.settings.projectFolder }">
                  {{ settingsStore.settings.projectFolder || 'Using default location' }}
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                @click="settingsStore.browseProjectFolder()"
              >
                Browse
              </Button>
              <Button
                v-if="settingsStore.settings.projectFolder"
                variant="ghost"
                size="sm"
                @click="settingsStore.resetProjectFolder()"
              >
                Reset
              </Button>
            </div>
            <p class="text-[10px] text-gray-500">
              Recordings and project files are saved here.
              <template v-if="defaultProjectFolder"> Default: {{ defaultProjectFolder }}</template>
            </p>
          </div>
        </div>

        <!-- Recording -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Recording</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Default Source</label>
              <select
                :value="settingsStore.settings.defaultRecordingSource"
                class="w-full h-8 px-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                @change="settingsStore.setDefaultRecordingSource(($event.target as HTMLSelectElement).value as any)"
              >
                <option value="microphone">Microphone</option>
                <option value="system">System Audio</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Export Profiles -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Export Profiles</h3>
          <div class="space-y-2">
            <div
              v-for="profile in settingsStore.getExportProfiles()"
              :key="profile.id"
              class="flex items-center gap-2 py-1.5 px-2 bg-gray-800 rounded text-xs"
            >
              <!-- Favorite star -->
              <button
                type="button"
                class="text-sm leading-none"
                :class="profile.isFavorite ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300'"
                title="Set as Quick Re-Export default"
                @click="settingsStore.setFavoriteProfile(profile.id)"
              >
                {{ profile.isFavorite ? '\u2605' : '\u2606' }}
              </button>
              <!-- Profile info -->
              <span class="text-gray-200 flex-1">
                {{ profile.name }}
                <span class="text-gray-500 ml-1">
                  ({{ profile.format.toUpperCase() }}{{ profile.mp3Bitrate ? ` ${profile.mp3Bitrate}kbps` : '' }})
                </span>
              </span>
              <!-- Built-in badge or delete button -->
              <span v-if="profile.isDefault" class="text-[10px] text-gray-500">Built-in</span>
              <button
                v-else
                type="button"
                class="text-gray-500 hover:text-red-400 transition-colors p-0.5"
                title="Delete profile"
                @click="handleDeleteProfile(profile.id)"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- Add profile form -->
            <div v-if="showNewProfileForm" class="p-2 bg-gray-800 rounded border border-gray-700 space-y-2">
              <input
                v-model="newProfileName"
                type="text"
                placeholder="Profile name"
                class="w-full h-7 px-2 text-xs bg-gray-900 border border-gray-600 rounded text-gray-200
                       focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <div class="flex gap-2 flex-wrap">
                <label v-for="fmt in (['wav', 'mp3', 'flac', 'ogg'] as const)" :key="fmt" class="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="newProfileFormat"
                    :value="fmt"
                    :checked="newProfileFormat === fmt"
                    class="text-cyan-500"
                    @change="newProfileFormat = fmt"
                  />
                  <span class="text-gray-300">{{ fmt.toUpperCase() }}</span>
                </label>
              </div>
              <div v-if="newProfileFormat === 'mp3'" class="flex items-center gap-2">
                <input
                  v-model.number="newProfileBitrate"
                  type="number"
                  min="32"
                  max="320"
                  step="1"
                  class="w-20 px-2 py-0.5 text-xs bg-gray-800 border border-gray-600 rounded text-gray-200 focus:border-cyan-500 focus:outline-none"
                />
                <span class="text-[10px] text-gray-500">kbps</span>
                <button
                  v-for="br in [96, 128, 192, 256, 320]"
                  :key="br"
                  type="button"
                  :class="[
                    'px-1.5 py-0.5 text-[10px] rounded transition-colors',
                    newProfileBitrate === br
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  ]"
                  @click="newProfileBitrate = br"
                >
                  {{ br }}
                </button>
              </div>
              <div class="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" @click="showNewProfileForm = false">Cancel</Button>
                <Button variant="primary" size="sm" :disabled="!newProfileName.trim()" @click="handleAddProfile">Save</Button>
              </div>
            </div>

            <Button
              v-if="!showNewProfileForm"
              variant="ghost"
              size="sm"
              class="w-full"
              @click="showNewProfileForm = true"
            >
              + Add Profile
            </Button>

            <p class="text-[10px] text-gray-500">
              <span class="text-yellow-400/70">\u2605</span> = default for Quick Re-Export (Ctrl+Shift+E).
              Built-in profiles can't be deleted.
            </p>
          </div>
        </div>

        <!-- Transcription -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Transcription</h3>
          <div class="space-y-3">
            <Toggle
              :model-value="settingsStore.settings.showTranscription"
              label="Show transcription"
              @update:model-value="settingsStore.setShowTranscription"
            />
            <Toggle
              :model-value="settingsStore.settings.autoTranscribe"
              label="Auto-transcribe on import"
              @update:model-value="settingsStore.setAutoTranscribe"
            />

            <div>
              <label class="block text-xs text-gray-400 mb-1">
                Auto-navigate after words: {{ settingsStore.settings.autoNavigateAfterWords }}
              </label>
              <Slider
                :model-value="settingsStore.settings.autoNavigateAfterWords"
                :min="1"
                :max="10"
                :step="1"
                @update:model-value="settingsStore.setAutoNavigateAfterWords"
              />
            </div>

            <div>
              <label class="block text-xs text-gray-400 mb-1">ASR Model</label>
              <select
                :value="settingsStore.settings.asrModel"
                class="w-full h-8 px-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                @change="settingsStore.setASRModel(($event.target as HTMLSelectElement).value as any)"
              >
                <option value="whisper-tiny">Whisper Tiny (Fastest)</option>
                <option value="whisper-base">Whisper Base (Better)</option>
                <option value="vosk">Vosk (Offline)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Models -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Models</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Models Directory</label>
              <div class="flex gap-2">
                <div class="flex-1 h-8 px-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 flex items-center overflow-hidden">
                  <span class="truncate" :class="{ 'text-gray-500 italic': !hasCustomPath }">
                    {{ displayPath }}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  @click="handleBrowseModelsPath"
                >
                  Browse
                </Button>
                <Button
                  v-if="hasCustomPath"
                  variant="ghost"
                  size="sm"
                  @click="handleResetModelsPath"
                >
                  Reset
                </Button>
              </div>
              <p class="text-xs text-gray-500 mt-1">
                <template v-if="defaultProjectFolder">Default: {{ defaultModelsPath }}</template>
                <template v-else>Default: app data directory</template>
              </p>
            </div>

            <!-- Bundled model status -->
            <div v-if="bundledModelPath" class="p-2 bg-green-900/20 border border-green-700/50 rounded">
              <div class="flex items-center gap-2 text-xs">
                <span class="text-green-400">Bundled Model</span>
                <span class="text-gray-400">tiny (~75MB)</span>
              </div>
              <p class="text-[10px] text-gray-500 mt-1 truncate" :title="bundledModelPath">
                {{ bundledModelPath }}
              </p>
            </div>

            <div>
              <label class="block text-xs text-gray-400 mb-2">Available Models</label>
              <div v-if="loadingModels" class="text-xs text-gray-500 italic">
                Loading models...
              </div>
              <div v-else-if="transcriptionStore.availableModels.length === 0 && !bundledModelPath" class="text-xs text-gray-500 italic">
                No models configured
              </div>
              <div v-else class="space-y-1 max-h-32 overflow-y-auto">
                <div
                  v-for="model in transcriptionStore.availableModels"
                  :key="model.name"
                  class="flex items-center justify-between text-xs py-1 px-2 bg-gray-800 rounded"
                >
                  <span class="flex items-center gap-2">
                    <span v-if="model.available" class="text-green-400">●</span>
                    <span v-else class="text-gray-600">○</span>
                    <span :class="model.available ? 'text-gray-200' : 'text-gray-500'">
                      {{ model.name }} ({{ model.sizeMb }} MB)
                    </span>
                  </span>
                  <span v-if="model.available" class="text-green-400 text-xs">
                    Found
                  </span>
                  <button
                    v-else-if="downloadingModel === model.name"
                    class="text-yellow-400 text-xs"
                    disabled
                  >
                    Downloading...
                  </button>
                  <button
                    v-else
                    class="text-cyan-400 hover:text-cyan-300 hover:underline"
                    @click="downloadModel(model)"
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>

            <!-- Download error -->
            <div v-if="downloadError" class="mt-2 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
              {{ downloadError }}
            </div>

            <!-- Debug: Files in directory -->
            <div v-if="hasCustomPath" class="mt-2 p-2 bg-gray-800/50 rounded border border-gray-700">
              <label class="block text-xs text-gray-500 mb-1">Files in directory:</label>
              <div v-if="debugError" class="text-xs text-red-400">
                Error: {{ debugError }}
              </div>
              <div v-else-if="debugFiles.length === 0" class="text-xs text-gray-500 italic">
                No files found (or directory empty)
              </div>
              <div v-else class="text-xs text-gray-400 max-h-24 overflow-y-auto font-mono">
                <div v-for="file in debugFiles" :key="file" class="py-0.5">
                  {{ file }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Bar Shortcuts -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Bottom Bar Shortcuts</h3>
          <div class="space-y-2">
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="hint in ALL_SHORTCUT_HINTS"
                :key="hint.id"
                type="button"
                class="px-2 py-1 text-xs rounded transition-colors"
                :class="settingsStore.settings.shortcutHints.includes(hint.id)
                  ? 'bg-cyan-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'"
                @click="toggleHint(hint.id)"
              >
                {{ hint.keys }} {{ hint.label }}
              </button>
            </div>
            <div class="flex items-center justify-between">
              <p class="text-[10px] text-gray-500">
                Toggle which shortcuts appear in the bottom bar. Press <kbd class="px-1 py-0.5 bg-gray-700 text-gray-300 rounded">?</kbd> to see all.
              </p>
              <Button
                variant="ghost"
                size="sm"
                @click="resetHints"
              >
                Reset
              </Button>
            </div>
          </div>
        </div>

        <!-- Appearance -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Appearance</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Waveform Color</label>
              <input
                type="color"
                :value="settingsStore.settings.waveformColor"
                class="w-full h-8 bg-gray-800 border border-gray-700 rounded cursor-pointer"
                @input="settingsStore.setWaveformColor(($event.target as HTMLInputElement).value)"
              />
            </div>

            <div>
              <label class="block text-xs text-gray-400 mb-1">Playhead Color</label>
              <input
                type="color"
                :value="settingsStore.settings.playheadColor"
                class="w-full h-8 bg-gray-800 border border-gray-700 rounded cursor-pointer"
                @input="settingsStore.setPlayheadColor(($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
        </div>

        <!-- Logging -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Logging</h3>
          <LoggingPanel />
        </div>

        <!-- About -->
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">About</h3>
          <AboutPanel
            app-name="Clip Dr."
            :app-version="APP_VERSION"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 px-4 py-3 border-t border-gray-800">
        <Button
          variant="ghost"
          size="sm"
          @click="settingsStore.resetSettings()"
        >
          Reset to Defaults
        </Button>
        <Button
          variant="primary"
          size="sm"
          @click="emit('close')"
        >
          Done
        </Button>
      </div>
    </div>
  </div>
</template>
