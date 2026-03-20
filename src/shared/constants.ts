export const SEEK_THROTTLE_MS = 50;

// Volume range: 0 (silence) to +24dB (~15.85x linear gain)
export const MAX_VOLUME_DB = 24;
export const MIN_VOLUME_DB = -60;
export const MAX_VOLUME_LINEAR = Math.pow(10, MAX_VOLUME_DB / 20); // ~15.849

export const DEFAULT_SELECTION_DURATION = 10;

export const WAVEFORM_BUCKET_COUNT = 1000;

export const MIN_SELECTION_DURATION = 0.1;

// Maximum estimated PCM size (bytes) for browser decode - 500MB
// Files larger than this skip decodeAudioData to avoid WebView OOM crashes
export const LARGE_FILE_PCM_THRESHOLD = 524_288_000;

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
  selectionColor: 'rgba(255, 255, 255, 0.2)',
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
  // Recording large file format (>4GB): split into separate tracks or single RF64
  recordingLargeFileFormat: 'rf64' as const,
  // Transcription engine: whisper (default) or moonshine
  transcriptionEngine: 'whisper' as const,
  // Bottom bar shortcut hints
  shortcutHints: ['help', 'jkl', 'cut', 'delete'],
  // Quick Session Mode: auto-start new session when all tracks are deleted
  quickSessionMode: false,
  // Time display format
  timeFormat: 'hms' as const,
  // Track color palette
  trackColorMode: 'auto' as const,
  trackPrimaryColor: '#00d4ff',
  trackCustomColors: [] as string[],
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
  SPEED_UP: 'ArrowUp',
  SPEED_DOWN: 'ArrowDown',
  NEXT_MARKER: '>',      // Shift+.
  PREV_MARKER: '<',      // Shift+,
  MARK_TIME: 'm',
  // Loop mode shortcuts
  LOOP_FULL: 'q',
  LOOP_ZOOM: 'w',
  LOOP_INOUT: 'e',
  LOOP_ACTIVE: 'r',
  LOOP_CLIP: 't',
} as const;

export const ALL_SHORTCUT_HINTS = [
  { id: 'help', keys: '?', label: 'All Shortcuts' },
  { id: 'jkl', keys: 'J/K/L', label: 'Shuttle' },
  { id: 'play', keys: 'Space', label: 'Play/Pause' },
  { id: 'forward', keys: 'L/\u2192', label: 'Forward' },
  { id: 'reverse', keys: 'J/\u2190', label: 'Reverse' },
  { id: 'speed', keys: '\u2191/\u2193', label: 'Speed' },
  { id: 'markers', keys: '</>', label: 'Markers' },
  { id: 'inout', keys: 'I/O', label: 'In/Out' },
  { id: 'clip', keys: 'C', label: 'Clip' },
  { id: 'cut', keys: 'X', label: 'Cut' },
  { id: 'delete', keys: 'Del', label: 'Delete' },
  { id: 'paste', keys: 'V', label: 'Paste' },
  { id: 'tab', keys: 'Tab', label: 'Next Track' },
  { id: 'zoom', keys: '+/-', label: 'Zoom' },
  { id: 'undo', keys: 'Ctrl+Z', label: 'Undo' },
] as const;

export const SUPPORTED_FORMATS = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.ogg',
  '.aac',
];

export const TRACK_HEIGHT = 60;
export const WORD_HEIGHT = 24;
export const TITLEBAR_HEIGHT = 36;
export const TOOLBAR_ROW_HEIGHT = 40;
export const TOOLBAR_HEIGHT = TOOLBAR_ROW_HEIGHT * 2; // Two rows
export const WAVEFORM_HEIGHT = 100;
export const ZOOMED_HEIGHT = 130;

// Track panel dimensions
export const TRACK_PANEL_MIN_WIDTH = 80;
export const TRACK_PANEL_MAX_WIDTH = 300;
export const TRACK_PANEL_DEFAULT_WIDTH = 240;

export type LoopMode = 'full' | 'inout' | 'clip';
export const LOOP_MODES: { value: LoopMode; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'inout', label: 'I/O' },
  { value: 'clip', label: 'Clip' },
];

import type { CleaningOptions, CleaningPreset, ExportProfile } from './types';

/**
 * Generate a palette of N colors from a primary hex color by rotating hue in HSL space.
 */
export function generatePaletteFromPrimary(hex: string, count: number = 6): string[] {
  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const hRot = (h + i / count) % 1;
    // Slight saturation/lightness variation for visual distinction
    const sVar = Math.min(1, Math.max(0.3, s + (i % 2 === 0 ? 0 : -0.1)));
    const lVar = Math.min(0.65, Math.max(0.4, l + (i % 3 === 0 ? 0 : i % 3 === 1 ? 0.05 : -0.05)));
    colors.push(hslToHex(hRot, sVar, lVar));
  }
  return colors;
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export const DEFAULT_EXPORT_PROFILES: ExportProfile[] = [
  { id: 'mp3-192', name: 'MP3 Standard', format: 'mp3', mp3Bitrate: 192, isDefault: true, isFavorite: true },
  { id: 'mp3-320', name: 'MP3 High Quality', format: 'mp3', mp3Bitrate: 320, isDefault: true },
  { id: 'wav', name: 'WAV Lossless', format: 'wav', isDefault: true },
  { id: 'flac', name: 'FLAC Lossless', format: 'flac', isDefault: true },
  { id: 'ogg-q5', name: 'OGG Standard', format: 'ogg', oggQuality: 0.5, isDefault: true },
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
  dynamicsEnabled: true,
  dynamicsThresholdDb: -25,
  dynamicsRatio: 2,
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
      dynamicsEnabled: true,
      dynamicsThresholdDb: -25,
      dynamicsRatio: 2.5,
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
      dynamicsEnabled: true,
      dynamicsThresholdDb: -30,
      dynamicsRatio: 1.8,
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
      dynamicsEnabled: true,
      dynamicsThresholdDb: -20,
      dynamicsRatio: 3.0,
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
      dynamicsEnabled: false,
    },
  },
];
