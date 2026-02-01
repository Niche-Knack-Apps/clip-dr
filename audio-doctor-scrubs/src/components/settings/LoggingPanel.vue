<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { getLogger, type LogStats, type LogEntry } from '@/services/debug-logger';
import Button from '@/components/ui/Button.vue';

const stats = ref<LogStats | null>(null);
const recentLogs = ref<LogEntry[]>([]);
const loading = ref(false);
const filterLevel = ref<'all' | 'info' | 'warn' | 'error' | 'debug'>('all');
const autoRefresh = ref(false);
const clearing = ref(false);
const downloading = ref(false);

let refreshInterval: number | null = null;

const filteredLogs = computed(() => {
  if (filterLevel.value === 'all') {
    return recentLogs.value;
  }
  return recentLogs.value.filter((log) => log.level === filterLevel.value);
});

async function loadData() {
  const logger = getLogger();
  if (!logger) return;

  loading.value = true;
  try {
    stats.value = await logger.getStats();
    recentLogs.value = await logger.getLogs({ limit: 50 });
  } finally {
    loading.value = false;
  }
}

async function handleDownload() {
  const logger = getLogger();
  if (!logger) return;

  downloading.value = true;
  try {
    const result = await logger.downloadLogs();
    if (!result.success) {
      console.error('Failed to download logs:', result.error);
    }
  } finally {
    downloading.value = false;
  }
}

async function handleClear() {
  const logger = getLogger();
  if (!logger) return;

  clearing.value = true;
  try {
    await logger.clearLogs();
    await loadData();
  } finally {
    clearing.value = false;
  }
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    refreshInterval = window.setInterval(loadData, 3000);
  } else if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getLevelClass(level: string): string {
  switch (level) {
    case 'error':
      return 'text-red-400';
    case 'warn':
      return 'text-yellow-400';
    case 'debug':
      return 'text-gray-500';
    default:
      return 'text-gray-300';
  }
}

onMounted(() => {
  loadData();
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="logging-panel">
    <!-- Stats -->
    <div v-if="stats" class="stats-grid">
      <div class="stat-item">
        <span class="stat-value">{{ stats.totalCount }}</span>
        <span class="stat-label">Total Logs</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ stats.sessionCount }}</span>
        <span class="stat-label">Sessions</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ formatSize(stats.estimatedSize) }}</span>
        <span class="stat-label">Size</span>
      </div>
    </div>

    <!-- Level breakdown -->
    <div v-if="stats" class="level-breakdown">
      <span class="level-badge level-info">
        {{ stats.byLevel.info }} info
      </span>
      <span class="level-badge level-warn">
        {{ stats.byLevel.warn }} warn
      </span>
      <span class="level-badge level-error">
        {{ stats.byLevel.error }} error
      </span>
      <span class="level-badge level-debug">
        {{ stats.byLevel.debug }} debug
      </span>
    </div>

    <!-- Actions -->
    <div class="actions">
      <Button
        variant="secondary"
        size="sm"
        :disabled="downloading"
        @click="handleDownload"
      >
        {{ downloading ? 'Downloading...' : 'Download Logs' }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :disabled="clearing"
        @click="handleClear"
      >
        {{ clearing ? 'Clearing...' : 'Clear Logs' }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :class="{ 'text-cyan-400': autoRefresh }"
        @click="toggleAutoRefresh"
      >
        {{ autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh' }}
      </Button>
    </div>

    <!-- Filter -->
    <div class="filter-row">
      <label class="filter-label">Filter:</label>
      <select v-model="filterLevel" class="filter-select">
        <option value="all">All Levels</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
        <option value="debug">Debug</option>
      </select>
      <button class="refresh-btn" @click="loadData" :disabled="loading">
        <svg
          class="w-4 h-4"
          :class="{ 'animate-spin': loading }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      </button>
    </div>

    <!-- Recent logs -->
    <div class="logs-container">
      <div v-if="filteredLogs.length === 0" class="no-logs">
        No logs to display
      </div>
      <div
        v-for="(log, index) in filteredLogs"
        :key="index"
        class="log-entry"
      >
        <span class="log-time">{{ formatTimestamp(log.timestamp) }}</span>
        <span class="log-level" :class="getLevelClass(log.level)">
          {{ log.level.toUpperCase() }}
        </span>
        <span class="log-message">{{ log.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logging-panel {
  padding: 8px 0;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

.stat-item {
  text-align: center;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}

.stat-value {
  display: block;
  font-size: 1.25rem;
  font-weight: 600;
  color: #22d3ee;
}

.stat-label {
  font-size: 0.7rem;
  opacity: 0.7;
  text-transform: uppercase;
}

.level-breakdown {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.level-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 4px;
}

.level-info {
  background: rgba(59, 130, 246, 0.2);
  color: #93c5fd;
}

.level-warn {
  background: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
}

.level-error {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.level-debug {
  background: rgba(107, 114, 128, 0.2);
  color: #9ca3af;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.filter-label {
  font-size: 0.75rem;
  opacity: 0.7;
}

.filter-select {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  font-size: 0.75rem;
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 4px;
  color: #e5e7eb;
}

.refresh-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid #374151;
  border-radius: 4px;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.refresh-btn:hover:not(:disabled) {
  border-color: #22d3ee;
  color: #22d3ee;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.logs-container {
  max-height: 200px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  padding: 8px;
  font-family: monospace;
  font-size: 0.7rem;
}

.no-logs {
  text-align: center;
  padding: 16px;
  opacity: 0.5;
  font-style: italic;
}

.log-entry {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.log-entry:last-child {
  border-bottom: none;
}

.log-time {
  color: #6b7280;
  flex-shrink: 0;
}

.log-level {
  width: 40px;
  flex-shrink: 0;
  font-weight: 600;
}

.log-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d1d5db;
}
</style>
