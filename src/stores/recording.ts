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
  /** Seconds of pre-record buffer audio prepended to the recording */
  pre_record_seconds: number;
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

export interface SessionConfig {
  device_id: string;
  channel_mode: string | null;
  large_file_format: string | null;
}

export interface SessionResult {
  session_id: string;
  device_id: string;
  result: RecordingResult;
  start_offset_us: number;
}

export interface SessionLevel {
  session_id: string;
  device_id: string;
  level: number;
}

export interface PreviewLevel {
  device_id: string;
  level: number;
}

export interface OrphanedRecording {
  path: string;
  size_bytes: number;
  header_ok: boolean;
  estimated_duration: number;
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
  /** Multi-select mode: multiple device IDs selected for simultaneous recording */
  const selectedDeviceIds = ref<string[]>([]);
  /** Whether multi-source recording mode is active */
  const multiSourceMode = ref(false);
  const source = ref<RecordingSource>('microphone');
  const error = ref<string | null>(null);
  const isMuted = ref(false);
  const isLocked = ref(false);

  // Session tracking (Phase 4: per-stream architecture, single-session for now)
  const sessions = ref<RecordingSession[]>([]);

  // Multi-source timeline sync: epoch tracks when the first session started
  const recordingEpoch = ref<number | null>(null);
  const recordingBasePosition = ref<number | null>(null);

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

  // Device preview state (single)
  const previewLevel = ref(0);
  const previewDeviceId = ref<string | null>(null);
  let previewPollInterval: number | null = null;

  // Multi-device preview levels (device_id → level)
  const previewLevels = ref<Map<string, number>>(new Map());
  let multiPreviewPollInterval: number | null = null;

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
  async function createTrackFromRecording(result: RecordingResult, trackStart?: number): Promise<void> {
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
        // First segment uses computed trackStart; extras increment by segment duration
        const segTrackStart = (i === 0) ? trackStart : undefined;
        await audioStore.importFile(segPath, segTrackStart);

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

  // ── Multi-source recording ──

  function toggleDeviceSelection(deviceId: string): void {
    const idx = selectedDeviceIds.value.indexOf(deviceId);
    if (idx >= 0) {
      selectedDeviceIds.value = selectedDeviceIds.value.filter(id => id !== deviceId);
    } else {
      selectedDeviceIds.value = [...selectedDeviceIds.value, deviceId];
    }
  }

  function setMultiSourceMode(enabled: boolean): void {
    multiSourceMode.value = enabled;
    if (!enabled) {
      selectedDeviceIds.value = [];
    }
  }

  async function startMultiRecording(): Promise<void> {
    if (isRecording.value || isPreparing.value) return;
    if (selectedDeviceIds.value.length === 0) {
      error.value = 'No devices selected for multi-source recording';
      return;
    }

    error.value = null;
    isPreparing.value = true;
    clearTimemarks();

    if (isMonitoring.value) {
      await stopMonitoring();
    }

    try {
      const outputDir = await settingsStore.getProjectFolder();
      const configs: SessionConfig[] = selectedDeviceIds.value.map(deviceId => ({
        device_id: deviceId,
        channel_mode: settingsStore.settings.recordingChannelMode,
        large_file_format: settingsStore.settings.recordingLargeFileFormat,
      }));

      console.log('[Recording] Starting multi-source recording:', configs.length, 'devices');

      const sessionIds = await invoke<string[]>('start_multi_recording', {
        configs,
        outputDir,
      });

      isRecording.value = true;
      recordingStartTime = Date.now();
      recordingDuration.value = 0;

      // Build session tracking
      sessions.value = sessionIds.map((sessionId, idx) => ({
        sessionId,
        deviceId: selectedDeviceIds.value[idx],
        deviceName: devices.value.find(d => d.id === selectedDeviceIds.value[idx])?.name || selectedDeviceIds.value[idx],
        active: true,
        level: 0,
        path: null,
        startTime: recordingStartTime,
        duration: 0,
      }));

      // Poll per-session levels
      levelPollInterval = window.setInterval(async () => {
        try {
          const levels = await invoke<SessionLevel[]>('get_session_levels');
          for (const sl of levels) {
            const session = sessions.value.find(s => s.sessionId === sl.session_id);
            if (session) session.level = sl.level;
          }
          // Update shared level to max of all sessions
          currentLevel.value = levels.length > 0
            ? Math.max(...levels.map(l => l.level))
            : 0;
        } catch {
          // Ignore polling errors
        }
      }, 100);

      durationInterval = window.setInterval(() => {
        recordingDuration.value = (Date.now() - recordingStartTime) / 1000;
        for (const s of sessions.value) {
          s.duration = recordingDuration.value;
        }
      }, 100);

      console.log('[Recording] Multi-source started:', sessionIds);
    } catch (e) {
      if (levelPollInterval) { clearInterval(levelPollInterval); levelPollInterval = null; }
      if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }
      console.error('[Recording] Failed to start multi-source:', e);
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      isPreparing.value = false;
    }
  }

