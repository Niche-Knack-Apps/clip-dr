export interface AudioFile {
  id: string;
  path: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  waveformData: number[];
  loadedAt: number;
}

export interface Selection {
  start: number;
  end: number;
}

export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
}

/** @deprecated Use TrackTranscription instead */
export interface Transcription {
  audioId: string;
  words: Word[];
  fullText: string;
  language: string;
  processedAt: number;
}

export interface TrackTranscription {
  trackId: string;
  words: Word[];           // 0-based timestamps relative to track audio start
  fullText: string;
  language: string;
  processedAt: number;
  wordOffsets: Map<string, number>;  // per-word timing adjustments (ms)
  enableFalloff: boolean;
}

export interface TranscriptionJob {
  id: string;
  trackId: string;
  priority: 'high' | 'normal';
  status: 'queued' | 'running' | 'complete' | 'error';
  progress: number;
  error?: string;
}

/** Per-track audio data stored directly on the track */
export interface TrackAudioData {
  buffer: AudioBuffer | null;
  waveformData: number[];
  sampleRate: number;
  channels: number;
}

/** A clip segment within a track (for multi-clip tracks) */
export interface TrackClip {
  id: string;
  /** Audio buffer for this clip */
  buffer: AudioBuffer;
  /** Waveform data for this clip */
  waveformData: number[];
  /** Position on the timeline where this clip starts (in seconds) */
  clipStart: number;
  /** Duration of this clip (in seconds) */
  duration: number;
}

/** A timemark/reference point placed during recording */
export interface TimeMark {
  id: string;
  time: number;
  label: string;
  source: 'manual' | 'auto';
  color?: string;
}

/** Track placement options for recording */
export type TrackPlacement = 'append' | 'playhead' | 'zero';

/** View mode for waveform display */
export type ViewMode = 'selected' | 'all';

/** Track color palette */
export const TRACK_COLORS = [
  '#00d4ff', // cyan
  '#ff6b6b', // red
  '#4ecdc4', // teal
  '#ffd93d', // yellow
  '#95e1d3', // mint
  '#f38181', // salmon
  '#aa96da', // lavender
  '#fcbad3', // pink
] as const;

export type ImportStatus = 'importing' | 'decoding' | 'ready' | 'error';

export interface ImportStartResult {
  sessionId: string;
  metadata: AudioMetadata;
  /** If peak cache hit, waveform is returned directly (no background events needed) */
  cachedWaveform?: number[];
  cachedDuration?: number;
}

export interface WaveformChunkEvent {
  sessionId: string;
  startBucket: number;
  waveform: number[];
  progress: number;
}

export interface ImportCompleteEvent {
  sessionId: string;
  waveform: number[];
  actualDuration: number;
}

export interface Track {
  id: string;
  name: string;
  /** Audio data stored directly on the track (used when no clips array) */
  audioData: TrackAudioData;
  /** Position on the timeline where this track starts (in seconds) */
  trackStart: number;
  /** Duration of the track audio (in seconds) */
  duration: number;
  /** Visual color for the track */
  color: string;
  muted: boolean;
  solo: boolean;
  volume: number;
  /** Optional tag to categorize tracks (e.g., 'speech-segment') */
  tag?: string;
  /** Original source file path (for imported/recorded tracks) */
  sourcePath?: string;
  /** Multiple clips within this track (if present, takes precedence over audioData for rendering) */
  clips?: TrackClip[];
  /** Timemarks/reference points placed during recording */
  timemarks?: TimeMark[];
  /** Import status — undefined for existing/recording tracks */
  importStatus?: ImportStatus;
  /** Waveform analysis progress 0-1 (from Rust decode) */
  importProgress?: number;
  /** Audio fetch/decode progress 0-1 (from browser streaming fetch + decodeAudioData) */
  importDecodeProgress?: number;
  /** Active import session ID */
  importSessionId?: string;
}

/** @deprecated Clips are now part of tracks */
export interface Clip {
  id: string;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  audioBuffer?: AudioBuffer;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
}

export interface InOutPoints {
  inPoint: number | null;
  outPoint: number | null;
}

export interface SearchResult {
  wordIndex: number;
  word: Word;
  matchStart: number;
  matchEnd: number;
}

export type ASRModel = 'whisper-tiny' | 'whisper-base' | 'vosk';

export type RecordingSource = 'microphone' | 'system';
export type Mp3Bitrate = 128 | 192 | 256 | 320;

