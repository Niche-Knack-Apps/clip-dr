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

export interface FloatingMeterState {
  type: 'track' | 'master';
  trackId: string | null;
  x: number;
  y: number;
}

export const useUIStore = defineStore('ui', () => {
  // Track panel width (resizable)
  const trackPanelWidth = ref(TRACK_PANEL_DEFAULT_WIDTH);

  // Floating meter panel
  const floatingMeter = ref<FloatingMeterState | null>(null);

  // Section heights (resizable)
  const waveformHeight = ref(WAVEFORM_HEIGHT);
  const zoomedHeight = ref(ZOOMED_HEIGHT);

  // Follow playhead in zoomed view (on by default)
  const followPlayhead = ref(true);

  // Snap clips to edges (prevents overlap)
  const snapEnabled = ref(true);

  // Track timeline zoom (pixels per second)
  const trackZoom = ref(2);   // Default fully zoomed out
  const TRACK_ZOOM_MIN = 0.1;  // Minimum zoom (zoomed way out — fits even 2hr files)
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
    console.log(`[Zoom] setTrackZoom: input=${zoom.toFixed(6)}, clamped=${Math.max(TRACK_ZOOM_MIN, Math.min(TRACK_ZOOM_MAX, zoom)).toFixed(6)}`);
    trackZoom.value = Math.max(TRACK_ZOOM_MIN, Math.min(TRACK_ZOOM_MAX, zoom));
    // Reset the timeline duration floor when user manually zooms
    useTracksStore().resetMinTimelineDuration();
  }

  function zoomTrackIn(): void {
    setTrackZoom(trackZoom.value * 1.2);
  }

  function zoomTrackOut(): void {
    const target = trackZoom.value / 1.2;
    const clamped = Math.max(TRACK_ZOOM_MIN, Math.min(TRACK_ZOOM_MAX, target));
    // Don't zoom IN when user wants to zoom OUT (happens when auto-fit is below TRACK_ZOOM_MIN)
    if (clamped >= trackZoom.value) return;
    trackZoom.value = clamped;
    useTracksStore().resetMinTimelineDuration();
  }

  // Zoom to fit all content — matches timelineWidth's 1.1x padding exactly
  function zoomTrackToFit(timelineDuration: number, containerWidth: number): void {
    if (timelineDuration <= 0 || containerWidth <= 0) return;
    // timelineWidth = duration * 1.1 * zoom + panelWidth
    // To fill exactly: duration * 1.1 * zoom = containerWidth (already excludes panelWidth)
    const paddedDuration = timelineDuration * 1.1;
    const targetZoom = containerWidth / paddedDuration;
    console.log(`[Zoom] zoomTrackToFit: timelineDuration=${timelineDuration.toFixed(2)}, containerWidth=${containerWidth}, targetZoom=${targetZoom.toFixed(6)}, result=${Math.min(TRACK_ZOOM_MAX, targetZoom).toFixed(6)}`);
    // Bypass TRACK_ZOOM_MIN — auto-fit must always fit, regardless of file length
    trackZoom.value = Math.min(TRACK_ZOOM_MAX, targetZoom);
    useTracksStore().resetMinTimelineDuration();
  }

  function openFloatingMeter(type: 'track' | 'master', trackId?: string): void {
    const x = Math.round((window.innerWidth - 120) / 2);
    floatingMeter.value = { type, trackId: trackId ?? null, x, y: 100 };
  }

  function closeFloatingMeter(): void {
    floatingMeter.value = null;
  }

  function setFloatingMeterPosition(x: number, y: number): void {
    if (floatingMeter.value) {
      floatingMeter.value = { ...floatingMeter.value, x, y };
    }
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
    floatingMeter,
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
    openFloatingMeter,
    closeFloatingMeter,
    setFloatingMeterPosition,
  };
});
