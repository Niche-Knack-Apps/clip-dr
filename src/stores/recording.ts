import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import type { TrackPlacement, TimeMark } from '@/shared/types';
import { generateId } from '@/shared/utils';

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
  is_input: boolean;
  is_loopback: boolean;
  /** Whether this is an output device */
  is_output: boolean;
  /** Device type: "microphone", "loopback", "output", "virtual" */
  device_type: string;
  /** Number of channels supported */
  channels: number;
  /** Supported sample rates */
  sample_rates: number[];
  /** Platform-specific identifier */
  platform_id: string;
}

export interface DeviceCapabilities {
  device_id: string;
  device_name: string;
  is_input: boolean;
  is_output: boolean;
  configs: DeviceConfig[];
}

export interface DeviceConfig {
  channels: number;
  sample_format: string;
  min_sample_rate: number;
  max_sample_rate: number;
}

export interface RecordingResult {
  path: string;
  duration: number;
  sample_rate: number;
  channels: number;
  /** Additional segment paths when recording was split (excludes `path` which is segment 1) */
  extra_segments: string[];
}

export interface RecordingSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  active: boolean;
  level: number;
  path: string | null;
  startTime: number;
  duration: number;
}

export type RecordingSource = 'microphone' | 'system';

export interface SystemAudioInfo {
  available: boolean;
  method: string;
  monitor_source: string | null;
  sink_name: string | null;
  test_result: string | null;
  cpal_monitor_device: string | null;
}

