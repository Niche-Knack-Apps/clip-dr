import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ProjectFile, ProjectTrack, ProjectTrackClip, Track, TrackClip } from '@/shared/types';
import { useTracksStore } from './tracks';
import { useSelectionStore } from './selection';
import { useSilenceStore } from './silence';
import { useHistoryStore } from './history';
import { usePlaybackStore } from './playback';
import { useAudioStore } from './audio';
import { useTranscriptionStore } from './transcription';

const APP_TITLE = 'Clip Dr.';

// ── Path helpers ──────────────────────────────────────────────────────

function toRelativePath(absolutePath: string, baseDir: string): string {
  const normAbs = absolutePath.replace(/\\/g, '/');
  const normBase = baseDir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  if (normAbs.startsWith(normBase)) {
    return normAbs.slice(normBase.length);
  }
  return normAbs;
}

function toAbsolutePath(relOrAbsPath: string, baseDir: string): string {
  const norm = relOrAbsPath.replace(/\\/g, '/');
  // Already absolute (Unix or Windows drive letter)
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    return relOrAbsPath;
  }
  const normBase = baseDir.replace(/\\/g, '/').replace(/\/$/, '');
  return `${normBase}/${norm}`;
}

function getDirectory(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  return lastSlash >= 0 ? norm.slice(0, lastSlash) : '.';
}

function getBaseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  const name = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx > 0 ? name.slice(0, dotIdx) : name;
}

