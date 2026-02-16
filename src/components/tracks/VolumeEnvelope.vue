<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue';
import type { Track } from '@/shared/types';
import { useTracksStore } from '@/stores/tracks';
import { useHistoryStore } from '@/stores/history';
import { MAX_VOLUME_DB, MIN_VOLUME_DB, TRACK_HEIGHT } from '@/shared/constants';
import { linearToDb, dbToLinear } from '@/shared/utils';

interface Props {
  track: Track;
  containerWidth: number;
  duration: number; // paddedDuration from TrackLane (timelineDuration)
}

const props = defineProps<Props>();
const tracksStore = useTracksStore();
const historyStore = useHistoryStore();

const svgHeight = TRACK_HEIGHT;
const dbRange = MAX_VOLUME_DB - MIN_VOLUME_DB; // 84dB total range

// Drag state
const draggingPointId = ref<string | null>(null);
const dragTooltipPosition = ref<{ x: number; y: number } | null>(null);
let dragRafId: number | null = null;
let pendingDragEvent: MouseEvent | null = null;

// dB tooltip while dragging
const dragTooltipText = computed(() => {
  if (!dragTooltipPosition.value) return '';
  const value = yToValue(dragTooltipPosition.value.y);
  if (value <= 0) return '-inf dB';
  const db = linearToDb(value);
  if (db > 0) return `+${db.toFixed(1)} dB`;
  return `${db.toFixed(1)} dB`;
});

// Convert a linear gain value to Y pixel coordinate
function valueToY(value: number): number {
  const db = value <= 0 ? MIN_VOLUME_DB : Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, linearToDb(value)));
  // 0dB at ~71% from bottom, +24dB at top, -60dB at bottom
  const fraction = (db - MIN_VOLUME_DB) / dbRange;
  return svgHeight * (1 - fraction);
}

// Convert Y pixel coordinate to linear gain value
function yToValue(y: number): number {
  const fraction = 1 - y / svgHeight;
  const db = MIN_VOLUME_DB + fraction * dbRange;
  if (db <= MIN_VOLUME_DB) return 0;
  return dbToLinear(db);
}

// Convert time (track-relative) to X pixel coordinate
function timeToX(time: number): number {
  if (props.duration <= 0) return 0;
  return ((props.track.trackStart + time) / props.duration) * props.containerWidth;
}

// Convert X pixel coordinate to time (track-relative)
function xToTime(x: number): number {
  if (props.containerWidth <= 0) return 0;
  const timelineTime = (x / props.containerWidth) * props.duration;
  return Math.max(0, timelineTime - props.track.trackStart);
}

// The Y position for 0dB reference line
const unityY = computed(() => valueToY(1.0));

// Get points for the polyline — use envelope if exists, otherwise flat at track.volume
const envelopePoints = computed(() => {
  const env = props.track.volumeEnvelope;
  if (!env || env.length === 0) {
    // Flat line at track volume across the track's span
    return [
      { x: timeToX(0), y: valueToY(props.track.volume) },
      { x: timeToX(props.track.duration), y: valueToY(props.track.volume) },
    ];
  }

  const points: { x: number; y: number }[] = [];

  // Extend to track start if first point isn't at 0
  if (env[0].time > 0.001) {
    points.push({ x: timeToX(0), y: valueToY(env[0].value) });
  }

  for (const p of env) {
    points.push({ x: timeToX(p.time), y: valueToY(p.value) });
  }

  // Extend to track end if last point isn't at duration
  if (env[env.length - 1].time < props.track.duration - 0.001) {
    points.push({ x: timeToX(props.track.duration), y: valueToY(env[env.length - 1].value) });
  }

  return points;
});

// SVG polyline points string
const polylinePoints = computed(() =>
  envelopePoints.value.map(p => `${p.x},${p.y}`).join(' ')
);

// SVG polygon points string (for semi-transparent fill below the curve)
const polygonPoints = computed(() => {
  const pts = envelopePoints.value;
  if (pts.length < 2) return '';
  const first = pts[0];
  const last = pts[pts.length - 1];
  const top = pts.map(p => `${p.x},${p.y}`).join(' ');
  return `${first.x},${svgHeight} ${top} ${last.x},${svgHeight}`;
});

// Keyframe circles — only render when envelope has points
const keyframeCircles = computed(() => {
  const env = props.track.volumeEnvelope;
  if (!env || env.length === 0) return [];
  return env.map(p => ({
    id: p.id,
    cx: timeToX(p.time),
    cy: valueToY(p.value),
  }));
});

