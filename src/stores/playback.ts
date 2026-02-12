import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useAudioStore } from './audio';
import { useSelectionStore } from './selection';
import { useTracksStore } from './tracks';
import type { LoopMode } from '@/shared/constants';
import type { Track } from '@/shared/types';

interface TrackPlaybackNode {
  trackId: string;
  clipId: string;
  sourceNode: AudioBufferSourceNode;
  gainNode: GainNode;
}

export const usePlaybackStore = defineStore('playback', () => {
  const audioStore = useAudioStore();
  const selectionStore = useSelectionStore();
  const tracksStore = useTracksStore();

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

  // Multi-track playback nodes
  let activeNodes: TrackPlaybackNode[] = [];
  let masterGain: GainNode | null = null;
  let startTime = 0;
  let startOffset = 0;
  let rafId: number | null = null;

  // Reverse scrub state - plays short audio snippets as playhead moves backward
  let reverseScrubInterval: number | null = null;
  let scrubSource: AudioBufferSourceNode | null = null;
  let scrubGainNode: GainNode | null = null;

  const playbackTime = computed(() => currentTime.value);
  const loopStart = computed(() => selectionStore.selection.start);
  const loopEnd = computed(() => selectionStore.selection.end);
  const speed = computed(() => playbackSpeed.value);
  const isReversing = computed(() => playbackSpeed.value < 0);

  // Get effective duration from tracks
  function getEffectiveDuration(): number {
    return tracksStore.timelineDuration;
  }

  // Get all active tracks (respects mute/solo)
  function getActiveTracks(): Track[] {
    const tracks = tracksStore.tracks;

    // Check if any track is soloed
    const soloedTracks = tracks.filter(t => t.solo && !t.muted);
    if (soloedTracks.length > 0) {
      return soloedTracks;
    }

    // No solo - get all unmuted tracks
    return tracks.filter(t => !t.muted);
  }

  // Get clips that are active at a specific time (handles both multi-clip and single-buffer tracks)
  function getClipsAtTime(time: number): Array<{ track: Track; clipId: string; buffer: AudioBuffer; clipStart: number; duration: number }> {
    const result: Array<{ track: Track; clipId: string; buffer: AudioBuffer; clipStart: number; duration: number }> = [];

    for (const track of getActiveTracks()) {
      const clips = tracksStore.getTrackClips(track.id);
      for (const clip of clips) {
        const clipEnd = clip.clipStart + clip.duration;
        if (time >= clip.clipStart && time < clipEnd) {
          result.push({
            track,
            clipId: clip.id,
            buffer: clip.buffer,
            clipStart: clip.clipStart,
            duration: clip.duration,
          });
        }
      }
    }

    return result;
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

  async function setLoopMode(mode: LoopMode): Promise<void> {
    loopMode.value = mode;

    if (isPlaying.value) {
      const time = currentTime.value;
      pause();
      currentTime.value = time;
      await play();
    }
  }

  // Stop all active playback nodes
  function stopAllNodes(): void {
    for (const node of activeNodes) {
      try {
        node.sourceNode.stop();
        node.sourceNode.disconnect();
        node.gainNode.disconnect();
      } catch (e) {
        // Ignore errors if already stopped
      }
    }
    activeNodes = [];
  }

  // Create playback node for a clip (or single-buffer track)
  function createClipNode(
    track: Track,
    clipId: string,
    buffer: AudioBuffer,
    offsetInClip: number,
    ctx: AudioContext
  ): TrackPlaybackNode | null {
    if (!buffer) return null;

    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;

    const absSpeed = Math.abs(playbackSpeed.value) || 1;
    sourceNode.playbackRate.value = absSpeed;

    const gainNode = ctx.createGain();
    gainNode.gain.value = track.volume * volume.value;

    sourceNode.connect(gainNode);
    if (masterGain) {
      gainNode.connect(masterGain);
    }

    // Start at the correct offset within the clip buffer
    const safeOffset = Math.max(0, Math.min(offsetInClip, buffer.duration - 0.001));
    sourceNode.start(0, safeOffset);

    return {
      trackId: track.id,
      clipId,
      sourceNode,
      gainNode,
    };
  }

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

    await audioStore.resumeAudioContext();
    const ctx = audioStore.getAudioContext();

    if (ctx.state !== 'running') {
      await ctx.resume();
    }

    // Stop any existing playback
    stopAllNodes();

    // Create master gain if needed
    if (!masterGain) {
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
    }
    masterGain.gain.value = volume.value;

    // Determine playback region
    const region = getActiveRegion();
    let playStart = currentTime.value;

    // Clamp to region
    if (playStart < region.start || playStart >= region.end) {
      playStart = playbackSpeed.value >= 0 ? region.start : region.end;
      currentTime.value = playStart;
    }

    // Start playback nodes for clips that are active at the current time
    const clipsAtTime = getClipsAtTime(playStart);

    for (const { track, clipId, buffer, clipStart } of clipsAtTime) {
      const offsetInClip = playStart - clipStart;
      const node = createClipNode(track, clipId, buffer, offsetInClip, ctx);
      if (node) {
        activeNodes.push(node);
        console.log('[Playback] Started clip:', clipId, 'of track:', track.name, 'at offset:', offsetInClip);
      }
    }

    startTime = ctx.currentTime;
    startOffset = playStart;

    startTimeUpdate();
  }

  function pause(): void {
    stopAllNodes();
    stopReverseScrub();
    stopTimeUpdate();
    isPlaying.value = false;
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

    const seekTime = Math.max(0, Math.min(time, getEffectiveDuration()));
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
    const wasPlaying = isPlaying.value;

    // Re-anchor timing before speed change to prevent playhead jump
    if (wasPlaying) {
      const ctx = audioStore.getAudioContext();
      startOffset = currentTime.value;
      startTime = ctx.currentTime;
    }

    if (playbackSpeed.value < 0) {
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

  function speedDown(): void {
    const wasPlaying = isPlaying.value;

    // Re-anchor timing before speed change to prevent playhead jump
    if (wasPlaying) {
      const ctx = audioStore.getAudioContext();
      startOffset = currentTime.value;
      startTime = ctx.currentTime;
    }

    if (playbackSpeed.value > 0) {
      playbackSpeed.value = -1;
      playDirection.value = -1;
    } else if (playbackSpeed.value > -5) {
      playbackSpeed.value = Math.max(-5, playbackSpeed.value - 1);
      playDirection.value = -1;
    }

    if (wasPlaying) {
      pause();
    }
    startReversePlayback();
  }

  async function resetSpeed(): Promise<void> {
    const wasPlaying = isPlaying.value;

    // Re-anchor timing before speed change to prevent playhead jump
    if (wasPlaying) {
      const ctx = audioStore.getAudioContext();
      startOffset = currentTime.value;
      startTime = ctx.currentTime;
    }

    playbackSpeed.value = 1;
    playDirection.value = 1;
    if (wasPlaying) {
      pause();
      await play();
    }
  }

  function setVolume(newVolume: number): void {
    volume.value = Math.max(0, Math.min(1, newVolume));
    if (masterGain) {
      masterGain.gain.value = volume.value;
    }
    // Update individual track gains
    for (const node of activeNodes) {
      const track = tracksStore.tracks.find(t => t.id === node.trackId);
      if (track) {
        node.gainNode.gain.value = track.volume * volume.value;
      }
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
    currentTime.value = Math.max(0, Math.min(time, getEffectiveDuration()));
  }

  function endScrubbing(): void {
    isScrubbing.value = false;
  }

  function startTimeUpdate(): void {
    const ctx = audioStore.getAudioContext();

    const update = () => {
      if (!isPlaying.value) return;

      const region = loopEnabled.value ? getLoopRegion() : getActiveRegion();
      const elapsed = ctx.currentTime - startTime;
      const absSpeed = Math.abs(playbackSpeed.value) || 1;
      let newTime = startOffset + (elapsed * absSpeed * Math.sign(playbackSpeed.value));
      let needsRestart = false;

      // Handle boundaries
      if (playbackSpeed.value > 0) {
        if (loopEnabled.value && newTime >= region.end) {
          newTime = region.start;
          needsRestart = true;
        } else if (!loopEnabled.value && newTime >= region.end) {
          newTime = region.end;
          pause();
        }
      } else {
        if (loopEnabled.value && newTime < region.start) {
          newTime = region.end;
          needsRestart = true;
        } else if (!loopEnabled.value && newTime <= region.start) {
          newTime = region.start;
          pause();
        }
      }

      currentTime.value = newTime;

      // Only manage continuous clip playback for forward direction.
      // Reverse playback uses scrub snippets instead (handled by startReverseScrub).
      if (playbackSpeed.value > 0) {
        // Check if clips have changed at current time
        const clipsAtTime = getClipsAtTime(newTime);
        const activeClipIds = new Set(activeNodes.map(n => n.clipId));
        const targetClipIds = new Set(clipsAtTime.map(c => c.clipId));

        // Start new clips that weren't playing
        for (const { track, clipId, buffer, clipStart } of clipsAtTime) {
          if (!activeClipIds.has(clipId)) {
            const offsetInClip = newTime - clipStart;
            const node = createClipNode(track, clipId, buffer, offsetInClip, ctx);
            if (node) {
              activeNodes.push(node);
              console.log('[Playback] Started new clip:', clipId);
            }
          }
        }

        // Stop clips that ended
        const nodesToRemove: TrackPlaybackNode[] = [];
        for (const node of activeNodes) {
          if (!targetClipIds.has(node.clipId)) {
            try {
              node.sourceNode.stop();
              node.sourceNode.disconnect();
              node.gainNode.disconnect();
            } catch (e) {
              // Ignore
            }
            nodesToRemove.push(node);
          }
        }
        activeNodes = activeNodes.filter(n => !nodesToRemove.includes(n));

        // Restart if we looped
        if (needsRestart) {
          startTime = ctx.currentTime;
          startOffset = newTime;
          // Restart all clips at new position
          stopAllNodes();
          const clipsAtNewTime = getClipsAtTime(newTime);
          for (const { track, clipId, buffer, clipStart } of clipsAtNewTime) {
            const offsetInClip = newTime - clipStart;
            const node = createClipNode(track, clipId, buffer, offsetInClip, ctx);
            if (node) {
              activeNodes.push(node);
            }
          }
        }
      } else if (needsRestart) {
        // For reverse looping, just reset timing
        startTime = ctx.currentTime;
        startOffset = newTime;
      }

      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);
  }

  function startReversePlayback(): void {
    isPlaying.value = true;
    const ctx = audioStore.getAudioContext();
    startTime = ctx.currentTime;
    startOffset = currentTime.value;

    // Ensure master gain exists for reverse scrub audio
    if (!masterGain) {
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
    }
    masterGain.gain.value = volume.value;

    startTimeUpdate();
    startReverseScrub();
  }

  // Play short audio snippets as the playhead scrubs backward
  function startReverseScrub(): void {
    stopReverseScrub();

    const SCRUB_INTERVAL = 80; // ms between snippets
    const SNIPPET_DURATION = 0.08; // 80ms snippets

    reverseScrubInterval = window.setInterval(() => {
      if (!isPlaying.value || playbackSpeed.value >= 0) {
        stopReverseScrub();
        return;
      }

      // Stop previous snippet
      if (scrubSource) {
        try { scrubSource.stop(); scrubSource.disconnect(); } catch {}
        scrubSource = null;
      }
      if (scrubGainNode) {
        try { scrubGainNode.disconnect(); } catch {}
        scrubGainNode = null;
      }

      // Play a short snippet from the current playhead position
      const time = currentTime.value;
      const clipsAtTime = getClipsAtTime(time);
      if (clipsAtTime.length === 0) return;

      const ctx = audioStore.getAudioContext();
      const { track, buffer, clipStart } = clipsAtTime[0];
      const offsetInClip = time - clipStart;
      if (offsetInClip < 0 || offsetInClip >= buffer.duration) return;

      scrubSource = ctx.createBufferSource();
      scrubSource.buffer = buffer;

      scrubGainNode = ctx.createGain();
      scrubGainNode.gain.value = track.volume * volume.value;

      scrubSource.connect(scrubGainNode);
      if (masterGain) scrubGainNode.connect(masterGain);

      scrubSource.start(0, offsetInClip, SNIPPET_DURATION);
    }, SCRUB_INTERVAL);
  }

  function stopReverseScrub(): void {
    if (reverseScrubInterval !== null) {
      clearInterval(reverseScrubInterval);
      reverseScrubInterval = null;
    }
    if (scrubSource) {
      try { scrubSource.stop(); scrubSource.disconnect(); } catch {}
      scrubSource = null;
    }
    if (scrubGainNode) {
      try { scrubGainNode.disconnect(); } catch {}
      scrubGainNode = null;
    }
  }

  function stopTimeUpdate(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
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
    startReversePlayback();
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

    // Re-anchor timing BEFORE changing speed to prevent playhead jump.
    // The RAF loop computes: startOffset + elapsed * speed
    // If we change speed without re-anchoring, elapsed was accumulated at the old speed.
    if (isPlaying.value) {
      const ctx = audioStore.getAudioContext();
      startOffset = currentTime.value;
      startTime = ctx.currentTime;
    }

    playbackSpeed.value = targetSpeed;
    playDirection.value = reverse ? -1 : 1;

    if (reverse) {
      if (isPlaying.value) {
        pause();
      }
      startReversePlayback();
    } else {
      if (!isPlaying.value) {
        await play();
      } else {
        // Update playback rate on existing sources
        for (const node of activeNodes) {
          node.sourceNode.playbackRate.value = Math.abs(targetSpeed);
        }
      }
    }
  }

  function jklStop(): void {
    pause();
    playbackSpeed.value = 1;
    playDirection.value = 1;
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

  // Watch for track changes during playback
  let lastTracksKey = '';
  watch(
    () => tracksStore.tracks.map(t => `${t.id}:${t.muted}:${t.solo}`).join(','),
    async (newKey) => {
      if (newKey === lastTracksKey) return;
      lastTracksKey = newKey;
      if (isPlaying.value) {
        const time = currentTime.value;
        pause();
        currentTime.value = time;
        await play();
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
  };
});
