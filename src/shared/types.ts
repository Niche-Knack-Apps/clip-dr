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
  /** Duration of the full source file that waveformData covers (set once at import, never edited) */
  sourceDuration?: number;
}

/** A clip segment within a track (for multi-clip tracks) */
export interface TrackClip {
  id: string;
  /** Audio buffer for this clip (null for large-file tracks with no browser decode) */
  buffer: AudioBuffer | null;
  /** Waveform data for this clip */
  waveformData: number[];
  /** Position on the timeline where this clip starts (in seconds) */
  clipStart: number;
  /** Duration of this clip (in seconds) */
  duration: number;
  /** EDL: path to source audio file (large-file non-destructive editing) */
  sourceFile?: string;
  /** EDL: offset in seconds within the source file where this clip's audio begins */
  sourceOffset?: number;
  /** Original sourceOffset when clip was created (immutable). Defines left extent of recoverable audio. */
  sourceIn?: number;
  /** Total available duration from sourceIn in source file (immutable). Defines full recoverable range. */
  sourceDuration?: number;
}

/** A keyframe point on a volume automation envelope */
export interface VolumeAutomationPoint {
  id: string;
  /** Track-relative seconds (same convention as TimeMark.time) */
  time: number;
  /** Linear gain: 0.0 to MAX_VOLUME_LINEAR */
  value: number;
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

export type ImportStatus = 'importing' | 'decoding' | 'ready' | 'error' | 'large-file' | 'caching';

export interface ImportStartResult {
  sessionId: string;
  metadata: AudioMetadata;
  /** If peak cache hit, waveform is returned directly (no background events needed) */
  cachedWaveform?: number[];
  cachedDuration?: number;
  /** Whether a peak pyramid is already available on disk for this file */
  hasPeakPyramid?: boolean;
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
  /** Linear gain: 0.0 (silence) to ~15.849 (+24dB). 1.0 = unity (0dB). */
  volume: number;
  /** Optional tag to categorize tracks (e.g., 'speech-segment') */
  tag?: string;
  /** Original source file path (for imported/recorded tracks) */
  sourcePath?: string;
  /** Multiple clips within this track (if present, takes precedence over audioData for rendering) */
  clips?: TrackClip[];
  /** Timemarks/reference points placed during recording */
  timemarks?: TimeMark[];
  /** Volume automation envelope keyframes */
  volumeEnvelope?: VolumeAutomationPoint[];
  /** Import status — undefined for existing/recording tracks */
  importStatus?: ImportStatus;
  /** Waveform analysis progress 0-1 (from Rust decode) */
  importProgress?: number;
  /** Audio fetch/decode progress 0-1 (from browser streaming fetch + decodeAudioData) */
  importDecodeProgress?: number;
  /** Active import session ID */
  importSessionId?: string;
  /** Whether a multi-LOD peak pyramid is available for this track */
  hasPeakPyramid?: boolean;
  /** Cached WAV path for large files (set when background cache decode completes) */
  cachedAudioPath?: string;
  /** Monotonically-incrementing epoch; bumped on every edit. Async ops abort on mismatch. */
  editEpoch?: number;
  /** True when this track was auto-muted (e.g., by solo) rather than explicitly muted by user */
  autoMuted?: boolean;
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
export type TranscriptionEngine = 'whisper' | 'moonshine';

export type RecordingSource = 'microphone' | 'system';
export type RecordingLargeFileFormat = 'split-tracks' | 'rf64';
export type Mp3Bitrate = number;

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
  // Last folder used in project open/save dialogs
  lastProjectFolder: string;
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
  // Recording channel mode
  recordingChannelMode: 'mono' | 'stereo';
  // Recording large file format (>4GB)
  recordingLargeFileFormat: RecordingLargeFileFormat;
  // Transcription engine selection
  transcriptionEngine: TranscriptionEngine;
  // Bottom bar shortcut hints
  shortcutHints: string[];
  // Quick Session Mode: auto-start new session when all tracks are deleted
  quickSessionMode: boolean;
  // Time display format: 'hms' = H:MM:SS, 'ms' = MM:SS.cs (centiseconds)
  timeFormat: 'hms' | 'ms';
  // Track color palette
  trackColorMode: 'auto' | 'custom';
  trackPrimaryColor: string;
  trackCustomColors: string[];
  // Silence removal crossfade duration in milliseconds (0 = disabled)
  silenceCrossfadeMs: number;
}

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'ogg';

export interface ExportProfile {
  id: string;
  name: string;
  format: ExportFormat;
  mp3Bitrate?: Mp3Bitrate;
  oggQuality?: number;     // 0.0–1.0 for OGG Vorbis quality
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

export interface TranscriptionMetrics {
  engine: string;
  modelName: string;
  audioDurationSecs: number;
  loadTimeMs: number;
  inferenceTimeMs: number;
  totalTimeMs: number;
  wordCount: number;
  wordsPerSecond: number;
  realTimeFactor: number;
}

export interface WaveformBucket {
  min: number;
  max: number;
}

export interface WaveformLayerClip {
  clipStart: number;
  duration: number;
  sourceFile?: string;       // large-file EDL clips
  pyramidSourceFile?: string; // original source path for peak pyramid lookup (may differ from sourceFile for decode-cached files)
  sourceOffset: number;
  sourceIn?: number;         // buffer base position in source-file time (buffer[0] = sourceIn)
  buffer?: AudioBuffer;      // small-file clips: hi-res extraction from memory
}

export interface WaveformLayer {
  trackId: string;
  color: string;
  waveformData: number[];     // min/max pairs (1000 buckets), timeline-mapped
  trackStart: number;
  duration: number;
  sourcePath?: string;
  hasPeakPyramid?: boolean;
  clips?: WaveformLayerClip[];
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
  dynamicsEnabled: boolean;
  dynamicsThresholdDb: number;    // -40 to -10, default -25
  dynamicsRatio: number;          // 1.5-4, default 2
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

/** A clip as serialized in a v2+ .clipdr project file */
export interface ProjectTrackClip {
  id: string;
  clipStart: number;
  duration: number;
  /** Stable source path (see source stability policy in docs/EDL_CONTRACTS.md) */
  sourceFile: string;
  sourceOffset: number;
  /** 'original' = user-granted import path, 'managed-cache' = app cache, 'temp' = volatile */
  source_kind: 'original' | 'managed-cache' | 'temp';
  /** Original sourceOffset when clip was created (v3+). Defines left extent of recoverable audio. */
  sourceIn?: number;
  /** Total available duration from sourceIn (v3+). Defines full recoverable range. */
  sourceDuration?: number;
}

/** A track as serialized in a .clipdr project file */
export interface ProjectTrack {
  id: string;
  name: string;
  sourcePath: string;
  trackStart: number;
  duration: number;
  color: string;
  muted: boolean;
  solo: boolean;
  volume: number;
  tag?: string;
  timemarks?: TimeMark[];
  volumeEnvelope?: VolumeAutomationPoint[];
  cachedAudioPath?: string | null;
  /** Present in v2+ files when track has been edited into multiple clips */
  clips?: ProjectTrackClip[];
}

/** .clipdr project file format */
export interface ProjectFile {
  version: 1 | 2 | 3;
  name: string;
  createdAt: string;
  modifiedAt: string;
  tracks: ProjectTrack[];
  selection: { inPoint: number | null; outPoint: number | null };
  /** v1-v2: flat array; v3: per-track Record<trackId, SilenceRegion[]> */
  silenceRegions: SilenceRegion[] | Record<string, SilenceRegion[]>;
}

export interface ExportEDL {
  tracks: ExportEDLTrack[];
  output_path: string;
  format: string;        // "wav" | "mp3" | "flac" | "ogg"
  sample_rate: number;
  channels: number;
  mp3_bitrate?: number;
  ogg_quality?: number;  // 0.0–1.0 for OGG Vorbis quality
  start_time: number;
  end_time: number;
}

export interface ExportEDLTrack {
  source_path: string;
  track_start: number;   // timeline offset in seconds
  duration: number;
  volume: number;
  /** Offset into the source file in seconds where this clip's audio begins */
  file_offset?: number;
  volume_envelope?: Array<{ time: number; value: number }>;
  /** Linear fade-in duration in seconds at clip start (silence crossfade) */
  fade_in?: number;
  /** Linear fade-out duration in seconds at clip end (silence crossfade) */
  fade_out?: number;
}