export const useProjectStore = defineStore('project', () => {
  const projectPath = ref<string | null>(null);
  const projectName = ref<string>('Untitled');
  const dirty = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  // Guard to suppress dirty tracking during project load
  let loadGuard = false;
  // Date when project was first created (preserved across saves)
  let createdAt: string | null = null;

  // ── Serialization ──────────────────────────────────────────────────

  /** Source stability policy: prefer user-granted path over cache over clip temp path. */
  function stableSourcePath(clip: TrackClip, track: Track): string {
    return track.sourcePath || clip.sourceFile || '';
  }

  function sourceKind(clip: TrackClip, track: Track): ProjectTrackClip['source_kind'] {
    if (track.sourcePath) return 'original';
    if (track.cachedAudioPath && clip.sourceFile === track.cachedAudioPath) return 'managed-cache';
    return 'temp';
  }

  function serializeProject(): ProjectFile {
    const tracksStore = useTracksStore();
    const selectionStore = useSelectionStore();
    const silenceStore = useSilenceStore();

    const baseDir = projectPath.value ? getDirectory(projectPath.value) : '.';

    const tracks: ProjectTrack[] = tracksStore.tracks.map(t => {
      // Derive effective sourcePath: original > first clip source > cache
      const effectiveSource = t.sourcePath
        || (t.clips && t.clips.length > 0 ? t.clips[0].sourceFile : '')
        || t.cachedAudioPath
        || '';
      const base: ProjectTrack = {
        id: t.id,
        name: t.name,
        sourcePath: effectiveSource ? toRelativePath(effectiveSource, baseDir) : '',
        trackStart: t.trackStart,
        duration: t.duration,
        color: t.color,
        muted: t.muted,
        solo: t.solo,
        volume: t.volume,
        tag: t.tag,
        timemarks: t.timemarks,
        volumeEnvelope: t.volumeEnvelope,
        cachedAudioPath: t.cachedAudioPath ? toRelativePath(t.cachedAudioPath, baseDir) : null,
      };
      // Persist EDL clip state (v2+)
      if (t.clips && t.clips.length > 0) {
        base.clips = t.clips.map(c => ({
          id: c.id,
          clipStart: c.clipStart,
          duration: c.duration,
          sourceFile: stableSourcePath(c, t),
          sourceOffset: c.sourceOffset ?? 0,
          source_kind: sourceKind(c, t),
        }));
      }
      return base;
    });

    const now = new Date().toISOString();
    return {
      version: 2,
      name: projectName.value,
      createdAt: createdAt ?? now,
      modifiedAt: now,
      tracks,
      selection: {
        inPoint: selectionStore.inOutPoints.inPoint,
        outPoint: selectionStore.inOutPoints.outPoint,
      },
      silenceRegions: silenceStore.silenceRegions,
    };
  }

  // ── Save ────────────────────────────────────────────────────────────

  async function saveProject(): Promise<void> {
    if (!projectPath.value) {
      await saveProjectAs();
      return;
    }

    saving.value = true;
    error.value = null;
    try {
      const project = serializeProject();
      const json = JSON.stringify(project, null, 2);
      await invoke('save_project', { path: projectPath.value, json });
      createdAt = project.createdAt;
      dirty.value = false;
      updateWindowTitle();
      console.log(`[Project] Saved to ${projectPath.value}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      console.error('[Project] Save failed:', msg);
    } finally {
      saving.value = false;
    }
  }

  async function saveProjectAs(): Promise<void> {
    const result = await save({
      defaultPath: `${projectName.value}.clipdr`,
      filters: [{ name: 'Clip Dr. Project', extensions: ['clipdr'] }],
    });
    if (!result) return;

    projectPath.value = result;
    projectName.value = getBaseName(result);
    await saveProject();
  }

  // ── Open / Load ─────────────────────────────────────────────────────

  async function openProject(): Promise<void> {
    const result = await open({
      multiple: false,
      filters: [{ name: 'Clip Dr. Project', extensions: ['clipdr'] }],
    });
    if (!result || typeof result !== 'string') return;
    await loadProject(result);
  }

  async function loadProject(path: string): Promise<void> {
    loading.value = true;
    error.value = null;
    loadGuard = true;

    try {
      const json = await invoke<string>('load_project', { path });
      const project: ProjectFile = JSON.parse(json);

      // Validate version (1 = original, 2 = adds clip EDL state)
      if (project.version !== 1 && project.version !== 2) {
        throw new Error(`Unsupported project version: ${project.version}`);
      }

      // Stop playback and clear everything
      const playbackStore = usePlaybackStore();
      const audioStore = useAudioStore();
      const historyStore = useHistoryStore();
      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();
      const silenceStore = useSilenceStore();

      playbackStore.stop();
      audioStore.unloadAll();
      silenceStore.clearWithoutHistory();
      historyStore.clear();

      // Set project metadata
      projectPath.value = path;
      projectName.value = project.name;
      createdAt = project.createdAt;

      const baseDir = getDirectory(path);
      const errors: string[] = [];

      // Import each track
      for (const pt of project.tracks) {
        // Fallback chain: sourcePath > first clip sourceFile > cachedAudioPath
        const firstClipSource = pt.clips && pt.clips.length > 0 ? pt.clips[0].sourceFile : '';
        const effectiveSource = pt.sourcePath || firstClipSource || pt.cachedAudioPath || '';
        if (!effectiveSource) {
          errors.push(`Track "${pt.name}": no source path, clip source, or cached path — skipped`);
          continue;
        }

        const absPath = toAbsolutePath(effectiveSource, baseDir);

        try {
          await audioStore.importFile(absPath, pt.trackStart);

          // Find the just-imported track (last one added)
          const lastTrack = tracksStore.tracks[tracksStore.tracks.length - 1];
          if (lastTrack) {
            // Capture the import duration as sourceDuration BEFORE overwriting with
            // saved pt.duration. This is the full source file duration — needed by
            // finalizeClipWaveforms to correctly slice the parent waveform for clips
            // that reference arbitrary portions of the source (via sourceOffset).
            const importDuration = lastTrack.duration;
            if (!lastTrack.audioData.sourceDuration) {
              lastTrack.audioData.sourceDuration = importDuration;
            }

            // Apply saved metadata directly (no history for initial load)
            lastTrack.name = pt.name;
            lastTrack.color = pt.color;
            lastTrack.volume = pt.volume;
            lastTrack.muted = pt.muted;
            lastTrack.solo = pt.solo;
            if (pt.tag) lastTrack.tag = pt.tag;
            if (pt.timemarks) lastTrack.timemarks = pt.timemarks;
            if (pt.volumeEnvelope) lastTrack.volumeEnvelope = pt.volumeEnvelope;

            // Loader invariant: the saved pt.duration and pt.trackStart are the
            // authoritative timeline values — they were captured after VBR correction
            // at save time. The import bootstraps audio/waveform but its metadata
            // duration reflects the full source file, not the track's timeline extent.
            lastTrack.duration = pt.duration;
            lastTrack.trackStart = pt.trackStart;

            // v2: restore EDL clip state
            if (project.version === 2 && pt.clips && pt.clips.length > 0) {
              // Surface any temp-path clips as errors (source stability policy)
              const tempClips = pt.clips.filter(c => c.source_kind === 'temp');
              if (tempClips.length > 0) {
                errors.push(
                  `Track "${pt.name}": ${tempClips.length} clip(s) used a temp source path — needs relink`
                );
              }
              // Reconstruct clips with null buffers; waveforms filled by finalizeClipWaveforms
              const reconstructed: TrackClip[] = pt.clips.map(c => ({
                id: c.id,
                buffer: null,
                waveformData: [],
                clipStart: c.clipStart,
                duration: c.duration,
                sourceFile: c.sourceFile,
                sourceOffset: c.sourceOffset,
              }));
              tracksStore.setTrackClips(lastTrack.id, reconstructed);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`Track "${pt.name}" (${absPath}): ${msg}`);
        }
      }

      // Restore in/out points
      if (project.selection.inPoint !== null) {
        selectionStore.setInPoint(project.selection.inPoint);
      }
      if (project.selection.outPoint !== null) {
        selectionStore.setOutPoint(project.selection.outPoint);
      }

      // Restore silence regions
      if (project.silenceRegions && project.silenceRegions.length > 0) {
        silenceStore.setSilenceRegions(project.silenceRegions);
      }

      // Auto-load transcription sidecars for each track (fire-and-forget)
      const transcriptionStore = useTranscriptionStore();
      for (const track of tracksStore.tracks) {
        transcriptionStore.loadTranscriptionFromDisk(track.id).catch(e => {
          console.warn(`[Project] Failed to load transcription for ${track.name}:`, e);
        });
      }

      // Clear history for fresh undo stack
      historyStore.clear();

      // Report missing files
      if (errors.length > 0) {
        error.value = `Some tracks failed to load:\n${errors.join('\n')}`;
        console.warn('[Project] Load errors:', errors);
      }

      dirty.value = false;
      updateWindowTitle();
      console.log(`[Project] Loaded from ${path} (${project.tracks.length} tracks)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      console.error('[Project] Load failed:', msg);
    } finally {
      loading.value = false;
      loadGuard = false;
    }
  }

  // ── Rename ──────────────────────────────────────────────────────────

  function renameProject(name: string): void {
    projectName.value = name.trim() || 'Untitled';
    dirty.value = true;
    updateWindowTitle();
  }

  // ── New Project ─────────────────────────────────────────────────────

  async function newProject(opts?: { skipConfirm?: boolean }): Promise<void> {
    if (!opts?.skipConfirm && dirty.value) {
      const confirmed = await ask(
        'You have unsaved changes. Discard and start a new project?',
        { title: 'New Project', kind: 'warning' }
      );
      if (!confirmed) return;
    }

    loadGuard = true;
    try {
      const playbackStore = usePlaybackStore();
      const audioStore = useAudioStore();
      const historyStore = useHistoryStore();
      const tracksStore = useTracksStore();
      const selectionStore = useSelectionStore();
      const silenceStore = useSilenceStore();

      playbackStore.stop();
      audioStore.unloadAll();
      silenceStore.clearWithoutHistory();
      selectionStore.clearInOutPoints();
      historyStore.clear();

      projectPath.value = null;
      projectName.value = 'Untitled';
      createdAt = null;
      dirty.value = false;
      updateWindowTitle();
    } finally {
      loadGuard = false;
    }
  }

  // ── Window title ────────────────────────────────────────────────────

  function updateWindowTitle(): void {
    const dirtyMark = dirty.value ? ' *' : '';
    const name = projectPath.value ? projectName.value : '';
    const title = name ? `${name}${dirtyMark} - ${APP_TITLE}` : APP_TITLE;
    getCurrentWindow().setTitle(title).catch(() => {});
  }

  // ── Dirty tracking ──────────────────────────────────────────────────

  function setupDirtyTracking(): void {
    const tracksStore = useTracksStore();
    watch(
      () => tracksStore.tracks,
      () => {
        if (loadGuard) return;
        if (!dirty.value) {
          dirty.value = true;
          updateWindowTitle();
        }
      },
      { deep: true },
    );
  }

  // ── Close guard ────────────────────────────────────────────────────

  function setupCloseGuard(): void {
    const appWindow = getCurrentWindow();
    appWindow.onCloseRequested(async (event) => {
      if (!dirty.value) return;

      event.preventDefault();

      const shouldSave = await ask(
        'You have unsaved changes.\n\nSave before closing?',
        { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Save', cancelLabel: "Don't Save" },
      );

      if (shouldSave) {
        await saveProject();
      }

      // Defer destroy to next tick — calling destroy() from within the
      // onCloseRequested handler doesn't work because Tauri's Rust runtime
      // is still processing the close-request event.
      setTimeout(() => {
        appWindow.destroy().catch((e: unknown) => {
          console.error('[Project] destroy() failed:', e);
        });
      }, 0);
    });
  }

  return {
    projectPath,
    projectName,
    dirty,
    loading,
    saving,
    error,
    saveProject,
    saveProjectAs,
    openProject,
    loadProject,
    setupDirtyTracking,
    setupCloseGuard,
    renameProject,
    newProject,
  };
});
