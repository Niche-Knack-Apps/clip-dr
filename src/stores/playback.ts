import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSelectionStore } from './selection';
import { useTracksStore } from './tracks';
import { useSilenceStore } from './silence';
import { useMeterStore } from './meter';
import type { LoopMode } from '@/shared/constants';
import type { Track } from '@/shared/types';
import { isTrackPlayable } from '@/shared/utils';

export const usePlaybackStore = defineStore('playback', () => {
  const selectionStore = useSelectionStore();
  const tracksStore = useTracksStore();
  const silenceStore = useSilenceStore();

  const isPlaying = ref(false);
  const currentTime = ref(0);
  const loopEnabled = ref(true);
  const loopMode = ref<LoopMode>('full');
  const volume = ref(1);
  const isScrubbing = ref(false);

  // Speed control: positive = forward, negative = reverse
  const playbackSpeed = ref(1);
  const playDirection = ref(1);

  // Hold-to-play mode
  const holdMode = ref<'none' | 'forward' | 'reverse'>('none');
  const holdStartPosition = ref(0);

  // Position polling
  let positionPollId: number | null = null;

  // Track sync: hash of last synced track list to avoid redundant file reloads
  let lastSyncedTrackHash = '';

  const playbackTime = computed(() => currentTime.value);
  const loopStart = computed(() => selectionStore.selection.start);
  const loopEnd = computed(() => selectionStore.selection.end);
  const speed = computed(() => playbackSpeed.value);
  const isReversing = computed(() => playbackSpeed.value < 0);

  // Get effective duration from tracks
  function getEffectiveDuration(): number {
    return tracksStore.timelineDuration;
  }

  // Get all active tracks (respects mute/solo, excludes still-importing tracks)
  function getActiveTracks(): Track[] {
    const tracks = tracksStore.tracks;

    // Filter out tracks that are still importing (large files are OK — Rust engine handles them)
    const playable = tracks.filter(t => isTrackPlayable(t.importStatus));

    // Check if any track is soloed
    const soloedTracks = playable.filter(t => t.solo && !t.muted);
    if (soloedTracks.length > 0) {
      return soloedTracks;
    }

    // No solo - get all unmuted tracks
    return playable.filter(t => !t.muted);
  }

  // Get the active playback region (union of all active tracks)
  function getActiveRegion(): { start: number; end: number } {
    const activeTracks = getActiveTracks();

    if (activeTracks.length === 0) {
      return { start: 0, end: getEffectiveDuration() };
    }

    const start = Math.min(...activeTracks.map(t => t.trackStart));
    const end = Math.max(...activeTracks.map(t => t.trackStart + t.duration));
    return { start, end };
  }

  // Get loop region based on current loop mode
  function getLoopRegion(): { start: number; end: number } {
    switch (loopMode.value) {
      case 'zoom':
        return {
          start: selectionStore.selection.start,
          end: selectionStore.selection.end,
        };
      case 'inout': {
        const { inPoint, outPoint } = selectionStore.inOutPoints;
        if (inPoint !== null && outPoint !== null) {
          return { start: inPoint, end: outPoint };
        }
        return { start: 0, end: getEffectiveDuration() };
      }
      case 'active':
        return getActiveRegion();
      case 'clip': {
        // Loop on selected track if one is selected
        const selected = tracksStore.selectedTrack;
        if (selected) {
          return { start: selected.trackStart, end: selected.trackStart + selected.duration };
        }
        // Fall back to first track
        if (tracksStore.tracks.length > 0) {
          const track = tracksStore.tracks[0];
          return { start: track.trackStart, end: track.trackStart + track.duration };
        }
        return { start: 0, end: getEffectiveDuration() };
      }
      case 'full':
      default:
        return { start: 0, end: getEffectiveDuration() };
    }
  }

  // ── Rust engine sync ──

  // Get all tracks that can be played (have source path or clips with source files)
  function getPlayableTracks(): Track[] {
    return tracksStore.tracks.filter(t => {
      if (!isTrackPlayable(t.importStatus)) return false;
      // Playable if track has source OR any clip has sourceFile
      if (t.cachedAudioPath || t.sourcePath) return true;
      if (t.clips?.some(c => c.sourceFile)) return true;
      return false;
    });
  }

  function computeTrackHash(): string {
    return getPlayableTracks()
      .map(t => {
        const clips = tracksStore.getTrackClips(t.id);
        return clips.map(c =>
          `${t.id}:${c.id}:${c.sourceFile || t.cachedAudioPath || t.sourcePath || ''}:${c.clipStart.toFixed(4)}:${c.duration.toFixed(4)}:${(c.sourceOffset ?? 0).toFixed(4)}`
        ).join(';');
      })
      .sort()
      .join('|');
  }

  async function syncTracksToRust(): Promise<void> {
    const hash = computeTrackHash();
    if (hash === lastSyncedTrackHash) return;

    const playable = getPlayableTracks();
    const trackConfigs: { track_id: string; source_path: string; track_start: number; duration: number; file_offset: number; volume: number; muted: boolean; volume_envelope: { time: number; value: number }[] | null }[] = [];

    for (const t of playable) {
      const clips = tracksStore.getTrackClips(t.id);
      for (const clip of clips) {
        const sourcePath = clip.sourceFile || t.cachedAudioPath || t.sourcePath;
        if (!sourcePath) continue;

        trackConfigs.push({
          track_id: `${t.id}:${clip.id}`,
          source_path: sourcePath,
          track_start: clip.clipStart,
          duration: clip.duration,
          file_offset: clip.sourceOffset ?? 0,
          volume: t.volume,
          muted: false, // mute handled via playback_set_track_muted
          volume_envelope: t.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })) ?? null,
        });
      }
    }

    await invoke('playback_set_tracks', { tracks: trackConfigs });
    lastSyncedTrackHash = hash;

    // Sync mute/solo state after loading tracks
    await syncMuteSoloToRust();
  }

  async function syncMuteSoloToRust(): Promise<void> {
    const allTracks = tracksStore.tracks;
    const hasSolo = allTracks.some(t => t.solo && !t.muted);

    // Batch all mute updates into a single IPC call (PERF-08)
    const updates: { track_id: string; muted: boolean }[] = [];
    for (const track of getPlayableTracks()) {
      let muted = track.muted;
      if (hasSolo) {
        muted = !track.solo || track.muted;
      }
      const clips = tracksStore.getTrackClips(track.id);
      for (const clip of clips) {
        updates.push({ track_id: `${track.id}:${clip.id}`, muted });
      }
    }
    if (updates.length > 0) {
      await invoke('playback_set_muted_batch', { updates });
    }
  }

  async function syncLoopToRust(): Promise<void> {
    const region = loopEnabled.value ? getLoopRegion() : { start: 0, end: getEffectiveDuration() };
    await invoke('playback_set_loop', {
      enabled: loopEnabled.value,
      start: region.start,
      end: region.end,
    });
  }

  // ── Position polling ──

  function startPositionPoll(): void {
    stopPositionPoll();

    const poll = async () => {
      if (!isPlaying.value) return;

      try {
        let pos = await invoke<number>('playback_get_position');

        // Silence skipping
        if (silenceStore.compressionEnabled) {
          const skipFn = playbackSpeed.value > 0
            ? silenceStore.getNextSpeechTime
            : silenceStore.getPrevSpeechTime;
          const skipTo = skipFn(pos);
          if (skipTo !== pos) {
            await invoke('playback_seek', { position: skipTo });
            pos = skipTo;
          }
        }

        currentTime.value = pos;
      } catch (e) {
        console.warn('[Playback] Position poll error:', e);
      }

      if (isPlaying.value) {
        positionPollId = requestAnimationFrame(() => { poll(); });
      }
    };

    positionPollId = requestAnimationFrame(() => { poll(); });
  }

  function stopPositionPoll(): void {
    if (positionPollId !== null) {
      cancelAnimationFrame(positionPollId);
      positionPollId = null;
    }
  }

  // ── Playback controls ──

  async function play(): Promise<void> {
    // Guard against double-calls (race condition when button + Space pressed quickly)
    if (isPlaying.value) return;

    const activeTracks = getActiveTracks();
    console.log('[Playback] play() called, activeTracks:', activeTracks.length);

    if (activeTracks.length === 0) {
      console.log('[Playback] No playable tracks');
      return;
    }

    // Set playing flag immediately to prevent race conditions
    isPlaying.value = true;

    try {
      // Wait for any pending WAV recache from cut/delete to complete
      if (tracksStore.pendingRecache) {
        await tracksStore.pendingRecache;
      }

      // Sync state to Rust engine (only reloads files if track list changed)
      await syncTracksToRust();
      await syncLoopToRust();
      await invoke('playback_set_speed', { speed: playbackSpeed.value });
      await invoke('playback_set_volume', { volume: volume.value });

      // Clamp position to active region
      const region = getActiveRegion();
      let playStart = currentTime.value;
      if (playStart < region.start || playStart >= region.end) {
        playStart = playbackSpeed.value >= 0 ? region.start : region.end;
        currentTime.value = playStart;
      }

      await invoke('playback_seek', { position: playStart });
      await invoke('playback_play');

      startPositionPoll();
      useMeterStore().startPolling();
    } catch (err) {
      console.error('[Playback] play() failed:', err);
      isPlaying.value = false;
      stopPositionPoll();
    }
  }

  function pause(): void {
    invoke('playback_pause').catch(e => console.warn('[Playback] pause error:', e));
    stopPositionPoll();
    useMeterStore().stopPolling();
    isPlaying.value = false;
  }

  function stop(): void {
    pause();
    const region = getActiveRegion();
    currentTime.value = region.start;
    playbackSpeed.value = 1;
    playDirection.value = 1;
    invoke('playback_stop').catch(e => console.warn('[Playback] stop error:', e));
  }

  async function togglePlay(): Promise<void> {
    if (isPlaying.value) {
      pause();
    } else {
      // Always resume in forward direction at normal speed
      playbackSpeed.value = 1;
      playDirection.value = 1;
      await play();
    }
  }

  async function seek(time: number): Promise<void> {
    const wasPlaying = isPlaying.value;
    if (wasPlaying) {
      pause();
    }

    let seekTime = Math.max(0, Math.min(time, getEffectiveDuration()));

    // If skip-silence is enabled and seeking into silence, snap forward
    if (silenceStore.compressionEnabled) {
      seekTime = silenceStore.getNextSpeechTime(seekTime);
    }

    currentTime.value = seekTime;

    if (wasPlaying) {
      await play();
    }
  }

  async function seekToSelection(): Promise<void> {
    await seek(selectionStore.selection.start);
  }

  async function jumpToLayerStart(): Promise<void> {
    const region = getActiveRegion();
    await seek(region.start);
  }

  async function jumpToLayerEnd(): Promise<void> {
    const region = getActiveRegion();
    await seek(region.end);
  }

  function nudge(ms: number): void {
    const delta = (ms / 1000) * playDirection.value;
    const newTime = currentTime.value + delta;
    const region = getActiveRegion();
    currentTime.value = Math.max(region.start, Math.min(newTime, region.end));
  }

  async function speedUp(): Promise<void> {
    if (playbackSpeed.value < 0) {
      playbackSpeed.value = 1;
      playDirection.value = 1;
    } else if (playbackSpeed.value < 5) {
      playbackSpeed.value = Math.min(5, playbackSpeed.value + 1);
      playDirection.value = 1;
    }

    if (isPlaying.value) {
      await invoke('playback_set_speed', { speed: playbackSpeed.value });
    }
  }

  async function speedDown(): Promise<void> {
    if (playbackSpeed.value > 0) {
      playbackSpeed.value = -1;
      playDirection.value = -1;
    } else if (playbackSpeed.value > -5) {
      playbackSpeed.value = Math.max(-5, playbackSpeed.value - 1);
      playDirection.value = -1;
    }

    if (isPlaying.value) {
      // Just update speed — Rust engine handles negative speed natively
      await invoke('playback_set_speed', { speed: playbackSpeed.value });
    } else {
      // Start playing in reverse
      await play();
    }
  }

  async function resetSpeed(): Promise<void> {
    playbackSpeed.value = 1;
    playDirection.value = 1;

    if (isPlaying.value) {
      await invoke('playback_set_speed', { speed: 1.0 });
    }
  }

  function setVolume(newVolume: number): void {
    volume.value = Math.max(0, Math.min(3, newVolume));
    invoke('playback_set_volume', { volume: volume.value })
      .catch(e => console.warn('[Playback] volume error:', e));
  }

  async function setLoopEnabled(enabled: boolean): Promise<void> {
    loopEnabled.value = enabled;
    await syncLoopToRust();
  }

  async function setLoopMode(mode: LoopMode): Promise<void> {
    loopMode.value = mode;
    await syncLoopToRust();
  }

  function startScrubbing(): void {
    isScrubbing.value = true;
    if (isPlaying.value) {
      pause();
    }
  }

  function scrub(time: number): void {
    currentTime.value = Math.max(0, Math.min(time, getEffectiveDuration()));
  }

  function endScrubbing(): void {
    isScrubbing.value = false;
  }

  // Hold-to-play functions
  async function startHoldPlay(): Promise<void> {
    if (holdMode.value !== 'none') return;
    holdMode.value = 'forward';
    holdStartPosition.value = currentTime.value;
    await play();
  }

  function stopHoldPlay(): void {
    if (holdMode.value !== 'forward') return;
    holdMode.value = 'none';
    pause();
  }

  async function startHoldReverse(): Promise<void> {
    if (holdMode.value !== 'none') return;
    holdMode.value = 'reverse';
    holdStartPosition.value = currentTime.value;
    playbackSpeed.value = -1;
    playDirection.value = -1;
    await play();
  }

  function stopHoldReverse(): void {
    if (holdMode.value !== 'reverse') return;
    holdMode.value = 'none';
    pause();
    playbackSpeed.value = 1;
  }

  // JKL-style playback
  async function jklPlayAtSpeed(speed: number, reverse: boolean = false): Promise<void> {
    const targetSpeed = reverse ? -Math.abs(speed) : Math.abs(speed);

    if (isPlaying.value && playbackSpeed.value === targetSpeed) {
      return;
    }

    playbackSpeed.value = targetSpeed;
    playDirection.value = reverse ? -1 : 1;

    if (isPlaying.value) {
      // Just update speed on the running engine
      await invoke('playback_set_speed', { speed: targetSpeed });
    } else {
      await play();
    }
  }

  function jklStop(): void {
    pause();
    playbackSpeed.value = 1;
    playDirection.value = 1;
  }

  async function jumpToNextMarker(currentTimeVal?: number): Promise<void> {
    const time = currentTimeVal ?? currentTime.value;
    const allTracks = tracksStore.tracks;

    let nextTime: number | null = null;
    for (const track of allTracks) {
      if (!track.timemarks) continue;
      for (const mark of track.timemarks) {
        const markTime = mark.time + track.trackStart;
        if (markTime > time + 0.01) {
          if (nextTime === null || markTime < nextTime) {
            nextTime = markTime;
          }
        }
      }
    }

    if (nextTime !== null) {
      await seek(nextTime);
    }
  }

  async function jumpToPreviousMarker(currentTimeVal?: number): Promise<void> {
    const time = currentTimeVal ?? currentTime.value;
    const allTracks = tracksStore.tracks;

    let prevTime: number | null = null;
    for (const track of allTracks) {
      if (!track.timemarks) continue;
      for (const mark of track.timemarks) {
        const markTime = mark.time + track.trackStart;
        if (markTime < time - 0.01) {
          if (prevTime === null || markTime > prevTime) {
            prevTime = markTime;
          }
        }
      }
    }

    if (prevTime !== null) {
      await seek(prevTime);
    }
  }

  // Watch for track volume changes during playback — sync to Rust engine live
  // Uses hash-based approach (matching mute/solo watcher) to avoid deep comparison overhead
  let lastVolumeKey = 0;
  watch(
    () => {
      const tracks = tracksStore.tracks;
      let key = tracks.length;
      for (const t of tracks) {
        key = ((key << 5) - key + t.id.charCodeAt(0)) | 0;
        key = ((key << 5) - key + (t.volume * 10000 | 0)) | 0;
      }
      return key;
    },
    async (newKey) => {
      if (newKey === lastVolumeKey) return;
      lastVolumeKey = newKey;
      if (!isPlaying.value) return;
      for (const t of tracksStore.tracks) {
        await invoke('playback_set_track_volume', { trackId: t.id, volume: t.volume });
      }
    }
  );

  // Watch for volume envelope changes during playback — sync to Rust engine live
  // Uses numeric hash instead of string concatenation to avoid O(tracks*points) string ops per frame
  watch(
    () => {
      if (!isPlaying.value) return 0;
      const tracks = tracksStore.tracks;
      let hash = tracks.length;
      for (const t of tracks) {
        hash = ((hash << 5) - hash + t.id.charCodeAt(0)) | 0;
        const env = t.volumeEnvelope;
        if (env) {
          hash = ((hash << 5) - hash + env.length) | 0;
          for (const p of env) {
            // Hash time and value as integers (multiply by 1000 for 3-decimal precision)
            hash = ((hash << 5) - hash + (p.time * 1000 | 0)) | 0;
            hash = ((hash << 5) - hash + (p.value * 1000 | 0)) | 0;
          }
        }
      }
      return hash;
    },
    async (newHash, oldHash) => {
      if (newHash === oldHash || newHash === 0) return;
      // Determine which tracks changed and sync their envelopes
      for (const track of tracksStore.tracks) {
        const envelope = track.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })) ?? null;
        await invoke('playback_set_track_envelope', { trackId: track.id, envelope });
      }
    }
  );

  // Watch for track mute/solo changes during playback — sync to Rust engine
  let lastTracksKey = 0;
  watch(
    () => {
      const tracks = tracksStore.tracks;
      let key = tracks.length;
      for (const t of tracks) {
        key = ((key << 5) - key + t.id.charCodeAt(0)) | 0;
        if (t.muted) key = (key * 31 + 1) | 0;
        if (t.solo) key = (key * 31 + 2) | 0;
      }
      return key;
    },
    async (newKey) => {
      if (newKey === lastTracksKey) return;
      lastTracksKey = newKey;
      if (isPlaying.value) {
        await syncMuteSoloToRust();
      }
    }
  );

  // ── Output device routing ──
  const outputDeviceId = ref<string | null>(null);

  async function setOutputDevice(deviceId: string | null): Promise<void> {
    try {
      await invoke('playback_set_output_device', { deviceId });
      outputDeviceId.value = deviceId;
      console.log('[Playback] Output device set to:', deviceId || 'default');
    } catch (e) {
      console.error('[Playback] Failed to set output device:', e);
    }
  }

  async function loadOutputDevice(): Promise<void> {
    try {
      const id = await invoke<string | null>('playback_get_output_device');
      outputDeviceId.value = id;
    } catch {
      // Ignore
    }
  }

  // Load stored output device on init
  loadOutputDevice();

  return {
    isPlaying,
    currentTime,
    loopEnabled,
    loopMode,
    volume,
    isScrubbing,
    playbackSpeed,
    playDirection,
    holdMode,
    playbackTime,
    loopStart,
    loopEnd,
    speed,
    isReversing,
    play,
    pause,
    stop,
    togglePlay,
    seek,
    seekToSelection,
    jumpToLayerStart,
    jumpToLayerEnd,
    nudge,
    speedUp,
    speedDown,
    resetSpeed,
    setVolume,
    setLoopEnabled,
    setLoopMode,
    startScrubbing,
    scrub,
    endScrubbing,
    getActiveTracks,
    getActiveRegion,
    getLoopRegion,
    startHoldPlay,
    stopHoldPlay,
    startHoldReverse,
    stopHoldReverse,
    jklPlayAtSpeed,
    jklStop,
    jumpToNextMarker,
    jumpToPreviousMarker,
    // Output device routing
    outputDeviceId,
    setOutputDevice,
  };
});
