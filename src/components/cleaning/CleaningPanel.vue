<script setup lang="ts">
import Slider from '@/components/ui/Slider.vue';
import Toggle from '@/components/ui/Toggle.vue';
import { useCleaningStore } from '@/stores/cleaning';

const cleaningStore = useCleaningStore();

const mainsFrequencyOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'hz50', label: '50 Hz' },
  { value: 'hz60', label: '60 Hz' },
];

function formatHz(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} kHz`;
  }
  return `${Math.round(value)} Hz`;
}

function formatDb(value: number): string {
  return `${value.toFixed(0)} dB`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatRatio(value: number): string {
  return `${value.toFixed(1)}:1`;
}
</script>

<template>
  <div class="p-4 bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[320px] max-h-[80vh] overflow-y-auto">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-medium text-gray-200">Audio Cleaning</h3>
      <button
        class="text-xs text-gray-400 hover:text-gray-200"
        @click="cleaningStore.resetToDefaults()"
      >
        Reset
      </button>
    </div>

    <!-- Preset Selector -->
    <div class="mb-4">
      <label class="text-xs text-gray-400 block mb-1">Preset</label>
      <select
        :value="cleaningStore.selectedPreset ?? ''"
        class="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        @change="(e) => cleaningStore.applyPreset((e.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>Custom</option>
        <option
          v-for="preset in cleaningStore.presets"
          :key="preset.id"
          :value="preset.id"
        >
          {{ preset.name }}
        </option>
      </select>
      <p
        v-if="cleaningStore.selectedPreset"
        class="text-xs text-gray-500 mt-1"
      >
        {{ cleaningStore.presets.find(p => p.id === cleaningStore.selectedPreset)?.description }}
      </p>
    </div>

    <div class="space-y-4">
      <!-- Band-Limiting Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.highpassEnabled || cleaningStore.options.lowpassEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ highpassEnabled: v, lowpassEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Band-Limiting</span>
        </div>

        <div v-if="cleaningStore.options.highpassEnabled || cleaningStore.options.lowpassEnabled" class="ml-6 space-y-2">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs text-gray-500">High-pass</label>
              <Toggle
                :model-value="cleaningStore.options.highpassEnabled"
                @update:model-value="(v) => cleaningStore.setOptions({ highpassEnabled: v })"
              />
            </div>
            <Slider
              :model-value="cleaningStore.options.highpassFreq"
              :min="40"
              :max="150"
              :step="5"
              :disabled="!cleaningStore.options.highpassEnabled"
              show-value
              :format-value="formatHz"
              @update:model-value="(v) => cleaningStore.setOptions({ highpassFreq: v })"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs text-gray-500">Low-pass</label>
              <Toggle
                :model-value="cleaningStore.options.lowpassEnabled"
                @update:model-value="(v) => cleaningStore.setOptions({ lowpassEnabled: v })"
              />
            </div>
            <Slider
              :model-value="cleaningStore.options.lowpassFreq"
              :min="5000"
              :max="12000"
              :step="100"
              :disabled="!cleaningStore.options.lowpassEnabled"
              show-value
              :format-value="formatHz"
              @update:model-value="(v) => cleaningStore.setOptions({ lowpassFreq: v })"
            />
          </div>
        </div>
      </div>

      <!-- Hum Removal Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.notchEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ notchEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Hum Removal</span>
        </div>

        <div v-if="cleaningStore.options.notchEnabled" class="ml-6 space-y-2">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Mains Frequency</label>
            <div class="flex gap-2">
              <button
                v-for="opt in mainsFrequencyOptions"
                :key="opt.value"
                :class="[
                  'px-2 py-1 text-xs rounded transition-colors',
                  cleaningStore.options.mainsFrequency === opt.value
                    ? 'bg-cyan-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                ]"
                @click="cleaningStore.setOptions({ mainsFrequency: opt.value as any })"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <div>
            <label class="text-xs text-gray-500 block mb-1">
              Harmonics: {{ cleaningStore.options.notchHarmonics }}
            </label>
            <Slider
              :model-value="cleaningStore.options.notchHarmonics"
              :min="1"
              :max="4"
              :step="1"
              @update:model-value="(v) => cleaningStore.setOptions({ notchHarmonics: v })"
            />
          </div>
        </div>
      </div>

      <!-- Spectral Denoise Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.spectralEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ spectralEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Spectral Denoise</span>
        </div>

        <div v-if="cleaningStore.options.spectralEnabled" class="ml-6">
          <label class="text-xs text-gray-500 block mb-1">Reduction</label>
          <Slider
            :model-value="cleaningStore.options.noiseReductionDb"
            :min="0"
            :max="24"
            :step="1"
            show-value
            :format-value="formatDb"
            @update:model-value="(v) => cleaningStore.setOptions({ noiseReductionDb: v })"
          />
        </div>
      </div>

      <!-- Neural Denoise Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.neuralEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ neuralEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Neural Denoise (RNNoise)</span>
        </div>

        <div v-if="cleaningStore.options.neuralEnabled" class="ml-6">
          <label class="text-xs text-gray-500 block mb-1">Strength</label>
          <Slider
            :model-value="cleaningStore.options.neuralStrength"
            :min="0"
            :max="1"
            :step="0.05"
            show-value
            :format-value="formatPercent"
            @update:model-value="(v) => cleaningStore.setOptions({ neuralStrength: v })"
          />
        </div>
      </div>

      <!-- Expander Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.expanderEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ expanderEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Expander</span>
        </div>

        <div v-if="cleaningStore.options.expanderEnabled" class="ml-6 space-y-2">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Threshold</label>
            <Slider
              :model-value="cleaningStore.options.expanderThresholdDb"
              :min="-60"
              :max="-20"
              :step="1"
              show-value
              :format-value="formatDb"
              @update:model-value="(v) => cleaningStore.setOptions({ expanderThresholdDb: v })"
            />
          </div>

          <div>
            <label class="text-xs text-gray-500 block mb-1">Ratio</label>
            <Slider
              :model-value="cleaningStore.options.expanderRatio"
              :min="1.5"
              :max="4"
              :step="0.1"
              show-value
              :format-value="formatRatio"
              @update:model-value="(v) => cleaningStore.setOptions({ expanderRatio: v })"
            />
          </div>
        </div>
      </div>

      <!-- Dynamics Section -->
      <div class="border-t border-gray-700 pt-3">
        <div class="flex items-center mb-2">
          <Toggle
            :model-value="cleaningStore.options.dynamicsEnabled"
            @update:model-value="(v) => cleaningStore.setOptions({ dynamicsEnabled: v })"
          />
          <span class="ml-2 text-sm text-gray-300">Dynamics</span>
          <span class="ml-1 text-xs text-gray-500">(loudness restore)</span>
        </div>

        <div v-if="cleaningStore.options.dynamicsEnabled" class="ml-6 space-y-2">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Threshold</label>
            <Slider
              :model-value="cleaningStore.options.dynamicsThresholdDb"
              :min="-40"
              :max="-10"
              :step="1"
              show-value
              :format-value="formatDb"
              @update:model-value="(v) => cleaningStore.setOptions({ dynamicsThresholdDb: v })"
            />
          </div>

          <div>
            <label class="text-xs text-gray-500 block mb-1">Ratio</label>
            <Slider
              :model-value="cleaningStore.options.dynamicsRatio"
              :min="1.5"
              :max="4"
              :step="0.1"
              show-value
              :format-value="formatRatio"
              @update:model-value="(v) => cleaningStore.setOptions({ dynamicsRatio: v })"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="cleaningStore.error" class="mt-3 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ cleaningStore.error }}
    </div>

  </div>
</template>