  async function stopMultiRecording(): Promise<SessionResult[] | null> {
    if (!isRecording.value) return null;

    if (levelPollInterval) { clearInterval(levelPollInterval); levelPollInterval = null; }
    if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }

    try {
      const results = await invoke<SessionResult[]>('stop_all_recordings');

      isRecording.value = false;
      isLocked.value = false;
      currentLevel.value = 0;
      sessions.value = [];

      console.log('[Recording] Multi-source stopped:', results.length, 'sessions');

      // Brief delay for OS file flush
      await new Promise(r => setTimeout(r, 200));

      // Import each session result as a track
      for (const sr of results) {
        const wrappedResult: RecordingResult = sr.result;
        createTrackFromRecording(wrappedResult).catch(e => {
          console.error('[Recording] Background import failed for session:', sr.session_id, e);
        });
      }

      return results;
    } catch (e) {
      console.error('[Recording] Failed to stop multi-source:', e);
      error.value = e instanceof Error ? e.message : String(e);
      isRecording.value = false;
      isLocked.value = false;
      return null;
    }
  }

  // ── Per-device preview (multi-device VU meters) ──

  /** Start previewing multiple devices for concurrent VU meters */
  async function startDevicePreviews(deviceIds: string[]): Promise<void> {
    try {
      await invoke('start_device_previews', { deviceIds });

      // Start polling preview levels
      if (multiPreviewPollInterval) clearInterval(multiPreviewPollInterval);
      multiPreviewPollInterval = window.setInterval(async () => {
        try {
          const levels = await invoke<PreviewLevel[]>('get_preview_levels');
          const map = new Map<string, number>();
          for (const l of levels) {
            map.set(l.device_id, l.level);
          }
          previewLevels.value = map;
        } catch {
          // Ignore polling errors
        }
      }, 80);
    } catch (e) {
      console.error('[Recording] Failed to start device previews:', e);
    }
  }

  /** Stop all device previews and level polling */
  async function stopDevicePreviews(): Promise<void> {
    if (multiPreviewPollInterval) {
      clearInterval(multiPreviewPollInterval);
      multiPreviewPollInterval = null;
    }
    previewLevels.value = new Map();
    try {
      await invoke('stop_all_previews');
    } catch {
      // Ignore
    }
  }

  /** Get the preview/recording level for a specific device */
  function getDeviceLevel(deviceId: string): number {
    return previewLevels.value.get(deviceId) ?? 0;
  }

  // ── Independent per-device recording ──

  /** Start recording from a single device. Does not affect other active sessions. */
  async function startDeviceSession(deviceId: string, sessionId: string): Promise<string | null> {
    error.value = null;
    try {
      // Set recording epoch on first session start (for timeline sync)
      if (recordingEpoch.value === null) {
        recordingEpoch.value = Date.now();
        recordingBasePosition.value = tracksStore.timelineDuration;
      }

      const outputDir = await settingsStore.getProjectFolder();
      const path = await invoke<string>('start_session', {
        sessionId,
        deviceId,
        outputDir,
        channelMode: settingsStore.settings.recordingChannelMode,
        largeFileFormat: settingsStore.settings.recordingLargeFileFormat,
      });

      const device = devices.value.find(d => d.id === deviceId);
      const session: RecordingSession = {
        sessionId,
        deviceId,
        deviceName: device?.name || deviceId,
        active: true,
        level: 0,
        path,
        startTime: Date.now(),
        duration: 0,
      };
      sessions.value = [...sessions.value, session];
      isRecording.value = true;

      // Start duration tracking if not already running
      if (!durationInterval) {
        durationInterval = window.setInterval(() => {
          for (const s of sessions.value) {
            if (s.active) {
              s.duration = (Date.now() - s.startTime) / 1000;
            }
          }
          // Update global duration to max of all sessions
          const maxDuration = Math.max(0, ...sessions.value.filter(s => s.active).map(s => s.duration));
          recordingDuration.value = maxDuration;
        }, 100);
      }

      console.log('[Recording] Session started:', sessionId, path);
      return path;
    } catch (e) {
      console.error('[Recording] Failed to start session:', sessionId, e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /** Stop a single recording session by ID. Other sessions continue. */
  async function stopDeviceSession(sessionId: string): Promise<SessionResult | null> {
    try {
      // Capture session timing BEFORE it gets removed
      const session = sessions.value.find(s => s.sessionId === sessionId);
      const sessionStartTime = session?.startTime ?? Date.now();
      const epochVal = recordingEpoch.value;
      const basePos = recordingBasePosition.value;

      const result = await invoke<SessionResult>('stop_session', { sessionId });

      // Remove from sessions list
      sessions.value = sessions.value.filter(s => s.sessionId !== sessionId);

      // If no more active sessions, clear global recording state + epoch
      if (sessions.value.filter(s => s.active).length === 0) {
        isRecording.value = false;
        isLocked.value = false;
        currentLevel.value = 0;
        recordingEpoch.value = null;
        recordingBasePosition.value = null;
        if (durationInterval) {
          clearInterval(durationInterval);
          durationInterval = null;
        }
      }

      console.log(`[Recording] Session '${sessionId}' stopped: ${result.result.duration.toFixed(1)}s`);

      // Brief delay for OS file flush
      await new Promise(r => setTimeout(r, 200));

      // Compute timeline position: base + offset from epoch
      const offsetSeconds = (epochVal !== null)
        ? (sessionStartTime - epochVal) / 1000
        : 0;
      const trackStart = (basePos ?? tracksStore.timelineDuration) + offsetSeconds;

      // Import the recording as a track at the computed position
      if (result.result.path) {
        createTrackFromRecording(result.result, trackStart).catch(e => {
          console.error('[Recording] Background import failed for session:', sessionId, e);
        });
      }

      return result;
    } catch (e) {
      console.error('[Recording] Failed to stop session:', sessionId, e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /** Check if a specific device is currently recording */
  function isDeviceRecording(deviceId: string): boolean {
    return sessions.value.some(s => s.deviceId === deviceId && s.active);
  }

  /** Get the session for a specific device */
  function getDeviceSession(deviceId: string): RecordingSession | undefined {
    return sessions.value.find(s => s.deviceId === deviceId && s.active);
  }

  // ── Crash recovery ──
  const orphanedRecordings = ref<OrphanedRecording[]>([]);
  const orphanScanDone = ref(false);

  async function scanOrphanedRecordings(): Promise<OrphanedRecording[]> {
    if (orphanScanDone.value) return orphanedRecordings.value;
    orphanScanDone.value = true;
    try {
      const projectDir = await settingsStore.getProjectFolder();
      const orphans = await invoke<OrphanedRecording[]>('scan_orphaned_recordings', { projectDir });
      orphanedRecordings.value = orphans;
      if (orphans.length > 0) {
        console.log('[Recording] Found', orphans.length, 'orphaned recording(s)');
      }
      return orphans;
    } catch (e) {
      console.error('[Recording] Failed to scan for orphaned recordings:', e);
      return [];
    }
  }

  async function recoverRecording(path: string): Promise<RecordingResult | null> {
    try {
      const result = await invoke<RecordingResult>('recover_recording', { path });
      console.log('[Recording] Recovered:', result.path, result.duration.toFixed(1) + 's');

      // Remove from orphans list
      orphanedRecordings.value = orphanedRecordings.value.filter(o => o.path !== path);

      // Import the recovered file
      await audioStore.importFile(result.path);
      return result;
    } catch (e) {
      console.error('[Recording] Failed to recover recording:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  function dismissOrphans(): void {
    orphanedRecordings.value = [];
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
    selectedDeviceIds,
    multiSourceMode,
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
    // Multi-source
    toggleDeviceSelection,
    setMultiSourceMode,
    startMultiRecording,
    stopMultiRecording,
    // Per-device preview + independent recording
    previewLevels,
    startDevicePreviews,
    stopDevicePreviews,
    getDeviceLevel,
    startDeviceSession,
    stopDeviceSession,
    isDeviceRecording,
    getDeviceSession,
    // Crash recovery
    orphanedRecordings,
    scanOrphanedRecordings,
    recoverRecording,
    dismissOrphans,
  };
});
