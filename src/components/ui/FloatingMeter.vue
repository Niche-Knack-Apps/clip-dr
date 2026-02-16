<script setup lang="ts">
import { computed, watch, onMounted, onUnmounted } from 'vue';
import { useUIStore } from '@/stores/ui';
import { useTracksStore } from '@/stores/tracks';
import { useMeterStore } from '@/stores/meter';

const uiStore = useUIStore();
const tracksStore = useTracksStore();
const meterStore = useMeterStore();

const meterHeight = 200;

// --- Meter math ---
function levelToHeight(linear: number): number {
  if (linear <= 0.001) return 0;
  const db = Math.max(-60, 20 * Math.log10(linear));
  return ((db + 60) / 60) * meterHeight;
}

function levelToDb(linear: number): string {
  if (linear <= 0.001) return '-inf';
  const db = 20 * Math.log10(linear);
  if (db > 0) return `+${db.toFixed(1)}`;
  return db.toFixed(1);
}

// --- Computed data ---
const fm = computed(() => uiStore.floatingMeter);

const title = computed(() => {
  if (!fm.value) return '';
  if (fm.value.type === 'master') return 'Master';
  const track = tracksStore.tracks.find(t => t.id === fm.value!.trackId);
  return track?.name ?? 'Track';
});

const levels = computed(() => {
  if (!fm.value) return { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
  if (fm.value.type === 'master') {
    return {
      peakL: levelToHeight(meterStore.masterLevel.peak_l),
      peakR: levelToHeight(meterStore.masterLevel.peak_r),
      rmsL: levelToHeight(meterStore.masterLevel.rms_l),
      rmsR: levelToHeight(meterStore.masterLevel.rms_r),
    };
  }
  const l = meterStore.trackLevels.get(fm.value.trackId!);
  if (!l) return { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
  return {
    peakL: levelToHeight(l.peak_l),
    peakR: levelToHeight(l.peak_r),
    rmsL: levelToHeight(l.rms_l),
    rmsR: levelToHeight(l.rms_r),
  };
});

const holdLines = computed(() => {
  if (!fm.value) return { l: 0, r: 0 };
  if (fm.value.type === 'master') {
    return {
      l: levelToHeight(meterStore.masterPeakHold.l),
      r: levelToHeight(meterStore.masterPeakHold.r),
    };
  }
  const hold = meterStore.peakHold.get(fm.value.trackId!);
  if (!hold) return { l: 0, r: 0 };
  return { l: levelToHeight(hold.l), r: levelToHeight(hold.r) };
});

const dbReadout = computed(() => {
  if (!fm.value) return { l: '-inf', r: '-inf' };
  if (fm.value.type === 'master') {
    return {
      l: levelToDb(meterStore.masterPeakHold.l),
      r: levelToDb(meterStore.masterPeakHold.r),
    };
  }
  const hold = meterStore.peakHold.get(fm.value.trackId!);
  if (!hold) return { l: '-inf', r: '-inf' };
  return { l: levelToDb(hold.l), r: levelToDb(hold.r) };
});

const isClipped = computed(() => {
  if (!fm.value) return false;
  if (fm.value.type === 'master') return meterStore.masterClipped;
  return meterStore.clipIndicators.get(fm.value.trackId!) ?? false;
});

function handleClipClick() {
  if (!fm.value) return;
  if (fm.value.type === 'master') {
    meterStore.clearMasterClip();
  } else {
    meterStore.clearTrackClip(fm.value.trackId!);
  }
}

// --- Drag ---
let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let rafPending = false;

function onTitleMouseDown(e: MouseEvent) {
  if (!fm.value) return;
  dragging = true;
  dragOffsetX = e.clientX - fm.value.x;
  dragOffsetY = e.clientY - fm.value.y;
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!dragging || rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    const x = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - dragOffsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 100, e.clientY - dragOffsetY));
    uiStore.setFloatingMeterPosition(x, y);
    rafPending = false;
  });
}

function onMouseUp() {
  dragging = false;
  rafPending = false;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
}

// --- ESC to close ---
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && fm.value) {
    uiStore.closeFloatingMeter();
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown));
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});