// Click on the wide hit polyline — add a new point
function handleBackgroundClick(event: MouseEvent) {
  if (draggingPointId.value) return;
  const svgEl = document.querySelector(`[data-envelope-track="${props.track.id}"]`);
  if (!svgEl) return;
  const rect = svgEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const time = xToTime(x);
  const value = yToValue(y);
  tracksStore.addVolumePoint(props.track.id, time, value);
}

// Start dragging a keyframe circle
function handlePointMouseDown(pointId: string, event: MouseEvent) {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();
  draggingPointId.value = pointId;
  historyStore.pushState('Drag volume point');
  document.addEventListener('mousemove', handlePointMouseMove);
  document.addEventListener('mouseup', handlePointMouseUp);
}

function handlePointMouseMove(event: MouseEvent) {
  if (!draggingPointId.value) return;
  pendingDragEvent = event;
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(flushDrag);
  }
}

function flushDrag() {
  dragRafId = null;
  if (!pendingDragEvent || !draggingPointId.value) return;
  const svg = document.querySelector(`[data-envelope-track="${props.track.id}"]`);
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const x = pendingDragEvent.clientX - rect.left;
  const y = pendingDragEvent.clientY - rect.top;
  pendingDragEvent = null;

  const clampedY = Math.max(0, Math.min(svgHeight, y));
  const time = xToTime(x);
  const value = yToValue(clampedY);

  dragTooltipPosition.value = { x, y: clampedY };
  tracksStore.updateVolumePoint(props.track.id, draggingPointId.value, time, value);
}

function handlePointMouseUp() {
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  pendingDragEvent = null;
  draggingPointId.value = null;
  dragTooltipPosition.value = null;
  document.removeEventListener('mousemove', handlePointMouseMove);
  document.removeEventListener('mouseup', handlePointMouseUp);
}

// Right-click on a keyframe — remove it
function handlePointContextMenu(pointId: string, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  tracksStore.removeVolumePoint(props.track.id, pointId);
}

onUnmounted(() => {
  if (dragRafId !== null) cancelAnimationFrame(dragRafId);
  document.removeEventListener('mousemove', handlePointMouseMove);
  document.removeEventListener('mouseup', handlePointMouseUp);
});
</script>

<template>
  <svg
    :data-envelope-track="track.id"
    class="absolute inset-0 z-[5] overflow-visible"
    :width="containerWidth"
    :height="svgHeight"
    style="pointer-events: none"
  >
    <!-- Semi-transparent fill below the curve -->
    <polygon
      v-if="polygonPoints"
      :points="polygonPoints"
      :fill="track.color + '15'"
      style="pointer-events: none"
    />

    <!-- Dashed 0dB reference line -->
    <line
      :x1="timeToX(0)"
      :y1="unityY"
      :x2="timeToX(track.duration)"
      :y2="unityY"
      stroke="#ffffff20"
      stroke-width="0.5"
      stroke-dasharray="4 4"
      style="pointer-events: none"
    />

    <!-- Invisible wide hit polyline (~6px each side) for easier clicking -->
    <polyline
      :points="polylinePoints"
      fill="none"
      stroke="transparent"
      stroke-width="12"
      stroke-linejoin="round"
      style="pointer-events: stroke; cursor: crosshair"
      @click.stop="handleBackgroundClick"
    />

    <!-- Visible envelope line -->
    <polyline
      :points="polylinePoints"
      fill="none"
      :stroke="track.color + 'cc'"
      stroke-width="1.5"
      stroke-linejoin="round"
      style="pointer-events: none"
    />

    <!-- Visible keyframe circles -->
    <circle
      v-for="kf in keyframeCircles"
      :key="kf.id"
      :cx="kf.cx"
      :cy="kf.cy"
      r="5"
      :fill="track.color"
      stroke="white"
      :stroke-width="draggingPointId === kf.id ? 2 : 1"
      style="pointer-events: none"
    />

    <!-- Invisible larger grab targets for keyframes -->
    <circle
      v-for="kf in keyframeCircles"
      :key="'hit-' + kf.id"
      :cx="kf.cx"
      :cy="kf.cy"
      r="10"
      fill="transparent"
      class="cursor-grab"
      :class="{ 'cursor-grabbing': draggingPointId === kf.id }"
      style="pointer-events: all"
      @mousedown.stop="handlePointMouseDown(kf.id, $event)"
      @contextmenu.stop="handlePointContextMenu(kf.id, $event)"
    />

    <!-- dB tooltip while dragging -->
    <text
      v-if="draggingPointId && dragTooltipPosition"
      :x="dragTooltipPosition.x + 14"
      :y="dragTooltipPosition.y - 10"
      fill="white"
      font-size="10"
      font-family="monospace"
      style="pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.8)"
    >{{ dragTooltipText }}</text>
  </svg>
</template>
