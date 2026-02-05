import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAudioStore } from './audio';
import { useTracksStore } from './tracks';
import { usePlaybackStore } from './playback';
import { useSettingsStore } from './settings';
import { useTranscriptionStore } from './transcription';
import type { TrackPlacement, AudioLoadResult, Word, PartialTranscription, LiveTranscriptionState } from '@/shared/types';
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
  method: string;  // "parec", "pw-record", "parecord", "cpal-monitor", or "unavailable"
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

  // Live transcription state
  const enableLiveTranscription = ref(true);
  const liveTranscriptionAvailable = ref(false);
  const liveTranscription = ref<LiveTranscriptionState>({
    words: [],
    isActive: false,
    lastChunkIndex: -1,
  });

  let levelPollInterval: number | null = null;
  let monitorPollInterval: number | null = null;
  let durationInterval: number | null = null;
  let recordingStartTime = 0;
  let transcriptionUnlisten: UnlistenFn | null = null;
  let startedWithLiveTranscription = false;

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

  async function setSource(newSource: RecordingSource): Promise<void> {
    source.value = newSource;
    error.value = null;

    // Auto-select appropriate device
    if (newSource === 'microphone') {
      const mic = microphoneDevices.value.find(d => d.is_default) || microphoneDevices.value[0];
      if (mic) selectedDeviceId.value = mic.id;
      systemAudioInfo.value = null;
    } else {
      // Probe system audio capabilities
      await probeSystemAudio();

      // Select device based on probe result
      if (systemAudioInfo.value?.cpal_monitor_device) {
        // CPAL monitor available - use it (gives us levels + live transcription)
        selectedDeviceId.value = systemAudioInfo.value.cpal_monitor_device;
        console.log('[Recording] Using CPAL monitor device:', selectedDeviceId.value);
      } else {
        // Will use subprocess recording (pw-record) - no CPAL device needed
        // The subprocess handles its own audio capture via PipeWire port linking
        // Don't set a device ID here - the loopback devices in the list are
        // PipeWire source names that CPAL can't open
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

  function setEnableLiveTranscription(enabled: boolean): void {
    enableLiveTranscription.value = enabled;
  }

  // Check if live transcription is available (model exists)
  async function checkLiveTranscriptionAvailable(): Promise<boolean> {
    try {
      const available = await invoke<boolean>('check_live_transcription_available', {
        modelsPath: settingsStore.settings.modelsPath || null,
      });
      liveTranscriptionAvailable.value = available;
      return available;
    } catch (e) {
      console.error('[Recording] Failed to check live transcription:', e);
      liveTranscriptionAvailable.value = false;
      return false;
    }
  }

  // Merge new words from a transcription chunk with existing words
  function mergeTranscriptionWords(newWords: Word[], chunkIndex: number): void {
    if (chunkIndex === 0 || liveTranscription.value.words.length === 0) {
      // First chunk or empty - just use the new words
      liveTranscription.value.words = newWords;
    } else {
      // Merge with overlap handling
      const existingEnd = liveTranscription.value.words.at(-1)?.end ?? 0;
      const overlapBuffer = 0.3; // seconds
      // Filter out words that overlap with what we already have
      const filteredNew = newWords.filter(w => w.start > existingEnd - overlapBuffer);
      liveTranscription.value.words.push(...filteredNew);
    }
    liveTranscription.value.lastChunkIndex = chunkIndex;
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

    // For system audio subprocess recording, keep monitoring running — the same
    // pw-record process is reused for recording (monitor reader accumulates samples).
    // For microphone/CPAL recording, stop monitoring to avoid device conflicts.
    const isSystemSubprocess = source.value === 'system' &&
      systemAudioInfo.value?.method !== 'cpal-monitor';

    if (isMonitoring.value && !isSystemSubprocess) {
      await stopMonitoring();
    }

    try {
      // Use the project folder for recordings
      const outputDir = await settingsStore.getProjectFolder();

      // Check if we're recording system audio
      const isSystemAudio = source.value === 'system';

      // Check if we should use live transcription
      // Now works with both microphone AND system audio (system audio streams to transcription buffer)
      const useLiveTranscription = enableLiveTranscription.value &&
        liveTranscriptionAvailable.value;

      startedWithLiveTranscription = useLiveTranscription;

      console.log('[Recording] Start recording:', {
        source: source.value,
        isSystemAudio,
        useLiveTranscription,
        selectedDevice: selectedDeviceId.value,
      });

      // Set up live transcription listener if enabled (works for both mic and system audio)
      if (useLiveTranscription) {
        transcriptionUnlisten = await listen<PartialTranscription>(
          'transcription-partial',
          (event) => {
            const { words, chunkIndex, isFinal } = event.payload;
            if (isFinal) {
              liveTranscription.value.isActive = false;
            } else {
              mergeTranscriptionWords(words, chunkIndex);
            }
          }
        );
        liveTranscription.value = { words: [], isActive: true, lastChunkIndex: -1 };
      }

      if (isSystemAudio) {
        // System audio uses pw-record with stdout streaming
        // This now supports level meter + live transcription via the streaming approach
        recordingPath.value = await invoke<string>('start_system_audio_recording', {
          outputDir,
        });
        console.log('[Recording] Started system audio recording (streaming), output:', recordingPath.value);

        // For system audio with live transcription, start just the transcription worker
        // (the audio is already being fed to the transcription buffer by the stream reader)
        if (useLiveTranscription) {
          await invoke('start_transcription_worker', {
            modelsPath: settingsStore.settings.modelsPath || null,
          }).catch((e) => {
            console.warn('[Recording] Could not start transcription worker for system audio:', e);
          });
        }
      } else if (useLiveTranscription) {
        // Event listener and state already set up above
        // Start recording with transcription
        recordingPath.value = await invoke<string>('start_recording_with_transcription', {
          deviceId: selectedDeviceId.value,
          outputDir,
          modelsPath: settingsStore.settings.modelsPath || null,
        });

        console.log('[Recording] Started with live transcription, output:', recordingPath.value);
      } else {
        // Standard recording without live transcription
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
      // Clean up listener if we set one up
      if (transcriptionUnlisten) {
        transcriptionUnlisten();
        transcriptionUnlisten = null;
      }
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
      // Use the tracked flag from startRecording, not the reactive isActive
      // (isActive may have been set to false by a premature isFinal event)
      const wasSystemAudio = source.value === 'system';
      const wasUsingSubprocess = wasSystemAudio &&
        systemAudioInfo.value?.method !== 'cpal-monitor';

      let result: RecordingResult;
      if (wasUsingSubprocess) {
        // Subprocess recording (pw-record/parecord)
        if (startedWithLiveTranscription) {
          await invoke('stop_transcription_worker').catch((e) => {
            console.warn('[Recording] Failed to stop transcription worker:', e);
          });
        }
        result = await invoke<RecordingResult>('stop_system_audio_recording');
      } else if (startedWithLiveTranscription) {
        result = await invoke<RecordingResult>('stop_recording_with_transcription');
      } else {
        result = await invoke<RecordingResult>('stop_recording');
      }

      // Clean up transcription listener AFTER stop commands complete
      if (transcriptionUnlisten) {
        transcriptionUnlisten();
        transcriptionUnlisten = null;
      }

      isRecording.value = false;
      currentLevel.value = 0;
      liveTranscription.value.isActive = false;
      startedWithLiveTranscription = false;

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
      liveTranscription.value.isActive = false;
      startedWithLiveTranscription = false;
      // Clean up transcription listener on error too
      if (transcriptionUnlisten) {
        transcriptionUnlisten();
        transcriptionUnlisten = null;
      }
      return null;
    }
  }

  // Create a track from recorded audio file
  async function createTrackFromRecording(path: string, _duration: number): Promise<void> {
    const historyStore = useHistoryStore();
    historyStore.beginBatch('Record track');
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
      const newTrack = tracksStore.createTrackFromBuffer(buffer, waveformData, name, trackStart, path);

      // Select the new track so transcription targets it
      // (EditorView's selectedTrackId watcher will trigger transcribeAudio automatically)
      tracksStore.selectTrack(newTrack.id);

      // Also update lastImportedPath for backwards compatibility
      audioStore.lastImportedPath = path;

      console.log('[Recording] Created track at position:', trackStart, 'selected:', newTrack.id);

      // Clear live transcription state (was display-only during recording)
      liveTranscription.value = { words: [], isActive: false, lastChunkIndex: -1 };
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

    // Clean up transcription listener
    if (transcriptionUnlisten) {
      transcriptionUnlisten();
      transcriptionUnlisten = null;
    }

    try {
      // For system audio, stop and delete the file
      if (source.value === 'system') {
        try {
          const result = await invoke<RecordingResult>('stop_system_audio_recording');
          // Delete the file since we're cancelling
          if (result.path) {
            // File will be left behind but user cancelled so it's ok
          }
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
      liveTranscription.value = { words: [], isActive: false, lastChunkIndex: -1 };
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

  // Track whether monitoring is using system audio (pw-record) or CPAL
  let monitoringIsSystemAudio = false;

  // Start monitoring input level (without recording)
  async function startMonitoring(): Promise<void> {
    if (isMonitoring.value || isRecording.value) return;

    error.value = null;

    // Determine if we should use system audio monitoring
    const useSystemAudioMonitoring = source.value === 'system' &&
      systemAudioInfo.value?.available &&
      !systemAudioInfo.value?.cpal_monitor_device;

    try {
      if (useSystemAudioMonitoring) {
        // System audio via pw-record: use dedicated system audio monitoring
        await invoke('start_system_audio_monitoring');
        monitoringIsSystemAudio = true;
        console.log('[Recording] System audio monitoring started (pw-record)');
      } else {
        // Microphone or CPAL monitor device
        await checkMuted();
        await invoke('start_monitoring', {
          deviceId: selectedDeviceId.value,
        });
        monitoringIsSystemAudio = false;
        console.log('[Recording] CPAL monitoring started');
      }

      isMonitoring.value = true;

      // Start polling level
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

    // Stop polling
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

  // Check if live transcription is available on init
  checkLiveTranscriptionAvailable();

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
    // Live transcription
    enableLiveTranscription,
    liveTranscriptionAvailable,
    liveTranscription,
    // System audio
    systemAudioInfo,
    systemAudioProbing,
    refreshDevices,
    selectDevice,
    setSource,
    setPlacement,
    setEnableLiveTranscription,
    checkLiveTranscriptionAvailable,
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
