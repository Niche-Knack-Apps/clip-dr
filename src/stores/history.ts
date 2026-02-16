import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Track, TrackClip, ViewMode, Word, SilenceRegion, InOutPoints } from '@/shared/types';
import { useTracksStore } from './tracks';
import { useTranscriptionStore } from './transcription';
import { useSelectionStore } from './selection';
import { useSilenceStore } from './silence';

const MAX_HISTORY = 50;

// ─── Snapshot shape ───────────────────────────────────────────────
interface TranscriptionEntry {
  trackId: string;
  words: Word[];
  fullText: string;
  language: string;
  processedAt: number;
  wordOffsets: Map<string, number>;
  enableFalloff: boolean;
}

interface Snapshot {
  label: string;
  tracks: {
    tracks: Track[];
    selectedTrackId: string | 'ALL' | null;
    selectedClipId: string | null;
    viewMode: ViewMode;
  };
  transcription: {
    transcriptions: Map<string, TranscriptionEntry>;
  };
  selection: {
    inOutPoints: InOutPoints;
  };
  silence: {
    silenceRegions: SilenceRegion[];
    compressionEnabled: boolean;
  };
}

// ─── Deep-clone helpers ───────────────────────────────────────────
function cloneClip(clip: TrackClip): TrackClip {
  return {
    id: clip.id,
    buffer: clip.buffer,               // shared by reference
    waveformData: clip.waveformData,   // shared by reference (immutable display data)
    clipStart: clip.clipStart,
    duration: clip.duration,
  };
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    audioData: {
      buffer: track.audioData.buffer,   // shared by reference
      waveformData: track.audioData.waveformData,   // shared by reference (immutable display data)
      sampleRate: track.audioData.sampleRate,
      channels: track.audioData.channels,
    },
    clips: track.clips ? track.clips.map(cloneClip) : undefined,
    timemarks: track.timemarks ? track.timemarks.map(m => ({ ...m })) : undefined,
  };
}

function cloneTranscriptions(source: Map<string, { trackId: string; words: Word[]; fullText: string; language: string; processedAt: number; wordOffsets: Map<string, number>; enableFalloff: boolean }>): Map<string, TranscriptionEntry> {
  const result = new Map<string, TranscriptionEntry>();
  for (const [key, entry] of source) {
    result.set(key, {
      trackId: entry.trackId,
      words: entry.words.map(w => ({ ...w })),
      fullText: entry.fullText,
      language: entry.language,
      processedAt: entry.processedAt,
      wordOffsets: new Map(entry.wordOffsets),
      enableFalloff: entry.enableFalloff,
    });
  }
  return result;
}

