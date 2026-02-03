import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  TRACK_PANEL_MIN_WIDTH,
  TRACK_PANEL_MAX_WIDTH,
  TRACK_PANEL_DEFAULT_WIDTH,
  WAVEFORM_HEIGHT,
  ZOOMED_HEIGHT,
} from '@/shared/constants';

// Section height constraints
const SECTION_MIN_HEIGHT = 80;
const SECTION_MAX_HEIGHT = 400;

export const useUIStore = defineStore('ui', () => {
  // Track panel width (resizable)
  const trackPanelWidth = ref(TRACK_PANEL_DEFAULT_WIDTH);

  // Section heights (resizable)
  const waveformHeight = ref(WAVEFORM_HEIGHT);
  const zoomedHeight = ref(ZOOMED_HEIGHT);

  // Follow playhead in zoomed view
  const followPlayhead = ref(false);

  // Snap clips to edges (prevents overlap)
  const snapEnabled = ref(true);

  // Computed helpers
  const isTrackPanelCollapsed = computed(() => trackPanelWidth.value <= TRACK_PANEL_MIN_WIDTH);
  const isTrackPanelExpanded = computed(() => trackPanelWidth.value >= TRACK_PANEL_MAX_WIDTH * 0.8);

  function setTrackPanelWidth(width: number): void {
    trackPanelWidth.value = Math.max(
      TRACK_PANEL_MIN_WIDTH,
      Math.min(TRACK_PANEL_MAX_WIDTH, width)
    );
  }

  function toggleFollowPlayhead(): void {
    followPlayhead.value = !followPlayhead.value;
  }

  function setFollowPlayhead(enabled: boolean): void {
    followPlayhead.value = enabled;
  }

  function setWaveformHeight(height: number): void {
    waveformHeight.value = Math.max(
      SECTION_MIN_HEIGHT,
      Math.min(SECTION_MAX_HEIGHT, height)
    );
  }

  function setZoomedHeight(height: number): void {
    zoomedHeight.value = Math.max(
      SECTION_MIN_HEIGHT,
      Math.min(SECTION_MAX_HEIGHT, height)
    );
  }

  function toggleSnap(): void {
    snapEnabled.value = !snapEnabled.value;
  }

  function setSnapEnabled(enabled: boolean): void {
    snapEnabled.value = enabled;
  }

  return {
    trackPanelWidth,
    waveformHeight,
    zoomedHeight,
    followPlayhead,
    snapEnabled,
    isTrackPanelCollapsed,
    isTrackPanelExpanded,
    setTrackPanelWidth,
    setWaveformHeight,
    setZoomedHeight,
    toggleFollowPlayhead,
    setFollowPlayhead,
    toggleSnap,
    setSnapEnabled,
  };
});
