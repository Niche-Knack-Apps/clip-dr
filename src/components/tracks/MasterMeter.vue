<script setup lang="ts">
import { computed } from 'vue';
import { useMeterStore } from '@/stores/meter';

const meterStore = useMeterStore();

const meterHeight = 40; // Compact height for toolbar area

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

const levels = computed(() => ({
  peakL: levelToHeight(meterStore.masterLevel.peak_l),
  peakR: levelToHeight(meterStore.masterLevel.peak_r),
  rmsL: levelToHeight(meterStore.masterLevel.rms_l),
  rmsR: levelToHeight(meterStore.masterLevel.rms_r),
}));

const holdLines = computed(() => ({
  l: levelToHeight(meterStore.masterPeakHold.l),
  r: levelToHeight(meterStore.masterPeakHold.r),
}));

const peakReadout = computed(() => {
  const maxPeak = Math.max(meterStore.masterPeakHold.l, meterStore.masterPeakHold.r);
  return levelToDb(maxPeak);
});

function handleClipClick() {
  meterStore.clearMasterClip();
}
</script>

<template>
  <div class="flex items-center gap-1" title="Master output level">
    <!-- Stereo meter bars -->
    <div class="flex gap-px items-end relative" :style="{ height: `${meterHeight}px` }">
      <!-- Clip indicator -->
      <div
        class="absolute -top-1.5 left-0 right-0 flex justify-center cursor-pointer"
        @click.stop="handleClipClick"
      >
        <div
          class="w-[6px] h-[3px] rounded-sm transition-colors"
          :class="meterStore.masterClipped ? 'bg-red-500' : 'bg-red-900/30'"
        />
      </div>

      <!-- Left channel -->
      <div class="relative w-[6px] bg-gray-800 rounded-sm overflow-hidden" :style="{ height: `${meterHeight}px` }">
        <div
          class="absolute inset-0"
          style="background: linear-gradient(to top, #22c55e 0%, #22c55e 57%, #eab308 57%, #eab308 90%, #ef4444 90%, #ef4444 100%)"
        />
        <div
          class="absolute inset-0 bg-gray-800 origin-top"
          :style="{ transform: `scaleY(${1 - levels.peakL / meterHeight})` }"
        />
        <div
          class="absolute bottom-0 left-0 right-0 bg-white/20"
          :style="{ height: `${levels.rmsL}px` }"
        />
        <div
          v-if="holdLines.l > 1"
          class="absolute left-0 right-0 h-px bg-white/70"
          :style="{ bottom: `${holdLines.l}px` }"
        />
      </div>

      <!-- Right channel -->
      <div class="relative w-[6px] bg-gray-800 rounded-sm overflow-hidden" :style="{ height: `${meterHeight}px` }">
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
          class="absolute left-0 right-0 h-px bg-white/70"
          :style="{ bottom: `${holdLines.r}px` }"
        />
      </div>
    </div>

    <!-- Numeric peak readout -->
    <span
      class="text-[9px] font-mono w-8 text-right cursor-pointer"
      :class="meterStore.masterClipped ? 'text-red-400' : 'text-gray-500'"
      :title="`Peak: ${peakReadout} dB`"
      @click.stop="handleClipClick"
    >{{ peakReadout }}</span>
  </div>
</template>
