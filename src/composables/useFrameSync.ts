import { ref, onUnmounted } from 'vue';
import { SEEK_THROTTLE_MS } from '@/shared/constants';

export interface FrameSyncOptions {
  onFrame?: (time: number) => void;
  throttleMs?: number;
}

export function useFrameSync(options: FrameSyncOptions = {}) {
  const { onFrame, throttleMs = SEEK_THROTTLE_MS } = options;

  const currentTime = ref(0);
  const isScrubbing = ref(false);

  let rafId: number | null = null;
  let lastSeekTime = 0;
  let getTimeCallback: (() => number) | null = null;

  function startSync(getTime: () => number): void {
    getTimeCallback = getTime;
    scheduleFrame();
  }

  function stopSync(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    getTimeCallback = null;
  }

  function scheduleFrame(): void {
    rafId = requestAnimationFrame(updateFrame);
  }

  function updateFrame(): void {
    if (!getTimeCallback) return;

    if (!isScrubbing.value) {
      const newTime = getTimeCallback();
      if (newTime !== currentTime.value) {
        currentTime.value = newTime;
        onFrame?.(newTime);
      }
    }

    scheduleFrame();
  }

  function scrubStart(): void {
    isScrubbing.value = true;
  }

  function scrub(time: number): void {
    const now = performance.now();
    if (now - lastSeekTime >= throttleMs) {
      currentTime.value = time;
      lastSeekTime = now;
      onFrame?.(time);
    }
  }

  function scrubEnd(): void {
    isScrubbing.value = false;
  }

  function setTime(time: number): void {
    currentTime.value = time;
    onFrame?.(time);
  }

  onUnmounted(() => {
    stopSync();
  });

  return {
    currentTime,
    isScrubbing,
    startSync,
    stopSync,
    scrubStart,
    scrub,
    scrubEnd,
    setTime,
  };
}
