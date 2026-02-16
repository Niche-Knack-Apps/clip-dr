import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSelectionStore } from './selection';
import { useTracksStore } from './tracks';
import { useSilenceStore } from './silence';
import { useMeterStore } from './meter';
import type { LoopMode } from '@/shared/constants';
import type { Track } from '@/shared/types';

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
    const playable = tracks.filter(t => !t.importStatus || t.importStatus === 'ready' || t.importStatus === 'large-file' || t.importStatus === 'caching');

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

  // Get all tracks with sourcePath that can be loaded by Rust
  function getPlayableTracks(): Track[] {
    return tracksStore.tracks.filter(t =>
      t.sourcePath && (!t.importStatus || t.importStatus === 'ready' || t.importStatus === 'large-file' || t.importStatus === 'caching')
    );
  }

  function computeTrackHash(): string {
    return getPlayableTracks()
      .map(t => `${t.id}:${t.cachedAudioPath || t.sourcePath}`)
      .sort()
      .join('|');
  }

  async function syncTracksToRust(): Promise<void> {
    const hash = computeTrackHash();
    if (hash === lastSyncedTrackHash) return;

    const playable = getPlayableTracks();
    const trackConfigs = playable.map(t => ({
      track_id: t.id,
      source_path: t.cachedAudioPath || t.sourcePath!,
      track_start: t.trackStart,
      duration: t.duration,
      volume: t.volume,
      muted: false, // mute handled via playback_set_track_muted
      volume_envelope: t.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })) ?? null,
    }));

    await invoke('playback_set_tracks', { tracks: trackConfigs });
    lastSyncedTrackHash = hash;

    // Sync mute/solo state after loading tracks
    await syncMuteSoloToRust();
  }

  async function syncMuteSoloToRust(): Promise<void> {
    const allTracks = tracksStore.tracks;
    const hasSolo = allTracks.some(t => t.solo && !t.muted);

    for (const track of getPlayableTracks()) {
      let muted = track.muted;
      if (hasSolo) {
        muted = !track.solo || track.muted;
      }
      await invoke('playback_set_track_muted', {
        trackId: track.id,
        muted,
      });
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

    const playT0 = performance.now();

    // Sync state to Rust engine (only reloads files if track list changed)
    console.log('[Playback] syncTracksToRust starting');
    await syncTracksToRust();
    console.log(`[Playback] syncTracksToRust complete in ${(performance.now() - playT0).toFixed(0)}ms`);
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

    console.log(`[Playback] Audio started in ${(performance.now() - playT0).toFixed(0)}ms from play() call`);
    startPositionPoll();
    useMeterStore().startPolling();
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
    volume.value = Math.max(0, Math.min(1, newVolume));
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

  // Debug function
  function testAudioOutput(): void {
    const freshCtx = new AudioContext();
    freshCtx.resume().then(() => {
      const osc = freshCtx.createOscillator();
      const testGain = freshCtx.createGain();
      testGain.gain.value = 0.3;
      osc.frequency.value = 440;
      osc.connect(testGain);
      testGain.connect(freshCtx.destination);
      osc.start();
      osc.stop(freshCtx.currentTime + 1);
      console.log('[Playback] Test tone played');
    });
  }

  // Watch for track volume changes during playback — sync to Rust engine live
  watch(
    () => tracksStore.tracks.map(t => ({ id: t.id, volume: t.volume })),
    async (newVols, oldVols) => {
      if (!isPlaying.value || !oldVols) return;
      for (let i = 0; i < newVols.length; i++) {
        const nv = newVols[i];
        const ov = oldVols.find(o => o.id === nv.id);
        if (ov && ov.volume !== nv.volume) {
          await invoke('playback_set_track_volume', { trackId: nv.id, volume: nv.volume });
        }
      }
    },
    { deep: true }
  );

  // Watch for volume envelope changes during playback — sync to Rust engine live
  watch(
    () => tracksStore.tracks.map(t => ({
      id: t.id,
      env: t.volumeEnvelope ? t.volumeEnvelope.map(p => `${p.time}:${p.value}`).join(',') : '',
    })),
    async (newEnvs, oldEnvs) => {
      if (!isPlaying.value || !oldEnvs) return;
      for (let i = 0; i < newEnvs.length; i++) {
        const ne = newEnvs[i];
        const oe = oldEnvs.find(o => o.id === ne.id);
        if (oe && oe.env !== ne.env) {
          const track = tracksStore.tracks.find(t => t.id === ne.id);
          const envelope = track?.volumeEnvelope?.map(p => ({ time: p.time, value: p.value })) ?? null;
          await invoke('playback_set_track_envelope', { trackId: ne.id, envelope });
        }
      }
    },
    { deep: true }
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
    testAudioOutput,
    startHoldPlay,
    stopHoldPlay,
    startHoldReverse,
    stopHoldReverse,
    jklPlayAtSpeed,
    jklStop,
    jumpToNextMarker,
    jumpToPreviousMarker,
  };
});
