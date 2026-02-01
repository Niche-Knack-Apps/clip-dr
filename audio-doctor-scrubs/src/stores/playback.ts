import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useAudioStore } from './audio';
import { useSelectionStore } from './selection';
import { useTracksStore } from './tracks';
import { useCleaningStore } from './cleaning';
import type { LoopMode } from '@/shared/constants';

export const usePlaybackStore = defineStore('playback', () => {
  const audioStore = useAudioStore();
  const selectionStore = useSelectionStore();
  const tracksStore = useTracksStore();

  const isPlaying = ref(false);
  const currentTime = ref(0);
  const loopEnabled = ref(true);
  const loopMode = ref<LoopMode>('full'); // full, zoom, inout, active
  const volume = ref(1);
  const isScrubbing = ref(false);

  // Speed control: positive = forward, negative = reverse
  // Values: -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5
  const playbackSpeed = ref(1);
  const playDirection = ref(1); // 1 = forward, -1 = reverse (for nudge)

  let sourceNode: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let startTime = 0;
  let startOffset = 0;
  let rafId: number | null = null;

  const playbackTime = computed(() => currentTime.value);
  const loopStart = computed(() => selectionStore.selection.start);
  const loopEnd = computed(() => selectionStore.selection.end);
  const speed = computed(() => playbackSpeed.value);
  const isReversing = computed(() => playbackSpeed.value < 0);

  // Get all active tracks (respects mute/solo), sorted by start time
  function getActiveTracks() {
    const tracks = tracksStore.tracks;

    // Check if any track is soloed
    const soloedTracks = tracks.filter(t => t.solo && !t.muted);
    if (soloedTracks.length > 0) {
      return soloedTracks.sort((a, b) => a.start - b.start);
    }

    // No solo - get all unmuted tracks
    const unmutedTracks = tracks.filter(t => !t.muted);
    return unmutedTracks.sort((a, b) => a.start - b.start);
  }

  // Find the active track to play (for single track operations)
  function getActiveTrack() {
    const activeTracks = getActiveTracks();
    if (activeTracks.length === 0) return null;

    // Find track at current time, or first track
    const atTime = activeTracks.find(t => currentTime.value >= t.start && currentTime.value < t.end);
    return atTime || activeTracks[0];
  }

  // Get the track that should be playing at a given time
  function getTrackAtTime(time: number) {
    const activeTracks = getActiveTracks();
    return activeTracks.find(t => time >= t.start && time < t.end) || null;
  }

  // Get combined region boundaries for all active tracks
  function getActiveRegion() {
    const activeTracks = getActiveTracks();

    if (activeTracks.length === 0) {
      return { start: 0, end: audioStore.duration };
    }

    // Check if full track is active and not muted
    const fullTrack = activeTracks.find(t => t.type === 'full');
    if (fullTrack) {
      return { start: 0, end: audioStore.duration };
    }

    // Get combined bounds of all clip tracks
    const start = Math.min(...activeTracks.map(t => t.start));
    const end = Math.max(...activeTracks.map(t => t.end));
    return { start, end };
  }

  // Get loop region based on current loop mode
  function getLoopRegion() {
    switch (loopMode.value) {
      case 'zoom':
        // Loop within the zoomed view (selection)
        return {
          start: selectionStore.selection.start,
          end: selectionStore.selection.end,
        };
      case 'inout':
        // Loop between in/out points if set
        const { inPoint, outPoint } = selectionStore.inOutPoints;
        if (inPoint !== null && outPoint !== null) {
          return { start: inPoint, end: outPoint };
        }
        // Fall back to full if no in/out set
        return { start: 0, end: audioStore.duration };
      case 'active':
        // Loop across active (non-muted) tracks
        return getActiveRegion();
      case 'full':
      default:
        // Loop the full audio
        return { start: 0, end: audioStore.duration };
    }
  }

  async function setLoopMode(mode: LoopMode): Promise<void> {
    loopMode.value = mode;
    // If playing, restart to apply new loop region
    if (isPlaying.value) {
      const time = currentTime.value;
      pause();
      currentTime.value = time;
      await play();
    }
  }

  // Track the currently playing track for seamless switching
  let currentPlayingTrackId: string | null = null;

  // Get the appropriate audio buffer for a specific track
  function getBufferForTrack(track: typeof tracksStore.selectedTrack): AudioBuffer | null {
    if (!track) return null;

    const cleaningStore = useCleaningStore();

    // Check if this track has cleaned audio
    const cleanedBuffer = cleaningStore.getBufferForTrack(track.id);
    if (cleanedBuffer) {
      return cleanedBuffer;
    }

    // Fall back to main audio buffer
    return audioStore.getAudioBuffer();
  }

  // Get the appropriate audio buffer for playback at current time
  function getPlaybackBuffer(): { buffer: AudioBuffer; track: typeof tracksStore.selectedTrack } | null {
    const track = getTrackAtTime(currentTime.value) || getActiveTrack();

    if (!track) {
      // All tracks muted - no playback
      return null;
    }

    const buffer = getBufferForTrack(track);
    if (buffer) {
      return { buffer, track };
    }

    return null;
  }

  async function play(): Promise<void> {
    const activeTracks = getActiveTracks();
    if (activeTracks.length === 0) {
      console.log('No playable tracks (all muted)');
      return;
    }

    // Resume audio context if suspended (required for packaged apps)
    await audioStore.resumeAudioContext();

    const ctx = audioStore.getAudioContext();

    // Stop any existing playback without resetting position
    stopPlayback();

    // Determine playback region (spans all active tracks)
    const region = getActiveRegion();
    const regionStart = region.start;
    const regionEnd = region.end;

    // Keep current position if within region, otherwise start at region start
    let playStart = currentTime.value;
    if (playStart < regionStart || playStart >= regionEnd) {
      playStart = playbackSpeed.value >= 0 ? regionStart : regionEnd;
      currentTime.value = playStart;
    }

    // Find the track at the current playback position
    const trackAtTime = getTrackAtTime(playStart);

    if (trackAtTime) {
      const buffer = getBufferForTrack(trackAtTime);
      if (!buffer) {
        console.log('No buffer for track');
        return;
      }

      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = buffer;

      const absSpeed = Math.abs(playbackSpeed.value) || 1;
      sourceNode.playbackRate.value = absSpeed;

      gainNode = ctx.createGain();
      gainNode.gain.value = volume.value * (trackAtTime.volume ?? 1);

      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      // Calculate buffer offset
      const cleaningStore = useCleaningStore();
      const isCleanedTrack = cleaningStore.hasCleanedAudio(trackAtTime.id);

      let bufferOffset: number;
      if (isCleanedTrack) {
        bufferOffset = playStart - trackAtTime.start;
      } else {
        bufferOffset = playStart;
      }

      // For multi-track, we handle looping in the time update
      // Only set native loop if there's a single track
      if (loopEnabled.value && playbackSpeed.value > 0 && activeTracks.length === 1) {
        sourceNode.loop = true;
        if (isCleanedTrack) {
          sourceNode.loopStart = 0;
          sourceNode.loopEnd = trackAtTime.end - trackAtTime.start;
        } else {
          sourceNode.loopStart = trackAtTime.start;
          sourceNode.loopEnd = trackAtTime.end;
        }
      }

      sourceNode.start(0, Math.max(0, bufferOffset));
      currentPlayingTrackId = trackAtTime.id;

      sourceNode.onended = () => {
        // Check if we should continue to next track or loop
        if (isPlaying.value && loopEnabled.value) {
          // Time update will handle track switching
        } else if (!loopEnabled.value) {
          // Check if playhead is at end
          const currentTrack = getTrackAtTime(currentTime.value);
          if (!currentTrack) {
            isPlaying.value = false;
          }
        }
      };
    }

    startTime = ctx.currentTime;
    startOffset = playStart;
    isPlaying.value = true;

    startTimeUpdate();
  }

  function stopPlayback(): void {
    if (sourceNode) {
      try {
        sourceNode.stop();
        sourceNode.disconnect();
      } catch (e) {
        // Ignore errors if already stopped
      }
      sourceNode = null;
    }
    currentPlayingTrackId = null;
    stopTimeUpdate();
  }

  function pause(): void {
    stopPlayback();
    isPlaying.value = false;
    // Don't reset currentTime - keep position
  }

  function stop(): void {
    pause();
    const region = getActiveRegion();
    currentTime.value = region.start;
    playbackSpeed.value = 1;
    playDirection.value = 1;
  }

  async function togglePlay(): Promise<void> {
    if (isPlaying.value) {
      pause();
    } else {
      // Resume from current position
      if (playbackSpeed.value === 0) {
        playbackSpeed.value = playDirection.value;
      }
      await play();
    }
  }

  async function seek(time: number): Promise<void> {
    const wasPlaying = isPlaying.value;
    if (wasPlaying) {
      pause();
    }

    currentTime.value = Math.max(0, Math.min(time, audioStore.duration));

    if (wasPlaying) {
      await play();
    }
  }

  async function seekToSelection(): Promise<void> {
    await seek(selectionStore.selection.start);
  }

  // Jump to start of active layer/track
  async function jumpToLayerStart(): Promise<void> {
    const region = getActiveRegion();
    await seek(region.start);
  }

  // Jump to end of active layer/track
  async function jumpToLayerEnd(): Promise<void> {
    const region = getActiveRegion();
    await seek(region.end);
  }

  // Nudge playhead by milliseconds in current direction
  function nudge(ms: number): void {
    const delta = (ms / 1000) * playDirection.value;
    const newTime = currentTime.value + delta;
    const region = getActiveRegion();
    currentTime.value = Math.max(region.start, Math.min(newTime, region.end));
  }

  // Increase forward speed (1x -> 2x -> 3x -> 4x -> 5x)
  async function speedUp(): Promise<void> {
    const wasPlaying = isPlaying.value;

    if (playbackSpeed.value < 0) {
      // Coming from reverse, go to 1x forward
      playbackSpeed.value = 1;
      playDirection.value = 1;
    } else if (playbackSpeed.value < 5) {
      playbackSpeed.value = Math.min(5, playbackSpeed.value + 1);
      playDirection.value = 1;
    }

    if (wasPlaying) {
      pause();
      await play();
    }
  }

  // Increase reverse speed (-1x -> -2x -> -3x -> -4x -> -5x)
  function speedDown(): void {
    const wasPlaying = isPlaying.value;

    if (playbackSpeed.value > 0) {
      // Coming from forward, go to 1x reverse
      playbackSpeed.value = -1;
      playDirection.value = -1;
    } else if (playbackSpeed.value > -5) {
      playbackSpeed.value = Math.max(-5, playbackSpeed.value - 1);
      playDirection.value = -1;
    }

    // For reverse playback, we need special handling
    if (wasPlaying) {
      pause();
      // Reverse playback requires manual time updates
      startReversePlayback();
    }
  }

  // Reset speed to 1x
  async function resetSpeed(): Promise<void> {
    const wasPlaying = isPlaying.value;
    playbackSpeed.value = 1;
    playDirection.value = 1;
    if (wasPlaying) {
      pause();
      await play();
    }
  }

  function setVolume(newVolume: number): void {
    volume.value = Math.max(0, Math.min(1, newVolume));
    if (gainNode) {
      gainNode.gain.value = volume.value;
    }
  }

  async function setLoopEnabled(enabled: boolean): Promise<void> {
    loopEnabled.value = enabled;
    if (isPlaying.value) {
      const time = currentTime.value;
      pause();
      currentTime.value = time;
      await play();
    }
  }

  function startScrubbing(): void {
    isScrubbing.value = true;
    if (isPlaying.value) {
      pause();
    }
  }

  function scrub(time: number): void {
    currentTime.value = Math.max(0, Math.min(time, audioStore.duration));
  }

  function endScrubbing(): void {
    isScrubbing.value = false;
  }

  function startTimeUpdate(): void {
    const ctx = audioStore.getAudioContext();

    const update = () => {
      if (!isPlaying.value) return;

      // Use loop region for boundaries when looping, active region otherwise
      const region = loopEnabled.value ? getLoopRegion() : getActiveRegion();
      const elapsed = ctx.currentTime - startTime;
      const absSpeed = Math.abs(playbackSpeed.value) || 1;
      let newTime = startOffset + (elapsed * absSpeed * Math.sign(playbackSpeed.value));
      let needsRestart = false;

      // Handle boundaries
      if (playbackSpeed.value > 0) {
        // Forward playback
        if (loopEnabled.value) {
          if (newTime >= region.end) {
            // Loop back to start
            newTime = region.start;
            needsRestart = true;
          }
        } else if (newTime >= region.end) {
          newTime = region.end;
          pause();
        }
      } else {
        // Reverse playback
        if (loopEnabled.value) {
          if (newTime < region.start) {
            // Loop back to end
            newTime = region.end;
            needsRestart = true;
          }
        } else if (newTime <= region.start) {
          newTime = region.start;
          pause();
        }
      }

      currentTime.value = newTime;

      // If we hit a loop boundary, restart the audio at the new position
      if (needsRestart) {
        startTime = ctx.currentTime;
        startOffset = newTime;
        const trackAtTime = getTrackAtTime(newTime);
        if (trackAtTime) {
          switchToTrack(trackAtTime, newTime);
        }
      } else {
        // Check if we need to switch tracks
        const trackAtTime = getTrackAtTime(newTime);
        if (trackAtTime && trackAtTime.id !== currentPlayingTrackId) {
          // Switch to new track
          switchToTrack(trackAtTime, newTime);
        }
      }

      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);
  }

  // Switch playback to a different track seamlessly
  function switchToTrack(track: typeof tracksStore.selectedTrack, time: number): void {
    if (!track) return;

    const ctx = audioStore.getAudioContext();
    const cleaningStore = useCleaningStore();

    // Stop current source
    if (sourceNode) {
      try {
        sourceNode.stop();
        sourceNode.disconnect();
      } catch (e) {
        // Ignore
      }
    }

    const buffer = getBufferForTrack(track);
    if (!buffer) return;

    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;

    const absSpeed = Math.abs(playbackSpeed.value) || 1;
    sourceNode.playbackRate.value = absSpeed;

    if (!gainNode) {
      gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
    }
    gainNode.gain.value = volume.value * (track.volume ?? 1);

    sourceNode.connect(gainNode);

    // Calculate buffer offset
    const isCleanedTrack = cleaningStore.hasCleanedAudio(track.id);
    let bufferOffset: number;
    if (isCleanedTrack) {
      bufferOffset = time - track.start;
    } else {
      bufferOffset = time;
    }

    // Set up looping if enabled
    if (loopEnabled.value && playbackSpeed.value > 0) {
      sourceNode.loop = true;
      if (isCleanedTrack) {
        sourceNode.loopStart = 0;
        sourceNode.loopEnd = track.end - track.start;
      } else {
        sourceNode.loopStart = track.start;
        sourceNode.loopEnd = track.end;
      }
    }

    sourceNode.start(0, Math.max(0, bufferOffset));
    currentPlayingTrackId = track.id;

    sourceNode.onended = () => {
      if (!loopEnabled.value && !isPlaying.value) {
        isPlaying.value = false;
      }
    };
  }

  // For reverse playback without audio (visual scrubbing)
  function startReversePlayback(): void {
    isPlaying.value = true;
    startTime = audioStore.getAudioContext().currentTime;
    startOffset = currentTime.value;
    startTimeUpdate();
    // Note: Audio won't play in reverse, only visual timeline moves
  }

  function stopTimeUpdate(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  watch(
    () => selectionStore.selection,
    () => {
      if (isPlaying.value && loopEnabled.value) {
        const time = currentTime.value;
        pause();
        currentTime.value = time;
        play();
      }
    },
    { deep: true }
  );

  // Restart playback when track mute/solo changes
  watch(
    () => tracksStore.tracks.map(t => ({ id: t.id, muted: t.muted, solo: t.solo })),
    () => {
      if (isPlaying.value) {
        const time = currentTime.value;
        pause();
        currentTime.value = time;
        play();
      }
    },
    { deep: true }
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
    getActiveTrack,
    getActiveTracks,
    getActiveRegion,
    getLoopRegion,
  };
});
