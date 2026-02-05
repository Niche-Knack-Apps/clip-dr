import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import type { TrackPlacement, AudioLoadResult } from '@/shared/types';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';
import { useHistoryStore } from './history';

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
  is_input: boolean;
  is_loopback: boolean;
}

export interface RecordingResult {
  path: string;
  duration: number;
  sample_rate: number;
  channels: number;
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

  // System audio probe result
  const systemAudioInfo = ref<SystemAudioInfo | null>(null);
  const systemAudioProbing = ref(false);

  // Track placement setting: where new recordings appear on timeline
  const placement = ref<TrackPlacement>('append');

  let levelPollInterval: number | null = null;
  let monitorPollInterval: number | null = null;
  let durationInterval: number | null = null;
  let recordingStartTime = 0;

  const microphoneDevices = computed(() =>
    devices.value.filter(d => d.is_input && !d.is_loopback)
  );

  const loopbackDevices = computed(() =>
    devices.value.filter(d => d.is_loopback)
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

      console.log('[Recording] System audio probe result:', info);

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

  function setPlacement(newPlacement: TrackPlacement): void {
    placement.value = newPlacement;
  }

  // Calculate track start position based on placement setting
  function calculateTrackStart(): number {
    switch (placement.value) {
      case 'append':
        return tracksStore.timelineDuration;
      case 'playhead':
        const playbackStore = usePlaybackStore();
        return playbackStore.currentTime;
      case 'zero':
      default:
        return 0;
    }
  }

  async function startRecording(): Promise<void> {
    if (isRecording.value) return;

    error.value = null;
    isPreparing.value = true;

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
        });
        console.log('[Recording] Started system audio recording, output:', recordingPath.value);
      } else {
        recordingPath.value = await invoke<string>('start_recording', {
          deviceId: selectedDeviceId.value,
          outputDir,
        });
        console.log('[Recording] Started, output:', recordingPath.value);
      }

      isRecording.value = true;
      recordingStartTime = Date.now();
      recordingDuration.value = 0;

      // Start polling level
      levelPollInterval = window.setInterval(async () => {
        try {
          currentLevel.value = await invoke<number>('get_recording_level');
        } catch (e) {
          // Ignore polling errors
        }
      }, 50);

      // Start duration counter
      durationInterval = window.setInterval(() => {
        recordingDuration.value = (Date.now() - recordingStartTime) / 1000;
      }, 100);
    } catch (e) {
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
      currentLevel.value = 0;

      console.log('[Recording] Stopped:', result);

      // Create a new track from the recorded audio
      if (result.path) {
        await createTrackFromRecording(result.path, result.duration);
      }

      return result;
    } catch (e) {
      console.error('[Recording] Failed to stop:', e);
      error.value = e instanceof Error ? e.message : String(e);
      isRecording.value = false;
      return null;
    }
  }

  // Create a track from recorded audio file
  async function createTrackFromRecording(path: string, _duration: number): Promise<void> {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Record track');
    try {
      const ctx = audioStore.getAudioContext();

      console.log('[Recording] Loading recorded audio...');
      const loadResult = await invoke<AudioLoadResult>('load_audio_complete', {
        path,
        bucketCount: WAVEFORM_BUCKET_COUNT,
      });

      const { metadata, waveform: waveformData, channels } = loadResult;

      if (channels.length === 0 || channels[0].length === 0) {
        throw new Error('No audio data in recording');
      }

      const samplesPerChannel = channels[0].length;
      const buffer = ctx.createBuffer(
        metadata.channels,
        samplesPerChannel,
        metadata.sampleRate
      );

      for (let channel = 0; channel < metadata.channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        const sourceData = channels[channel];

        if (!sourceData || sourceData.length === 0) continue;

        const float32Data = sourceData instanceof Float32Array
          ? sourceData
          : new Float32Array(sourceData);

        channelData.set(float32Data);
      }

      const trackStart = calculateTrackStart();
      const recordingNumber = tracksStore.tracks.length + 1;
      const name = `Recording ${recordingNumber}`;

      const newTrack = tracksStore.createTrackFromBuffer(buffer, waveformData, name, trackStart, path);

      // Select the new track
      tracksStore.selectTrack(newTrack.id);

      // Also update lastImportedPath for backwards compatibility
      audioStore.lastImportedPath = path;

      console.log('[Recording] Created track at position:', trackStart, 'selected:', newTrack.id);

      // Queue background transcription for the new track
      useTranscriptionStore().queueTranscription(newTrack.id, 'high');
    } catch (e) {
      console.error('[Recording] Failed to create track:', e);
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      historyStore.endBatch();
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
      currentLevel.value = 0;
      recordingDuration.value = 0;
      recordingPath.value = null;
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
      }, 50);
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
    microphoneDevices,
    loopbackDevices,
    selectedDevice,
    defaultDevice,
    // System audio
    systemAudioInfo,
    systemAudioProbing,
    refreshDevices,
    selectDevice,
    setSource,
    setPlacement,
    probeSystemAudio,
    startRecording,
    stopRecording,
    cancelRecording,
    startMonitoring,
    stopMonitoring,
    checkMuted,
    unmute,
  };
});
