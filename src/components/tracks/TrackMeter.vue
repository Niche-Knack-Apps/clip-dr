<script setup lang="ts">
import { computed } from 'vue';
import { useMeterStore } from '@/stores/meter';
interface Props {
  trackId: string;
}

const props = defineProps<Props>();
const meterStore = useMeterStore();

const meterHeight = 16;

// Convert linear level to pixel height using dB scale (-60dB to 0dB)
function levelToHeight(linear: number): number {
  if (linear <= 0.001) return 0; // ~-60dB floor
  const db = Math.max(-60, 20 * Math.log10(linear));
  return ((db + 60) / 60) * meterHeight;
}

const levels = computed(() => {
  const l = meterStore.trackLevels.get(props.trackId);
  if (!l) return { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
  return {
    peakL: levelToHeight(l.peak_l),
    peakR: levelToHeight(l.peak_r),
    rmsL: levelToHeight(l.rms_l),
    rmsR: levelToHeight(l.rms_r),
  };
});

const holdLines = computed(() => {
  const hold = meterStore.peakHold.get(props.trackId);
  if (!hold) return { l: 0, r: 0 };
  return {
    l: levelToHeight(hold.l),
    r: levelToHeight(hold.r),
  };
});

const isClipped = computed(() => meterStore.clipIndicators.get(props.trackId) ?? false);

function handleClipClick() {
  meterStore.clearTrackClip(props.trackId);
}
</script>

<template>
  <div
    class="flex gap-px items-end shrink-0"
    :style="{ height: '20px', width: '14px' }"
  >
    <!-- Clip indicator dot -->
    <div
      class="absolute -top-0.5 left-0 right-0 flex justify-center cursor-pointer"
      @click.stop="handleClipClick"
    >
      <div
        class="w-[6px] h-[6px] rounded-full transition-colors"
        :class="isClipped ? 'bg-red-500' : 'bg-red-900/30'"
      />
    </div>

    <!-- Left channel -->
    <div class="relative w-[5px] bg-gray-800 overflow-hidden" :style="{ height: `${meterHeight}px` }">
      <!-- Gradient background (revealed by meter level) -->
      <div
        class="absolute inset-0"
        style="background: linear-gradient(to top, #22c55e 0%, #22c55e 57%, #eab308 57%, #eab308 90%, #ef4444 90%, #ef4444 100%)"
      />
      <!-- Dark overlay that scales down to reveal the gradient -->
      <div
        class="absolute inset-0 bg-gray-800 origin-top"
        :style="{ transform: `scaleY(${1 - levels.peakL / meterHeight})` }"
      />
      <!-- RMS indicator (slightly wider appearance via opacity) -->
      <div
        class="absolute bottom-0 left-0 right-0 bg-white/20"
        :style="{ height: `${levels.rmsL}px` }"
      />
      <!-- Peak hold line -->
      <div
        v-if="holdLines.l > 1"
        class="absolute left-0 right-0 h-px bg-white/70"
        :style="{ bottom: `${holdLines.l}px` }"
      />
    </div>

    <!-- Right channel -->
    <div class="relative w-[5px] bg-gray-800 overflow-hidden" :style="{ height: `${meterHeight}px` }">
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
</template>
