import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ProjectFile, ProjectTrack } from '@/shared/types';
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

  function serializeProject(): ProjectFile {
    const tracksStore = useTracksStore();
    const selectionStore = useSelectionStore();
    const silenceStore = useSilenceStore();

    const baseDir = projectPath.value ? getDirectory(projectPath.value) : '.';

    const tracks: ProjectTrack[] = tracksStore.tracks.map(t => ({
      id: t.id,
      name: t.name,
      sourcePath: t.sourcePath ? toRelativePath(t.sourcePath, baseDir) : '',
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
    }));

    const now = new Date().toISOString();
    return {
      version: 1,
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

      // Validate version
      if (project.version !== 1) {
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
        if (!pt.sourcePath) {
          errors.push(`Track "${pt.name}": no source path`);
          continue;
        }

        const absPath = toAbsolutePath(pt.sourcePath, baseDir);

        try {
          await audioStore.importFile(absPath, pt.trackStart);

          // Find the just-imported track (last one added)
          const lastTrack = tracksStore.tracks[tracksStore.tracks.length - 1];
          if (lastTrack) {
            // Apply saved metadata directly (no history for initial load)
            lastTrack.name = pt.name;
            lastTrack.color = pt.color;
            lastTrack.volume = pt.volume;
            lastTrack.muted = pt.muted;
            lastTrack.solo = pt.solo;
            if (pt.tag) lastTrack.tag = pt.tag;
            if (pt.timemarks) lastTrack.timemarks = pt.timemarks;
            if (pt.volumeEnvelope) lastTrack.volumeEnvelope = pt.volumeEnvelope;
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
  };
});
