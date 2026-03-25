<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRecordingStore } from '@/stores/recording';
import RecordingTimerBar from './RecordingTimerBar.vue';
import RecordingTrackLane from './RecordingTrackLane.vue';

const recordingStore = useRecordingStore();

// Container sizing
const containerRef = ref<HTMLDivElement | null>(null);
const availableHeight = ref(400);
let resizeObserver: ResizeObserver | null = null;

const TIMER_BAR_HEIGHT = 40;
const GAP = 8;
const MIN_TRACK_HEIGHT = 80;

const trackHeight = computed(() => {
  const count = recordingStore.sessions.length;
  if (count === 0) return MIN_TRACK_HEIGHT;
  const usable = availableHeight.value - TIMER_BAR_HEIGHT - GAP;
  const perTrack = Math.floor((usable - (count - 1) * GAP) / count);
  return Math.max(MIN_TRACK_HEIGHT, perTrack);
});

const needsScroll = computed(() => {
  const count = recordingStore.sessions.length;
  const needed = count * (trackHeight.value + GAP) - GAP + TIMER_BAR_HEIGHT + GAP;
  return needed > availableHeight.value;
});

// Template refs for track lanes
const laneRefs = ref<InstanceType<typeof RecordingTrackLane>[]>([]);

// ── Centralized render scheduler (ONE rAF loop for ALL lanes) ──
let rafId: number | null = null;

function renderFrame() {
  let anyDirty = false;
  for (const lane of laneRefs.value) {
    if (lane && lane.isDirty()) {
      lane.draw();
      anyDirty = true;
    }
  }
  // Backpressure: keep running while recording, pause when idle
  if (anyDirty || recordingStore.isRecording) {
    rafId = requestAnimationFrame(renderFrame);
  } else {
    rafId = null;
  }
}

function startRenderLoop() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(renderFrame);
}

function stopRenderLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// Start/stop render loop based on recording state
watch(() => recordingStore.monitorViewActive, (active) => {
  if (active) startRenderLoop();
  else stopRenderLoop();
}, { immediate: true });

function updateSize() {
  if (containerRef.value) {
    availableHeight.value = containerRef.value.clientHeight;
  }
}

onMounted(() => {
  updateSize();
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateSize();
      // Restart render loop on resize (might have paused)
      if (recordingStore.monitorViewActive && rafId === null) startRenderLoop();
    });
    resizeObserver.observe(containerRef.value);
  }
  if (recordingStore.monitorViewActive) startRenderLoop();
});

onUnmounted(() => {
  stopRenderLoop();
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="containerRef" class="h-full flex flex-col gap-2">
    <!-- Timer bar -->
    <RecordingTimerBar />

    <!-- Track lanes -->
    <div
      class="flex-1 min-h-0 flex flex-col gap-2"
      :class="{ 'overflow-y-auto': needsScroll }"
    >
      <RecordingTrackLane
        v-for="session in recordingStore.sessions"
        :key="session.sessionId"
        ref="laneRefs"
        :session="session"
        :height="trackHeight"
      />

      <!-- Empty state when no sessions -->
      <div
        v-if="recordingStore.sessions.length === 0 && !recordingStore.isFinalizing"
        class="flex-1 flex items-center justify-center text-gray-500 text-sm"
      >
        No active recording sessions
      </div>
    </div>
  </div>
</template>