export interface Settings {
  loopByDefault: boolean;
  autoNavigateAfterWords: number;
  waveformColor: string;
  playheadColor: string;
  selectionColor: string;
  showTranscription: boolean;
  asrModel: ASRModel;
  modelsPath: string;
  lastImportFolder: string;
  lastExportFolder: string;
  lastExportFormat: ExportFormat;
  // Project folder (recordings, exports, etc.) - empty = use app data dir
  projectFolder: string;
  // Playback controls
  holdToPlay: boolean;
  reverseWithAudio: boolean;
  // Clipboard behavior
  clipboardUsesInOutPoints: boolean;
  // Recording defaults
  defaultRecordingSource: RecordingSource;
  lastRecordingSource: RecordingSource;
  // Export defaults
  defaultMp3Bitrate: Mp3Bitrate;
  // Export profiles
  exportProfiles: ExportProfile[];
  lastExportProfileId: string;
  lastExportPath: string;
}

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'ogg';

export interface ExportProfile {
  id: string;
  name: string;
  format: ExportFormat;
  mp3Bitrate?: Mp3Bitrate;
  isDefault?: boolean;     // built-in, not deletable
  isFavorite?: boolean;    // starred = used for Quick Re-Export
}

export interface ExportOptions {
  format: ExportFormat;
  sampleRate: number;
  bitDepth: number;
  includeCleanedTracks: boolean;
}

export interface ModelInfo {
  name: string;
  filename: string;
  sizeMb: number;
  downloadUrl: string;
  path: string | null;
  available: boolean;
}

export interface WaveformBucket {
  min: number;
  max: number;
}

export interface AudioMetadata {
  duration: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  format: string;
}

/** Combined result from single-pass audio loading (3x faster) */
export interface AudioLoadResult {
  metadata: AudioMetadata;
  waveform: number[];
  /** Audio channels as separate arrays (already deinterleaved) */
  channels: number[][];
}

export interface TranscriptionProgress {
  stage: 'loading' | 'transcribing' | 'aligning' | 'complete';
  progress: number;
  message: string;
}

export interface SpeechSegment {
  start: number;
  end: number;
  isSpeech: boolean;
}

export interface VadResult {
  segments: SpeechSegment[];
  speechSegments: SpeechSegment[];
  silenceSegments: SpeechSegment[];
  totalSpeechDuration: number;
  totalSilenceDuration: number;
}

export interface VadOptions {
  energyThreshold: number;
  minSegmentDuration: number;
  frameSizeMs: number;
  padding: number;
  minSilenceDuration: number;
}

export type MainsFrequency = 'auto' | 'hz50' | 'hz60';

export interface CleaningOptions {
  highpassEnabled: boolean;
  highpassFreq: number;           // 40-150 Hz, default 80
  lowpassEnabled: boolean;
  lowpassFreq: number;            // 5000-12000 Hz, default 8000
  notchEnabled: boolean;
  mainsFrequency: MainsFrequency; // auto-detect by default
  notchHarmonics: number;         // 1-4, default 4
  spectralEnabled: boolean;       // Uses VAD silence for noise profile
  noiseReductionDb: number;       // 0-24, default 12
  neuralEnabled: boolean;
  neuralStrength: number;         // 0-1, default 0.8
  expanderEnabled: boolean;
  expanderThresholdDb: number;    // -60 to -20, default -40
  expanderRatio: number;          // 1.5-4, default 2
}

export interface CleaningPreset {
  id: string;
  name: string;
  description: string;
  options: Partial<CleaningOptions>;
}

export interface CleanResult {
  outputPath: string;
  duration: number;
  sampleRate: number;
}

export interface WordTimingAdjustment {
  wordId: string;
  offsetMs: number; // Offset in milliseconds from original timing
}

export interface TranscriptionMetadata {
  audioPath: string;
  audioHash?: string; // Optional hash to verify it's the same file
  globalOffsetMs: number; // Global offset applied to all words
  wordAdjustments: WordTimingAdjustment[]; // Individual word adjustments
  savedAt: number;
  // Full transcription data (for loading without model)
  words?: Word[];
  fullText?: string;
  language?: string;
}

export interface SilenceRegion {
  id: string;
  start: number;      // Start time in seconds (original timeline)
  end: number;        // End time in seconds (original timeline)
  enabled: boolean;   // If false, this region is "restored" (not cut)
}