// --- Auto-close when track is deleted ---
watch(() => tracksStore.tracks, (tracks) => {
  if (fm.value?.type === 'track' && fm.value.trackId) {
    if (!tracks.find(t => t.id === fm.value!.trackId)) {
      uiStore.closeFloatingMeter();
    }
  }
});

// dB scale marks
const dbMarks = [0, -6, -12, -24, -48, -60];
function dbToBottom(db: number): number {
  return ((db + 60) / 60) * meterHeight;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="fm"
      class="fixed z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl select-none"
      :style="{ left: `${fm.x}px`, top: `${fm.y}px` }"
    >
      <!-- Title bar (draggable) -->
      <div
        class="flex items-center justify-between px-2 py-1 bg-gray-800 rounded-t-lg cursor-move border-b border-gray-700"
        @mousedown.prevent="onTitleMouseDown"
      >
        <span class="text-xs text-gray-300 font-medium truncate mr-2">{{ title }}</span>
        <button
          class="text-gray-500 hover:text-gray-300 text-xs leading-none px-1"
          @click.stop="uiStore.closeFloatingMeter()"
        >&times;</button>
      </div>

      <!-- Meter body -->
      <div class="flex items-start gap-1 px-2 pt-2 pb-1">
        <!-- dB scale labels -->
        <div class="relative shrink-0" :style="{ width: '24px', height: `${meterHeight}px` }">
          <div
            v-for="db in dbMarks"
            :key="db"
            class="absolute right-0 text-[8px] text-gray-500 font-mono leading-none"
            :style="{ bottom: `${dbToBottom(db) - 4}px` }"
          >{{ db }}</div>
        </div>

        <!-- Left channel bar -->
        <div class="flex flex-col items-center gap-1">
          <div class="relative w-4 bg-gray-800 rounded-sm overflow-hidden" :style="{ height: `${meterHeight}px` }">
            <!-- Gradient -->
            <div
              class="absolute inset-0"
              style="background: linear-gradient(to top, #22c55e 0%, #22c55e 57%, #eab308 57%, #eab308 90%, #ef4444 90%, #ef4444 100%)"
            />
            <!-- Dark overlay -->
            <div
              class="absolute inset-0 bg-gray-800 origin-top"
              :style="{ transform: `scaleY(${1 - levels.peakL / meterHeight})` }"
            />
            <!-- RMS -->
            <div
              class="absolute bottom-0 left-0 right-0 bg-white/20"
              :style="{ height: `${levels.rmsL}px` }"
            />
            <!-- Peak hold line -->
            <div
              v-if="holdLines.l > 1"
              class="absolute left-0 right-0 h-px bg-white/90"
              :style="{ bottom: `${holdLines.l}px` }"
            />
          </div>
          <!-- dB readout -->
          <span class="text-[8px] font-mono text-gray-400 w-8 text-center">{{ dbReadout.l }}</span>
        </div>

        <!-- Right channel bar -->
        <div class="flex flex-col items-center gap-1">
          <div class="relative w-4 bg-gray-800 rounded-sm overflow-hidden" :style="{ height: `${meterHeight}px` }">
            <div
              class="absolute inset-0"
              style="background: linear-gradient(to top, #22c55e 0%, #22c55e 57%, #eab308 57%, #eab308 90%, #ef4444 90%, #ef4444 100%)"
            />
            <div
              class="absolute inset-0 bg-gray-800 origin-top"
              :style="{ transform: `scaleY(${1 - levels.peakR / meterHeight})` }"
            />
            <div
              class="absolute bottom-0 left-0 right-0 bg-white/20"
              :style="{ height: `${levels.rmsR}px` }"
            />
            <div
              v-if="holdLines.r > 1"
              class="absolute left-0 right-0 h-px bg-white/90"
              :style="{ bottom: `${holdLines.r}px` }"
            />
          </div>
          <span class="text-[8px] font-mono text-gray-400 w-8 text-center">{{ dbReadout.r }}</span>
        </div>
      </div>

      <!-- Clip indicator bar -->
      <div
        class="mx-2 mb-2 h-2 rounded-sm cursor-pointer transition-colors"
        :class="isClipped ? 'bg-red-500' : 'bg-red-900/30'"
        @click.stop="handleClipClick"
        title="Click to clear clip indicator"
      />
    </div>
  </Teleport>
</template>