// ─── Store ────────────────────────────────────────────────────────
export const useHistoryStore = defineStore('history', () => {
  const undoStack = ref<Snapshot[]>([]);
  const redoStack = ref<Snapshot[]>([]);
  const isRestoring = ref(false);
  const batchDepth = ref(0);
  const batchLabel = ref('');

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  // ── Capture current state from all stores ──
  function captureSnapshot(label: string): Snapshot {
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();
    const selectionStore = useSelectionStore();
    const silenceStore = useSilenceStore();

    const clonedTranscriptions = cloneTranscriptions(transcriptionStore.transcriptions);
    const transKeys = Array.from(clonedTranscriptions.keys()).map(k => k.slice(0, 8));
    console.log(`[History] captureSnapshot("${label}"): transcriptions Map keys: [${transKeys}]`);

    return {
      label,
      tracks: {
        tracks: tracksStore.tracks.map(cloneTrack),
        selectedTrackId: tracksStore.selectedTrackId,
        selectedClipId: tracksStore.selectedClipId,
        viewMode: tracksStore.viewMode,
      },
      transcription: {
        transcriptions: clonedTranscriptions,
      },
      selection: {
        inOutPoints: { ...selectionStore.inOutPoints },
      },
      silence: {
        silenceRegions: silenceStore.silenceRegions.map((r: SilenceRegion) => ({ ...r })),
        compressionEnabled: silenceStore.compressionEnabled,
      },
    };
  }

  // ── Restore a snapshot ──
  function restoreSnapshot(snapshot: Snapshot): void {
    const tracksStore = useTracksStore();
    const transcriptionStore = useTranscriptionStore();
    const selectionStore = useSelectionStore();
    const silenceStore = useSilenceStore();

    isRestoring.value = true;

    try {
      // Tracks
      tracksStore.tracks = snapshot.tracks.tracks.map(cloneTrack);
      tracksStore.selectedTrackId = snapshot.tracks.selectedTrackId;
      tracksStore.selectedClipId = snapshot.tracks.selectedClipId;
      tracksStore.viewMode = snapshot.tracks.viewMode;

      // Transcription — restore the Map
      const snapshotKeys = Array.from(snapshot.transcription.transcriptions.keys()).map(k => k.slice(0, 8));
      const currentKeys = Array.from(transcriptionStore.transcriptions.keys()).map(k => k.slice(0, 8));
      console.log(`[History] restoreSnapshot: replacing transcriptions Map. Current: [${currentKeys}] → Snapshot: [${snapshotKeys}]`);
      transcriptionStore.transcriptions = cloneTranscriptions(snapshot.transcription.transcriptions);

      // Selection
      selectionStore.inOutPoints = { ...snapshot.selection.inOutPoints };

      // Silence
      silenceStore.silenceRegions = snapshot.silence.silenceRegions.map((r: SilenceRegion) => ({ ...r }));
      silenceStore.compressionEnabled = snapshot.silence.compressionEnabled;
    } finally {
      isRestoring.value = false;
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Capture current state before a mutation. No-op inside a batch. */
  function pushState(label: string): void {
    if (isRestoring.value) return;
    if (batchDepth.value > 0) return;   // batch's beginBatch already captured

    const snapshot = captureSnapshot(label);
    undoStack.value.push(snapshot);

    // Trim oldest entries
    if (undoStack.value.length > MAX_HISTORY) {
      undoStack.value = undoStack.value.slice(-MAX_HISTORY);
    }

    // New action clears redo
    redoStack.value = [];
  }

  /** Undo the last action. */
  function undo(): void {
    if (undoStack.value.length === 0) return;

    // Save current state for redo
    const current = captureSnapshot('redo');
    redoStack.value.push(current);

    // Restore previous state
    const previous = undoStack.value.pop()!;
    restoreSnapshot(previous);

    console.log(`[History] Undo: ${previous.label}`);
  }

  /** Redo the last undone action. */
  function redo(): void {
    if (redoStack.value.length === 0) return;

    // Save current state for undo
    const current = captureSnapshot('undo');
    undoStack.value.push(current);

    // Restore redo state
    const next = redoStack.value.pop()!;
    restoreSnapshot(next);

    console.log(`[History] Redo: ${next.label}`);
  }

  /** Begin a batch — captures a snapshot on first call, increments depth. */
  function beginBatch(label: string): void {
    if (isRestoring.value) return;
    if (batchDepth.value === 0) {
      batchLabel.value = label;
      const snapshot = captureSnapshot(label);
      undoStack.value.push(snapshot);
      if (undoStack.value.length > MAX_HISTORY) {
        undoStack.value = undoStack.value.slice(-MAX_HISTORY);
      }
      redoStack.value = [];
    }
    batchDepth.value++;
  }

  /** End a batch — decrements depth. */
  function endBatch(): void {
    if (batchDepth.value > 0) {
      batchDepth.value--;
    }
  }

  /** Clear all history (e.g. on project load). */
  function clear(): void {
    undoStack.value = [];
    redoStack.value = [];
    batchDepth.value = 0;
  }

  return {
    canUndo,
    canRedo,
    isRestoring,
    pushState,
    undo,
    redo,
    beginBatch,
    endBatch,
    clear,
  };
});
