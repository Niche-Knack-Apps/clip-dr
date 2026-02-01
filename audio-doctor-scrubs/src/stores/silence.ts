import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { SilenceRegion } from '@/shared/types';
import { useVadStore } from './vad';
import { useAudioStore } from './audio';

export const useSilenceStore = defineStore('silence', () => {
  const vadStore = useVadStore();
  const audioStore = useAudioStore();

  const silenceRegions = ref<SilenceRegion[]>([]);
  const compressionEnabled = ref(false);

  // Minimum region duration in seconds
  const MIN_REGION_DURATION = 0.05;

  // Get only enabled (active) silence regions
  const activeSilenceRegions = computed(() =>
    silenceRegions.value.filter(r => r.enabled)
  );

  // Calculate compressed duration (total duration minus active silence)
  const compressedDuration = computed(() => {
    const total = audioStore.duration;
    const silenceTotal = activeSilenceRegions.value.reduce(
      (sum, r) => sum + (r.end - r.start),
      0
    );
    return Math.max(0, total - silenceTotal);
  });

  // Calculate how much silence is being removed
  const savedDuration = computed(() => {
    return activeSilenceRegions.value.reduce(
      (sum, r) => sum + (r.end - r.start),
      0
    );
  });

  // Generate unique ID
  function generateId(): string {
    return `silence-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Initialize silence regions from VAD results
  function initFromVad(): void {
    if (!vadStore.result) return;

    silenceRegions.value = vadStore.silenceSegments.map(seg => ({
      id: generateId(),
      start: seg.start,
      end: seg.end,
      enabled: true,
    }));

    console.log(`Created ${silenceRegions.value.length} silence regions from VAD`);
  }

  // Add a new silence region manually
  function addRegion(start: number, end: number): SilenceRegion | null {
    // Ensure valid range
    const duration = audioStore.duration;
    const regionStart = Math.max(0, Math.min(start, end));
    const regionEnd = Math.min(duration, Math.max(start, end));

    // Check minimum duration
    if (regionEnd - regionStart < MIN_REGION_DURATION) {
      console.warn('Region too small');
      return null;
    }

    const newRegion: SilenceRegion = {
      id: generateId(),
      start: regionStart,
      end: regionEnd,
      enabled: true,
    };

    // Insert in sorted order by start time
    const insertIndex = silenceRegions.value.findIndex(r => r.start > regionStart);
    if (insertIndex === -1) {
      silenceRegions.value.push(newRegion);
    } else {
      silenceRegions.value.splice(insertIndex, 0, newRegion);
    }

    // Merge overlapping regions
    mergeOverlapping();

    return newRegion;
  }

  // Update a region's boundaries
  function updateRegion(
    id: string,
    updates: { start?: number; end?: number }
  ): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (!region) return;

    const duration = audioStore.duration;

    if (updates.start !== undefined) {
      region.start = Math.max(0, Math.min(updates.start, region.end - MIN_REGION_DURATION));
    }

    if (updates.end !== undefined) {
      region.end = Math.min(duration, Math.max(updates.end, region.start + MIN_REGION_DURATION));
    }

    // Ensure minimum duration
    if (region.end - region.start < MIN_REGION_DURATION) {
      region.end = region.start + MIN_REGION_DURATION;
    }

    // Re-sort and merge if needed
    silenceRegions.value.sort((a, b) => a.start - b.start);
    mergeOverlapping();
  }

  // Move a region by delta (preserving duration)
  function moveRegion(id: string, delta: number): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (!region) return;

    const duration = audioStore.duration;
    const regionDuration = region.end - region.start;

    let newStart = region.start + delta;
    let newEnd = region.end + delta;

    // Clamp to audio bounds
    if (newStart < 0) {
      newStart = 0;
      newEnd = regionDuration;
    }
    if (newEnd > duration) {
      newEnd = duration;
      newStart = duration - regionDuration;
    }

    region.start = newStart;
    region.end = newEnd;

    // Re-sort and merge
    silenceRegions.value.sort((a, b) => a.start - b.start);
    mergeOverlapping();
  }

  // Delete a region (restore that audio)
  function deleteRegion(id: string): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (region) {
      region.enabled = false;
    }
  }

  // Permanently remove a region from the list
  function removeRegion(id: string): void {
    const index = silenceRegions.value.findIndex(r => r.id === id);
    if (index !== -1) {
      silenceRegions.value.splice(index, 1);
    }
  }

  // Restore a previously deleted region
  function restoreRegion(id: string): void {
    const region = silenceRegions.value.find(r => r.id === id);
    if (region) {
      region.enabled = true;
    }
  }

  // Toggle compression (skip silence on playback)
  function toggleCompression(enabled?: boolean): void {
    compressionEnabled.value = enabled ?? !compressionEnabled.value;
  }

  // Check if a time falls within an active silence region
  function isInSilence(time: number): SilenceRegion | null {
    if (!compressionEnabled.value) return null;

    return activeSilenceRegions.value.find(
      r => time >= r.start && time < r.end
    ) || null;
  }

  // Get the end time of silence region at given time (for skipping)
  function getNextSpeechTime(time: number): number {
    const region = isInSilence(time);
    return region ? region.end : time;
  }

  // Merge overlapping regions
  function mergeOverlapping(): void {
    if (silenceRegions.value.length < 2) return;

    // Sort by start time
    silenceRegions.value.sort((a, b) => a.start - b.start);

    const merged: SilenceRegion[] = [];
    let current = { ...silenceRegions.value[0] };

    for (let i = 1; i < silenceRegions.value.length; i++) {
      const next = silenceRegions.value[i];

      // Check if regions overlap or touch
      if (next.start <= current.end) {
        // Merge: extend current to cover next
        current.end = Math.max(current.end, next.end);
        // Keep enabled if either is enabled
        current.enabled = current.enabled || next.enabled;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    silenceRegions.value = merged;
  }

  // Clear all silence regions
  function clear(): void {
    silenceRegions.value = [];
    compressionEnabled.value = false;
  }

  // Get regions visible in a time range
  function getRegionsInRange(start: number, end: number): SilenceRegion[] {
    return silenceRegions.value.filter(
      r => r.end > start && r.start < end
    );
  }

  // Check if silence regions have been created
  const hasRegions = computed(() => silenceRegions.value.length > 0);

  return {
    silenceRegions,
    compressionEnabled,
    activeSilenceRegions,
    compressedDuration,
    savedDuration,
    hasRegions,
    initFromVad,
    addRegion,
    updateRegion,
    moveRegion,
    deleteRegion,
    removeRegion,
    restoreRegion,
    toggleCompression,
    isInSilence,
    getNextSpeechTime,
    getRegionsInRange,
    clear,
  };
});
