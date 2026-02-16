import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface TrackLevel {
  peak_l: number;
  peak_r: number;
  rms_l: number;
  rms_r: number;
}

interface MeterLevels {
  tracks: Array<{ track_id: string } & TrackLevel>;
  master_peak_l: number;
  master_peak_r: number;
  master_rms_l: number;
  master_rms_r: number;
}

interface SmoothedLevel {
  peak_l: number;
  peak_r: number;
  rms_l: number;
  rms_r: number;
}

interface PeakHold {
  l: number;
  r: number;
  time_l: number;
  time_r: number;
}

// Ballistics constants
const DECAY_COEFF = 0.92;       // ~200ms release at 60fps
const PEAK_HOLD_MS = 2000;       // 2s peak hold

export const useMeterStore = defineStore('meter', () => {
  // Smoothed display values per track
  const trackLevels = reactive(new Map<string, SmoothedLevel>());
  // Master bus levels
  const masterLevel = reactive<SmoothedLevel>({
    peak_l: 0, peak_r: 0, rms_l: 0, rms_r: 0,
  });
  // Peak hold per track
  const peakHold = reactive(new Map<string, PeakHold>());
  // Master peak hold
  const masterPeakHold = reactive<PeakHold>({
    l: 0, r: 0, time_l: 0, time_r: 0,
  });
  // Clip indicators (sticky)
  const clipIndicators = reactive(new Map<string, boolean>());
  const masterClipped = ref(false);

  let rafId: number | null = null;
  let polling = false;

  function startPolling(): void {
    if (polling) return;
    polling = true;
    poll();
  }

  function stopPolling(): void {
    polling = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // Decay all levels to zero
    decayToZero();
  }

  async function poll(): Promise<void> {
    if (!polling) return;

    try {
      const levels = await invoke<MeterLevels>('playback_get_meter_levels');
      const now = performance.now();

      // Process per-track levels
      for (const track of levels.tracks) {
        const id = track.track_id;
        let current = trackLevels.get(id);
        if (!current) {
          current = { peak_l: 0, peak_r: 0, rms_l: 0, rms_r: 0 };
          trackLevels.set(id, current);
        }

        // Instant attack, exponential decay
        current.peak_l = track.peak_l > current.peak_l ? track.peak_l : current.peak_l * DECAY_COEFF;
        current.peak_r = track.peak_r > current.peak_r ? track.peak_r : current.peak_r * DECAY_COEFF;
        current.rms_l = track.rms_l > current.rms_l ? track.rms_l : current.rms_l * DECAY_COEFF;
        current.rms_r = track.rms_r > current.rms_r ? track.rms_r : current.rms_r * DECAY_COEFF;

        // Peak hold
        let hold = peakHold.get(id);
        if (!hold) {
          hold = { l: 0, r: 0, time_l: 0, time_r: 0 };
          peakHold.set(id, hold);
        }
        if (track.peak_l >= hold.l) { hold.l = track.peak_l; hold.time_l = now; }
        else if (now - hold.time_l > PEAK_HOLD_MS) { hold.l *= DECAY_COEFF; }
        if (track.peak_r >= hold.r) { hold.r = track.peak_r; hold.time_r = now; }
        else if (now - hold.time_r > PEAK_HOLD_MS) { hold.r *= DECAY_COEFF; }

        // Clip detection (sticky)
        if (track.peak_l >= 1.0 || track.peak_r >= 1.0) {
          clipIndicators.set(id, true);
        }
      }

      // Master levels
      masterLevel.peak_l = levels.master_peak_l > masterLevel.peak_l ? levels.master_peak_l : masterLevel.peak_l * DECAY_COEFF;
      masterLevel.peak_r = levels.master_peak_r > masterLevel.peak_r ? levels.master_peak_r : masterLevel.peak_r * DECAY_COEFF;
      masterLevel.rms_l = levels.master_rms_l > masterLevel.rms_l ? levels.master_rms_l : masterLevel.rms_l * DECAY_COEFF;
      masterLevel.rms_r = levels.master_rms_r > masterLevel.rms_r ? levels.master_rms_r : masterLevel.rms_r * DECAY_COEFF;

      // Master peak hold
      if (levels.master_peak_l >= masterPeakHold.l) { masterPeakHold.l = levels.master_peak_l; masterPeakHold.time_l = now; }
      else if (now - masterPeakHold.time_l > PEAK_HOLD_MS) { masterPeakHold.l *= DECAY_COEFF; }
      if (levels.master_peak_r >= masterPeakHold.r) { masterPeakHold.r = levels.master_peak_r; masterPeakHold.time_r = now; }
      else if (now - masterPeakHold.time_r > PEAK_HOLD_MS) { masterPeakHold.r *= DECAY_COEFF; }

      // Master clip
      if (levels.master_peak_l >= 1.0 || levels.master_peak_r >= 1.0) {
        masterClipped.value = true;
      }
    } catch {
      // Ignore polling errors during shutdown
    }

    if (polling) {
      rafId = requestAnimationFrame(() => { poll(); });
    }
  }

  function decayToZero(): void {
    for (const level of trackLevels.values()) {
      level.peak_l = 0; level.peak_r = 0;
      level.rms_l = 0; level.rms_r = 0;
    }
    masterLevel.peak_l = 0; masterLevel.peak_r = 0;
    masterLevel.rms_l = 0; masterLevel.rms_r = 0;
    for (const hold of peakHold.values()) {
      hold.l = 0; hold.r = 0;
    }
    masterPeakHold.l = 0; masterPeakHold.r = 0;
  }

  function clearClipIndicators(): void {
    clipIndicators.clear();
    masterClipped.value = false;
  }

  function clearTrackClip(trackId: string): void {
    clipIndicators.delete(trackId);
  }

  function clearMasterClip(): void {
    masterClipped.value = false;
  }

  return {
    trackLevels,
    masterLevel,
    peakHold,
    masterPeakHold,
    clipIndicators,
    masterClipped,
    startPolling,
    stopPolling,
    clearClipIndicators,
    clearTrackClip,
    clearMasterClip,
  };
});
