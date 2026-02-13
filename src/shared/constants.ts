export const SEEK_THROTTLE_MS = 50;

export const DEFAULT_SELECTION_DURATION = 10;

export const WAVEFORM_BUCKET_COUNT = 1000;

export const MIN_SELECTION_DURATION = 0.1;

export const SEARCH_MIN_WORDS = 1;

export const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'it', 'as', 'be', 'are', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
]);

export const DEFAULT_SETTINGS = {
  loopByDefault: true,
  autoNavigateAfterWords: 3,
  waveformColor: '#00d4ff',
  playheadColor: '#ff3366',
  selectionColor: 'rgba(0, 212, 255, 0.3)',
  showTranscription: true,
  asrModel: 'whisper-tiny' as const,
  modelsPath: '',
  lastImportFolder: '',
  lastExportFolder: '',
  lastExportFormat: 'mp3' as const,
  projectFolder: '',
  // Playback controls
  holdToPlay: false,          // true = hold Space to play, false = toggle (JKL mode)
  reverseWithAudio: true,     // true = actual audio, false = visual-only scrub
  // Clipboard behavior
  clipboardUsesInOutPoints: true,  // true = I/O markers, false = selected track bounds
  // Recording defaults
  defaultRecordingSource: 'microphone' as const,
  lastRecordingSource: 'system' as const,
  // Export defaults
  defaultMp3Bitrate: 192 as const,
  // Export profiles
  exportProfiles: [] as ExportProfile[],  // merged with DEFAULT_EXPORT_PROFILES at load time
  lastExportProfileId: 'mp3-192',
  lastExportPath: '',
  // Recording channel mode
  recordingChannelMode: 'stereo' as const,
};

export const KEYBOARD_SHORTCUTS = {
  PLAY_PAUSE: ' ',
  SET_IN: 'i',
  SET_OUT: 'o',
  CREATE_CLIP: 'c',
  JUMP_START: 'Home',
  JUMP_END: 'End',
  JUMP_IN: '[',
  JUMP_OUT: ']',
  DELETE_TRACK: 'Delete',
  FOCUS_SEARCH: 'f',
  // New navigation shortcuts
  JUMP_LAYER_START: 's',
  JUMP_LAYER_END: 'd',
  SPEED_UP: '.',
  SPEED_DOWN: ',',
  MARK_TIME: 'm',
  // Loop mode shortcuts
  LOOP_FULL: 'q',
  LOOP_ZOOM: 'w',
  LOOP_INOUT: 'e',
  LOOP_ACTIVE: 'r',
  LOOP_CLIP: 't',
} as const;

export const SUPPORTED_FORMATS = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.ogg',
  '.aac',
  '.wma',
];

export const TRACK_HEIGHT = 60;
export const WORD_HEIGHT = 24;
export const TOOLBAR_ROW_HEIGHT = 40;
export const TOOLBAR_HEIGHT = TOOLBAR_ROW_HEIGHT * 2; // Two rows
export const WAVEFORM_HEIGHT = 100;
export const ZOOMED_HEIGHT = 130;

// Track panel dimensions
export const TRACK_PANEL_MIN_WIDTH = 80;
export const TRACK_PANEL_MAX_WIDTH = 300;
export const TRACK_PANEL_DEFAULT_WIDTH = 240;

export type LoopMode = 'full' | 'zoom' | 'inout' | 'active' | 'clip';
export const LOOP_MODES: { value: LoopMode; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'inout', label: 'I/O' },
  { value: 'active', label: 'Tracks' },
  { value: 'clip', label: 'Clip' },
];

import type { CleaningOptions, CleaningPreset, ExportProfile } from './types';

export const DEFAULT_EXPORT_PROFILES: ExportProfile[] = [
  { id: 'mp3-192', name: 'MP3 Standard', format: 'mp3', mp3Bitrate: 192, isDefault: true, isFavorite: true },
  { id: 'mp3-320', name: 'MP3 High Quality', format: 'mp3', mp3Bitrate: 320, isDefault: true },
  { id: 'wav', name: 'WAV Lossless', format: 'wav', isDefault: true },
];

export const DEFAULT_CLEANING_OPTIONS: CleaningOptions = {
  highpassEnabled: true,
  highpassFreq: 80,
  lowpassEnabled: true,
  lowpassFreq: 8000,
  notchEnabled: true,
  mainsFrequency: 'auto',
  notchHarmonics: 4,
  spectralEnabled: true,
  noiseReductionDb: 12,
  neuralEnabled: true,
  neuralStrength: 0.8,
  expanderEnabled: true,
  expanderThresholdDb: -40,
  expanderRatio: 2,
};

export const CLEANING_PRESETS: CleaningPreset[] = [
  {
    id: 'podcast',
    name: 'Podcast/Voice',
    description: 'Optimized for speech, aggressive filtering',
    options: {
      highpassEnabled: true,
      highpassFreq: 100,
      lowpassEnabled: true,
      lowpassFreq: 8000,
      notchEnabled: true,
      spectralEnabled: true,
      noiseReductionDb: 15,
      neuralEnabled: true,
      neuralStrength: 0.9,
      expanderEnabled: true,
      expanderThresholdDb: -35,
      expanderRatio: 2.5,
    },
  },
  {
    id: 'interview',
    name: 'Interview',
    description: 'Gentle, preserve natural sound',
    options: {
      highpassEnabled: true,
      highpassFreq: 60,
      lowpassEnabled: true,
      lowpassFreq: 10000,
      notchEnabled: true,
      spectralEnabled: true,
      noiseReductionDb: 8,
      neuralEnabled: true,
      neuralStrength: 0.5,
      expanderEnabled: true,
      expanderThresholdDb: -45,
      expanderRatio: 1.5,
    },
  },
  {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'Maximum noise removal',
    options: {
      highpassEnabled: true,
      highpassFreq: 120,
      lowpassEnabled: true,
      lowpassFreq: 7000,
      notchEnabled: true,
      spectralEnabled: true,
      noiseReductionDb: 20,
      neuralEnabled: true,
      neuralStrength: 1.0,
      expanderEnabled: true,
      expanderThresholdDb: -30,
      expanderRatio: 3,
    },
  },
  {
    id: 'hum-only',
    name: 'Hum Only',
    description: 'Just mains hum removal',
    options: {
      highpassEnabled: false,
      lowpassEnabled: false,
      notchEnabled: true,
      notchHarmonics: 4,
      spectralEnabled: false,
      neuralEnabled: false,
      expanderEnabled: false,
    },
  },
];
