import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  TRACK_PANEL_MIN_WIDTH,
  TRACK_PANEL_MAX_WIDTH,
  TRACK_PANEL_DEFAULT_WIDTH,
} from '@/shared/constants';

export const useUIStore = defineStore('ui', () => {
  // Track panel width (resizable)
  const trackPanelWidth = ref(TRACK_PANEL_DEFAULT_WIDTH);

  // Follow playhead in zoomed view
  const followPlayhead = ref(false);

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

  return {
    trackPanelWidth,
    followPlayhead,
    isTrackPanelCollapsed,
    isTrackPanelExpanded,
    setTrackPanelWidth,
    toggleFollowPlayhead,
    setFollowPlayhead,
  };
});