export const useRecordingStore = defineStore('recording', () => {
  const audioStore = useAudioStore();
  const tracksStore = useTracksStore();
  const settingsStore = useSettingsStore();

  const isRecording = ref(false);
  const isPreparing = ref(false);
  const isMonitoring = ref(false);
  const currentLevel = ref(0);
  const recordingDuration = ref(0);
  const recordingPath = ref<string | null>(null);
  const devices = ref<AudioDevice[]>([]);
  const selectedDeviceId = ref<string | null>(null);
  const source = ref<RecordingSource>('microphone');
  const error = ref<string | null>(null);
  const isMuted = ref(false);
  const isLocked = ref(false);

  // Session tracking (Phase 4: per-stream architecture, single-session for now)
  const sessions = ref<RecordingSession[]>([]);

  const activeSessions = computed(() =>
    sessions.value.filter(s => s.active)
  );

  // Timemark state
  const timemarks = ref<TimeMark[]>([]);
  const triggerPhrases = ref<string[]>([]);
  let timemarkCounter = 0;

  // System audio probe result
  const systemAudioInfo = ref<SystemAudioInfo | null>(null);
  const systemAudioProbing = ref(false);

  // Track placement setting: where new recordings appear on timeline
  const placement = ref<TrackPlacement>('append');

  let levelPollInterval: number | null = null;
  let monitorPollInterval: number | null = null;
  let durationInterval: number | null = null;
  let recordingStartTime = 0;

  // Device preview state
  const previewLevel = ref(0);
  const previewDeviceId = ref<string | null>(null);
  let previewPollInterval: number | null = null;

  // All devices ref (includes both input and output)
  const allDevices = ref<AudioDevice[]>([]);

  const microphoneDevices = computed(() =>
    devices.value.filter(d => d.is_input && !d.is_loopback)
  );

  const loopbackDevices = computed(() =>
    devices.value.filter(d => d.is_loopback)
  );

  const outputDevices = computed(() =>
    allDevices.value.filter(d => d.is_output)
  );

  const selectedDevice = computed(() =>
    devices.value.find(d => d.id === selectedDeviceId.value) || null
  );

  const defaultDevice = computed(() =>
    devices.value.find(d => d.is_default) || devices.value[0] || null
  );

  async function refreshDevices(): Promise<void> {
    try {
      devices.value = await invoke<AudioDevice[]>('list_audio_devices');
      console.log('[Recording] Found devices:', devices.value);

      if (!selectedDeviceId.value && defaultDevice.value) {
        selectedDeviceId.value = defaultDevice.value.id;
      }
    } catch (e) {
      console.error('[Recording] Failed to list devices:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** Refresh all devices (inputs + outputs) for the full device picker */
  async function refreshAllDevices(): Promise<void> {
    try {
      allDevices.value = await invoke<AudioDevice[]>('list_all_audio_devices');
      // Also update the input-only devices list (backward compat)
      devices.value = allDevices.value.filter(d => d.is_input);
      console.log('[Recording] Found all devices:', allDevices.value.length,
        '(input:', devices.value.length, 'output:', outputDevices.value.length, ')');

      if (!selectedDeviceId.value && defaultDevice.value) {
        selectedDeviceId.value = defaultDevice.value.id;
      }
    } catch (e) {
      console.error('[Recording] Failed to list all devices:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** Get detailed capabilities for a specific device */
  async function getDeviceCapabilities(deviceId: string): Promise<DeviceCapabilities | null> {
    try {
      return await invoke<DeviceCapabilities>('get_device_capabilities', { deviceId });
    } catch (e) {
      console.error('[Recording] Failed to get device capabilities:', e);
      return null;
    }
  }

  /** Start previewing a device's audio level (for VU meter in device picker) */
  async function startDevicePreview(deviceId: string): Promise<void> {
    // Stop any existing preview first
    if (previewDeviceId.value) {
      await stopDevicePreview();
    }

    try {
      await invoke('start_device_preview', { deviceId });
      previewDeviceId.value = deviceId;

      previewPollInterval = window.setInterval(async () => {
        try {
          previewLevel.value = await invoke<number>('get_device_preview_level');
        } catch {
          // Ignore polling errors
        }
      }, 100);
    } catch (e) {
      console.error('[Recording] Failed to start device preview:', e);
    }
  }

  /** Stop the current device preview */
  async function stopDevicePreview(): Promise<void> {
    if (previewPollInterval) {
      clearInterval(previewPollInterval);
      previewPollInterval = null;
    }
    previewDeviceId.value = null;
    previewLevel.value = 0;

    try {
      await invoke('stop_device_preview');
    } catch {
      // Ignore errors when stopping
    }
  }

  function selectDevice(deviceId: string): void {
    selectedDeviceId.value = deviceId;
  }

  async function setSource(newSource: RecordingSource): Promise<void> {
    source.value = newSource;
    error.value = null;

    if (newSource === 'microphone') {
      const mic = microphoneDevices.value.find(d => d.is_default) || microphoneDevices.value[0];
      if (mic) selectedDeviceId.value = mic.id;
      systemAudioInfo.value = null;
    } else {
      await probeSystemAudio();

      if (systemAudioInfo.value?.cpal_monitor_device) {
        selectedDeviceId.value = systemAudioInfo.value.cpal_monitor_device;
        console.log('[Recording] Using CPAL monitor device:', selectedDeviceId.value);
      } else {
        selectedDeviceId.value = null;
        console.log('[Recording] Using subprocess recording, no CPAL device');
      }
    }
  }

  async function probeSystemAudio(): Promise<SystemAudioInfo | null> {
    try {
      systemAudioProbing.value = true;
      console.log('[Recording] Probing system audio capabilities...');

      const info = await invoke<SystemAudioInfo>('probe_system_audio');
      systemAudioInfo.value = info;

      console.log(`[Recording] System audio probe: available=${info.available}, method=${info.method || 'none'}`);

      if (!info.available) {
        error.value = `System audio not available: ${info.test_result || 'Unknown reason'}`;
      }

      return info;
    } catch (e) {
      console.error('[Recording] Failed to probe system audio:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      systemAudioProbing.value = false;
    }
  }

  function lockRecording(): void {
    if (isRecording.value) {
      isLocked.value = true;
    }
  }

  function unlockRecording(): void {
    isLocked.value = false;
  }

  // Timemark actions
  function addTimemark(label?: string, source: 'manual' | 'auto' = 'manual', atTime?: number): void {
    if (!isRecording.value) return;
    timemarkCounter++;
    const mark: TimeMark = {
      id: generateId(),
      time: atTime ?? recordingDuration.value,
      label: label || `Mark ${timemarkCounter}`,
      source,
      color: source === 'manual' ? '#00d4ff' : '#fbbf24',
    };
    timemarks.value = [...timemarks.value, mark];
    console.log('[Recording] Added timemark:', mark.label, 'at', mark.time.toFixed(2) + 's');
  }

  function removeTimemark(id: string): void {
    timemarks.value = timemarks.value.filter(m => m.id !== id);
  }

  function clearTimemarks(): void {
    timemarks.value = [];
    timemarkCounter = 0;
  }

  function setTriggerPhrases(phrases: string[]): void {
    triggerPhrases.value = phrases;
  }

  function setPlacement(newPlacement: TrackPlacement): void {
    placement.value = newPlacement;
  }

  async function quickStart(quickSource: 'microphone' | 'system'): Promise<void> {
    if (isRecording.value || isPreparing.value) return;

    error.value = null;

    // Set the source and configure device
    await setSource(quickSource);

    // For system audio, check if probe succeeded
    if (quickSource === 'system' && systemAudioInfo.value && !systemAudioInfo.value.available) {
      // error is already set by setSource -> probeSystemAudio
      return;
    }

    // For microphone, ensure we have a device selected
    if (quickSource === 'microphone' && !selectedDeviceId.value) {
      const mic = microphoneDevices.value.find(d => d.is_default) || microphoneDevices.value[0];
      if (mic) {
        selectedDeviceId.value = mic.id;
      } else {
        error.value = 'No microphone device found';
        return;
      }
    }

    // Save the choice to settings
    settingsStore.setLastRecordingSource(quickSource);

    // Stop monitoring if active (startRecording also does this, but be explicit)
    if (isMonitoring.value) {
      await stopMonitoring();
    }

    // Immediately start recording
    await startRecording();
  }

  async function quickStartLastUsed(): Promise<void> {
    const lastSource = settingsStore.settings.lastRecordingSource;
    await quickStart(lastSource);
  }

  async function startRecording(): Promise<void> {
    if (isRecording.value) return;

    error.value = null;
    isPreparing.value = true;
    clearTimemarks();

    const isSystemSubprocess = source.value === 'system' &&
      systemAudioInfo.value?.method !== 'cpal-monitor';

    if (isMonitoring.value && !isSystemSubprocess) {
      await stopMonitoring();
    }

    try {
      const outputDir = await settingsStore.getProjectFolder();
      const isSystemAudio = source.value === 'system';

      console.log('[Recording] Start recording:', {
        source: source.value,
        isSystemAudio,
        selectedDevice: selectedDeviceId.value,
      });

      if (isSystemAudio) {
        recordingPath.value = await invoke<string>('start_system_audio_recording', {
          outputDir,
          channelMode: settingsStore.settings.recordingChannelMode,
          largeFileFormat: settingsStore.settings.recordingLargeFileFormat,
        });
        console.log('[Recording] Started system audio recording, output:', recordingPath.value);
      } else {
        recordingPath.value = await invoke<string>('start_recording', {
          deviceId: selectedDeviceId.value,
          outputDir,
          channelMode: settingsStore.settings.recordingChannelMode,
          largeFileFormat: settingsStore.settings.recordingLargeFileFormat,
        });
        console.log('[Recording] Started, output:', recordingPath.value);
      }

      isRecording.value = true;
      recordingStartTime = Date.now();
      recordingDuration.value = 0;

      // Track as a session
      const session: RecordingSession = {
        sessionId: 'default',
        deviceId: selectedDeviceId.value || '',
        deviceName: selectedDevice.value?.name || (isSystemAudio ? 'System Audio' : 'Microphone'),
        active: true,
        level: 0,
        path: recordingPath.value,
        startTime: recordingStartTime,
        duration: 0,
      };
      sessions.value = [session];

      // Start polling level (100ms = 10Hz, sufficient for visual meter)
      levelPollInterval = window.setInterval(async () => {
        try {
          currentLevel.value = await invoke<number>('get_recording_level');
          // Sync session level
          if (sessions.value.length > 0) {
            sessions.value[0].level = currentLevel.value;
          }
        } catch (e) {
          // Ignore polling errors
        }
      }, 100);

      // Start duration counter
      durationInterval = window.setInterval(() => {
        recordingDuration.value = (Date.now() - recordingStartTime) / 1000;
        // Sync session duration
        if (sessions.value.length > 0) {
          sessions.value[0].duration = recordingDuration.value;
        }
      }, 100);

    } catch (e) {
      // Clean up intervals if recording failed to start
      if (levelPollInterval) {
        clearInterval(levelPollInterval);
        levelPollInterval = null;
      }
      if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
      }
      console.error('[Recording] Failed to start:', e);
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      isPreparing.value = false;
    }
  }

  async function stopRecording(): Promise<RecordingResult | null> {
    if (!isRecording.value) return null;

    // Stop polling
    if (levelPollInterval) {
      clearInterval(levelPollInterval);
      levelPollInterval = null;
    }
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }

    try {
      const wasSystemAudio = source.value === 'system';
      const wasUsingSubprocess = wasSystemAudio &&
        systemAudioInfo.value?.method !== 'cpal-monitor';

      let result: RecordingResult;
      if (wasUsingSubprocess) {
        result = await invoke<RecordingResult>('stop_system_audio_recording');
      } else {
        result = await invoke<RecordingResult>('stop_recording');
      }

      isRecording.value = false;
      isLocked.value = false;
      currentLevel.value = 0;
      sessions.value = [];

      console.log(`[Recording] Stopped: path=${result.path}, duration=${result.duration?.toFixed(1)}s, rate=${result.sample_rate}, ch=${result.channels}, extra_segments=${result.extra_segments?.length ?? 0}`);

      // Brief delay to let OS flush file writes
      await new Promise(r => setTimeout(r, 200));

      // Create track(s) from the recorded audio (fire-and-forget so dialog closes immediately)
      if (result.path) {
        createTrackFromRecording(result).catch(e => {
          console.error('[Recording] Background import failed:', e);
          error.value = e instanceof Error ? e.message : String(e);
        });
      }

      return result;
    } catch (e) {
      console.error('[Recording] Failed to stop:', e);
      error.value = e instanceof Error ? e.message : String(e);
      isRecording.value = false;
      isLocked.value = false;
      return null;
    }
  }

  // Create track(s) from recorded audio file(s) using the progressive import pipeline
  async function createTrackFromRecording(result: RecordingResult): Promise<void> {
    try {
      const allPaths = [result.path, ...(result.extra_segments || [])];
      const segmentCount = allPaths.length;
      const savedTimemarks = timemarks.value.length > 0 ? [...timemarks.value] : null;
      const recordingNumber = tracksStore.tracks.length + 1;

      console.log(`[Recording] Importing ${segmentCount} segment(s) via progressive pipeline...`);

      for (let i = 0; i < allPaths.length; i++) {
        const segPath = allPaths[i];
        const trackCountBefore = tracksStore.tracks.length;

        // Use the progressive import pipeline (3-phase: metadata, waveform, browser decode)
        await audioStore.importFile(segPath);

        // Find the newly created track (last track added)
        if (tracksStore.tracks.length > trackCountBefore) {
          const newTrack = tracksStore.tracks[tracksStore.tracks.length - 1];
          const name = segmentCount > 1
            ? `Recording ${recordingNumber} (${i + 1}/${segmentCount})`
            : `Recording ${recordingNumber}`;
          tracksStore.renameTrack(newTrack.id, name);

          // Transfer timemarks to the first segment's track
          if (i === 0 && savedTimemarks) {
            newTrack.timemarks = savedTimemarks;
            console.log('[Recording] Transferred', savedTimemarks.length, 'timemarks to track');
          }

          // Register trigger phrases for post-transcription auto-marks (first segment only)
          if (i === 0 && triggerPhrases.value.length > 0) {
            const transcriptionStore = useTranscriptionStore();
            transcriptionStore.registerPendingTriggerPhrases(newTrack.id, [...triggerPhrases.value]);
          }

          console.log(`[Recording] Created track via import: ${newTrack.name} id: ${newTrack.id}`);
        }
      }
    } catch (e) {
      console.error('[Recording] Failed to create track:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function cancelRecording(): Promise<void> {
    if (!isRecording.value) return;

    // Stop polling
    if (levelPollInterval) {
      clearInterval(levelPollInterval);
      levelPollInterval = null;
    }
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }

    try {
      if (source.value === 'system') {
        try {
          await invoke<RecordingResult>('stop_system_audio_recording');
        } catch {
          // Ignore errors when cancelling
        }
      } else {
        await invoke('cancel_recording');
      }
      isRecording.value = false;
      isLocked.value = false;
      currentLevel.value = 0;
      recordingDuration.value = 0;
      recordingPath.value = null;
      sessions.value = [];
      console.log('[Recording] Cancelled');
    } catch (e) {
      console.error('[Recording] Failed to cancel:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  // Check if input is muted (Linux only)
  async function checkMuted(): Promise<boolean> {
    try {
      const muted = await invoke<boolean>('check_input_muted');
      isMuted.value = muted;
      return muted;
    } catch (e) {
      return false;
    }
  }

  // Unmute the input (Linux only)
  async function unmute(): Promise<boolean> {
    try {
      await invoke('unmute_input');
      isMuted.value = false;
      console.log('[Recording] Input unmuted');
      return true;
    } catch (e) {
      console.error('[Recording] Failed to unmute:', e);
      return false;
    }
  }

  // Track whether monitoring is using system audio (pw-record) or CPAL
  let monitoringIsSystemAudio = false;

  async function startMonitoring(): Promise<void> {
    if (isMonitoring.value || isRecording.value) return;

    error.value = null;

    const useSystemAudioMonitoring = source.value === 'system' &&
      systemAudioInfo.value?.available &&
      !systemAudioInfo.value?.cpal_monitor_device;

    try {
      if (useSystemAudioMonitoring) {
        await invoke('start_system_audio_monitoring');
        monitoringIsSystemAudio = true;
        console.log('[Recording] System audio monitoring started (pw-record)');
      } else {
        await checkMuted();
        await invoke('start_monitoring', {
          deviceId: selectedDeviceId.value,
        });
        monitoringIsSystemAudio = false;
        console.log('[Recording] CPAL monitoring started');
      }

      isMonitoring.value = true;

      monitorPollInterval = window.setInterval(async () => {
        try {
          currentLevel.value = await invoke<number>('get_recording_level');
        } catch (e) {
          // Ignore polling errors
        }
      }, 100);
    } catch (e) {
      console.error('[Recording] Failed to start monitoring:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function stopMonitoring(): Promise<void> {
    if (!isMonitoring.value) return;

    if (monitorPollInterval) {
      clearInterval(monitorPollInterval);
      monitorPollInterval = null;
    }

    try {
      if (monitoringIsSystemAudio) {
        await invoke('stop_system_audio_monitoring');
      } else {
        await invoke('stop_monitoring');
      }
      isMonitoring.value = false;
      monitoringIsSystemAudio = false;
      currentLevel.value = 0;
      console.log('[Recording] Monitoring stopped');
    } catch (e) {
      console.error('[Recording] Failed to stop monitoring:', e);
    }
  }

  // Initialize devices on store creation
  refreshDevices();

  return {
    isRecording,
    isPreparing,
    isMonitoring,
    currentLevel,
    recordingDuration,
    recordingPath,
    devices,
    selectedDeviceId,
    source,
    error,
    placement,
    isMuted,
    isLocked,
    // Timemarks
    timemarks,
    triggerPhrases,
    microphoneDevices,
    loopbackDevices,
    outputDevices,
    allDevices,
    selectedDevice,
    defaultDevice,
    // Sessions (Phase 4: per-stream architecture)
    sessions,
    activeSessions,
    // System audio
    systemAudioInfo,
    systemAudioProbing,
    previewLevel,
    previewDeviceId,
    refreshDevices,
    refreshAllDevices,
    getDeviceCapabilities,
    startDevicePreview,
    stopDevicePreview,
    selectDevice,
    setSource,
    setPlacement,
    probeSystemAudio,
    lockRecording,
    unlockRecording,
    // Timemark actions
    addTimemark,
    removeTimemark,
    clearTimemarks,
    setTriggerPhrases,
    quickStart,
    quickStartLastUsed,
    startRecording,
    stopRecording,
    cancelRecording,
    startMonitoring,
    stopMonitoring,
    checkMuted,
    unmute,
  };
});
