import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import type { TrackPlacement, AudioLoadResult } from '@/shared/types';
import { WAVEFORM_BUCKET_COUNT } from '@/shared/constants';

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

      // Auto-select default device if none selected
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

  function setSource(newSource: RecordingSource): void {
    source.value = newSource;
    // Auto-select appropriate device
    if (newSource === 'microphone') {
      const mic = microphoneDevices.value.find(d => d.is_default) || microphoneDevices.value[0];
      if (mic) selectedDeviceId.value = mic.id;
    } else {
      const loopback = loopbackDevices.value[0];
      if (loopback) selectedDeviceId.value = loopback.id;
    }
  }

  function setPlacement(newPlacement: TrackPlacement): void {
    placement.value = newPlacement;
  }

  // Calculate track start position based on placement setting
  function calculateTrackStart(): number {
    switch (placement.value) {
      case 'append':
        // Start after all existing tracks end
        return tracksStore.timelineDuration;
      case 'playhead':
        // Start at current playhead position
        const playbackStore = usePlaybackStore();
        return playbackStore.currentTime;
      case 'zero':
      default:
        // Start at time 0
        return 0;
    }
  }

  async function startRecording(): Promise<void> {
    if (isRecording.value) return;

    error.value = null;
    isPreparing.value = true;

    try {
      // Use the last export folder or a temp directory
      const outputDir = settingsStore.settings.lastExportFolder || '/tmp';

      recordingPath.value = await invoke<string>('start_recording', {
        deviceId: selectedDeviceId.value,
        outputDir,
      });

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

      console.log('[Recording] Started, output:', recordingPath.value);
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
      const result = await invoke<RecordingResult>('stop_recording');
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
  async function createTrackFromRecording(path: string, duration: number): Promise<void> {
    try {
      const ctx = audioStore.getAudioContext();

      // Load the recorded audio
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

      // Copy channel data
      for (let channel = 0; channel < metadata.channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        const sourceData = channels[channel];

        if (!sourceData || sourceData.length === 0) continue;

        const float32Data = sourceData instanceof Float32Array
          ? sourceData
          : new Float32Array(sourceData);

        channelData.set(float32Data);
      }

      // Calculate where to place the track
      const trackStart = calculateTrackStart();

      // Generate track name
      const recordingNumber = tracksStore.tracks.length + 1;
      const name = `Recording ${recordingNumber}`;

      // Create the track with source path for transcription/VAD
      tracksStore.createTrackFromBuffer(buffer, waveformData, name, trackStart, path);

      // Also update lastImportedPath for backwards compatibility
      audioStore.lastImportedPath = path;

      console.log('[Recording] Created track at position:', trackStart);
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
      await invoke('cancel_recording');
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

  // Check if input is muted (Linux only, but safe to call on other platforms)
  async function checkMuted(): Promise<boolean> {
    try {
      const muted = await invoke<boolean>('check_input_muted');
      isMuted.value = muted;
      return muted;
    } catch (e) {
      // Ignore errors - mute detection may not be supported
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

  // Start monitoring input level (without recording)
  async function startMonitoring(): Promise<void> {
    if (isMonitoring.value || isRecording.value) return;

    error.value = null;

    // Check if input is muted first
    await checkMuted();

    try {
      await invoke('start_monitoring', {
        deviceId: selectedDeviceId.value,
      });

      isMonitoring.value = true;

      // Start polling level
      monitorPollInterval = window.setInterval(async () => {
        try {
          currentLevel.value = await invoke<number>('get_recording_level');
        } catch (e) {
          // Ignore polling errors
        }
      }, 50);

      console.log('[Recording] Monitoring started');
    } catch (e) {
      console.error('[Recording] Failed to start monitoring:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function stopMonitoring(): Promise<void> {
    if (!isMonitoring.value) return;

    // Stop polling
    if (monitorPollInterval) {
      clearInterval(monitorPollInterval);
      monitorPollInterval = null;
    }

    try {
      await invoke('stop_monitoring');
      isMonitoring.value = false;
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
    refreshDevices,
    selectDevice,
    setSource,
    setPlacement,
    startRecording,
    stopRecording,
    cancelRecording,
    startMonitoring,
    stopMonitoring,
    checkMuted,
    unmute,
  };
});
