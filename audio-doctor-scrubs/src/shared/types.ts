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

export interface Transcription {
  audioId: string;
  words: Word[];
  fullText: string;
  language: string;
  processedAt: number;
}

export interface Track {
  id: string;
  name: string;
  audioId: string;
  type: 'full' | 'clip';
  start: number;
  end: number;
  trackStart: number;
  muted: boolean;
  solo: boolean;
  volume: number;
}

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
}

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'ogg';

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
