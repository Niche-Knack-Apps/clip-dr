import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  TRACK_PANEL_MIN_WIDTH,
  TRACK_PANEL_MAX_WIDTH,
  TRACK_PANEL_DEFAULT_WIDTH,
  WAVEFORM_HEIGHT,
  ZOOMED_HEIGHT,
} from '@/shared/constants';
import { useTracksStore } from './tracks';

// Section height constraints
const SECTION_MIN_HEIGHT = 80;
const SECTION_MAX_HEIGHT = 400;

export const useUIStore = defineStore('ui', () => {
  // Track panel width (resizable)
  const trackPanelWidth = ref(TRACK_PANEL_DEFAULT_WIDTH);

  // Section heights (resizable)
  const waveformHeight = ref(WAVEFORM_HEIGHT);
  const zoomedHeight = ref(ZOOMED_HEIGHT);

  // Follow playhead in zoomed view (on by default)
  const followPlayhead = ref(true);

  // Snap clips to edges (prevents overlap)
  const snapEnabled = ref(true);

  // Track timeline zoom (pixels per second)
  const trackZoom = ref(2);   // Default fully zoomed out
  const TRACK_ZOOM_MIN = 2;    // Minimum zoom (zoomed way out)
  const TRACK_ZOOM_MAX = 2000; // Maximum zoom (zoomed way in)

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

  function setTrackZoom(zoom: number): void {
    trackZoom.value = Math.max(TRACK_ZOOM_MIN, Math.min(TRACK_ZOOM_MAX, zoom));
    // Reset the timeline duration floor when user manually zooms
    useTracksStore().resetMinTimelineDuration();
  }

  function zoomTrackIn(): void {
    setTrackZoom(trackZoom.value * 1.2);
  }

  function zoomTrackOut(): void {
    setTrackZoom(trackZoom.value / 1.2);
  }

  // Zoom to fit all content with padding
  function zoomTrackToFit(timelineDuration: number, containerWidth: number): void {
    if (timelineDuration <= 0 || containerWidth <= 0) return;
    // Add 10% padding on the right
    const targetZoom = (containerWidth * 0.9) / timelineDuration;
    setTrackZoom(targetZoom);
  }

  return {
    trackPanelWidth,
    waveformHeight,
    zoomedHeight,
    followPlayhead,
    snapEnabled,
    trackZoom,
    TRACK_ZOOM_MIN,
    TRACK_ZOOM_MAX,
    isTrackPanelCollapsed,
    isTrackPanelExpanded,
    setTrackPanelWidth,
    setWaveformHeight,
    setZoomedHeight,
    toggleFollowPlayhead,
    setFollowPlayhead,
    toggleSnap,
    setSnapEnabled,
    setTrackZoom,
    zoomTrackIn,
    zoomTrackOut,
    zoomTrackToFit,
  };
});
