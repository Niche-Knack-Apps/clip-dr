<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSearch } from '@/composables/useSearch';

const searchInput = ref<HTMLInputElement | null>(null);

const {
  query: _query,
  hasResults,
  currentResultIndex,
  resultCount,
  isSearching,
  search,
  clear,
  nextResult,
  previousResult,
} = useSearch();

const localQuery = ref('');

watch(localQuery, (value) => {
  search(value);
});

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) {
      previousResult();
    } else {
      nextResult();
    }
  } else if (event.key === 'Escape') {
    clear();
    localQuery.value = '';
    searchInput.value?.blur();
  }
}

function focus() {
  searchInput.value?.focus();
  searchInput.value?.select();
}

defineExpose({ focus });
</script>

<template>
  <div class="relative flex items-center">
    <div class="relative flex-1">
      <input
        ref="searchInput"
        v-model="localQuery"
        type="text"
        placeholder="Search transcription..."
        class="w-full h-8 pl-8 pr-3 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
        @keydown="handleKeyDown"
      />

      <svg
        class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>

      <div
        v-if="isSearching"
        class="absolute right-2.5 top-1/2 -translate-y-1/2"
      >
        <svg
          class="animate-spin w-4 h-4 text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      </div>
    </div>

    <div
      v-if="hasResults"
      class="flex items-center gap-1 ml-2"
    >
      <span class="text-xs text-gray-400">
        {{ currentResultIndex + 1 }}/{{ resultCount }}
      </span>

      <button
        type="button"
        class="p-1 text-gray-400 hover:text-gray-200 transition-colors"
        title="Previous (Shift+Enter)"
        @click="previousResult"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <button
        type="button"
        class="p-1 text-gray-400 hover:text-gray-200 transition-colors"
        title="Next (Enter)"
        @click="nextResult"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>

    <button
      v-if="localQuery"
      type="button"
      class="ml-1 p-1 text-gray-400 hover:text-gray-200 transition-colors"
      title="Clear search"
      @click="clear(); localQuery = ''"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
