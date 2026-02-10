import { defineStore } from 'pinia';
import { ref } from 'vue';
import { open } from '@tauri-apps/plugin-dialog';
import { appLocalDataDir } from '@tauri-apps/api/path';
import type { Settings, ASRModel, RecordingSource, Mp3Bitrate } from '@/shared/types';
import { DEFAULT_SETTINGS } from '@/shared/constants';

const STORAGE_KEY = 'clip-doctor-settings';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS });

  function loadSettings(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        settings.value = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  function saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  function setLoopByDefault(enabled: boolean): void {
    settings.value.loopByDefault = enabled;
    saveSettings();
  }

  function setAutoNavigateAfterWords(count: number): void {
    settings.value.autoNavigateAfterWords = Math.max(1, Math.min(10, count));
    saveSettings();
  }

  function setWaveformColor(color: string): void {
    settings.value.waveformColor = color;
    saveSettings();
  }

  function setPlayheadColor(color: string): void {
    settings.value.playheadColor = color;
    saveSettings();
  }

  function setSelectionColor(color: string): void {
    settings.value.selectionColor = color;
    saveSettings();
  }

  function setShowTranscription(show: boolean): void {
    settings.value.showTranscription = show;
    saveSettings();
  }

  function setASRModel(model: ASRModel): void {
    settings.value.asrModel = model;
    saveSettings();
  }

  function setModelsPath(path: string): void {
    settings.value.modelsPath = path;
    saveSettings();
  }

  async function browseModelsPath(): Promise<string | null> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Models Directory',
      });

      if (selected && typeof selected === 'string') {
        setModelsPath(selected);
        return selected;
      }
      return null;
    } catch (e) {
      console.error('Failed to browse for models path:', e);
      return null;
    }
  }

  function resetModelsPath(): void {
    settings.value.modelsPath = '';
    saveSettings();
  }

  function setLastImportFolder(path: string): void {
    // Extract directory from file path
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const folder = lastSlash > 0 ? path.substring(0, lastSlash) : path;
    settings.value.lastImportFolder = folder;
    saveSettings();
  }

  function setLastExportFolder(path: string): void {
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const folder = lastSlash > 0 ? path.substring(0, lastSlash) : path;
    settings.value.lastExportFolder = folder;
    saveSettings();
  }

  function resetSettings(): void {
    settings.value = { ...DEFAULT_SETTINGS };
    saveSettings();
  }

  // New settings functions
  function setHoldToPlay(enabled: boolean): void {
    settings.value.holdToPlay = enabled;
    saveSettings();
  }

  function setReverseWithAudio(enabled: boolean): void {
    settings.value.reverseWithAudio = enabled;
    saveSettings();
  }

  function setClipboardUsesInOutPoints(useInOut: boolean): void {
    settings.value.clipboardUsesInOutPoints = useInOut;
    saveSettings();
  }

  function setDefaultRecordingSource(source: RecordingSource): void {
    settings.value.defaultRecordingSource = source;
    saveSettings();
  }

  function setDefaultMp3Bitrate(bitrate: Mp3Bitrate): void {
    settings.value.defaultMp3Bitrate = bitrate;
    saveSettings();
  }

  function setProjectFolder(path: string): void {
    settings.value.projectFolder = path;
    saveSettings();
  }

  async function browseProjectFolder(): Promise<string | null> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Project Folder',
        defaultPath: settings.value.projectFolder || undefined,
      });

      if (selected && typeof selected === 'string') {
        setProjectFolder(selected);
        return selected;
      }
      return null;
    } catch (e) {
      console.error('Failed to browse for project folder:', e);
      return null;
    }
  }

  function resetProjectFolder(): void {
    settings.value.projectFolder = '';
    saveSettings();
  }

  /** Get the resolved project folder path (custom or app data dir) */
  async function getProjectFolder(): Promise<string> {
    const custom = settings.value.projectFolder;
    if (custom && custom.trim() !== '') {
      return custom;
    }
    // Default: app local data dir (~/.local/share/com.niche-knack.clip-dr/)
    try {
      return await appLocalDataDir();
    } catch (e) {
      console.warn('[Settings] Failed to get app data dir, using /tmp:', e);
      return '/tmp';
    }
  }

  loadSettings();

  return {
    settings,
    setLoopByDefault,
    setAutoNavigateAfterWords,
    setWaveformColor,
    setPlayheadColor,
    setSelectionColor,
    setShowTranscription,
    setASRModel,
    setModelsPath,
    browseModelsPath,
    resetModelsPath,
    setLastImportFolder,
    setLastExportFolder,
    resetSettings,
    // New settings
    setHoldToPlay,
    setReverseWithAudio,
    setClipboardUsesInOutPoints,
    setDefaultRecordingSource,
    setDefaultMp3Bitrate,
    // Project folder
    setProjectFolder,
    browseProjectFolder,
    resetProjectFolder,
    getProjectFolder,
  };
});
