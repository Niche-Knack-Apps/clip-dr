/**
 * Niche-Knack App Template - Main Entry Point
 *
 * This file sets up the Tauri IPC bridge and provides utilities for
 * communicating with the AI engine backend.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Types matching Rust backend
interface EngineHealth {
  running: boolean;
  version?: string;
}

interface JobResult {
  success: boolean;
  job_id?: string;
  error?: string;
}

interface JobStatus {
  job_id: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  progress?: number;
  result?: unknown;
  error?: string;
}

interface JobEvent {
  type: 'progress' | 'log' | 'result' | 'error';
  job_id: string;
  timestamp: number;
  data: unknown;
}

interface SettingsResult {
  success: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

// Engine API
export const engine = {
  async start(): Promise<{ success: boolean; error?: string }> {
    return invoke('engine_start');
  },

  async stop(): Promise<{ success: boolean; error?: string }> {
    return invoke('engine_stop');
  },

  async health(): Promise<EngineHealth> {
    return invoke('engine_health');
  },

  async call(method: string, params: unknown): Promise<unknown> {
    return invoke('engine_call', { method, params });
  }
};

// Jobs API
export const jobs = {
  async start(jobType: string, payload: unknown): Promise<JobResult> {
    return invoke('job_start', { jobType, payload });
  },

  async status(jobId: string): Promise<JobStatus> {
    return invoke('job_status', { jobId });
  },

  async cancel(jobId: string): Promise<{ success: boolean; error?: string }> {
    return invoke('job_cancel', { jobId });
  },

  async list(): Promise<JobStatus[]> {
    return invoke('job_list');
  },

  onEvent(callback: (event: JobEvent) => void): Promise<UnlistenFn> {
    return listen<JobEvent>('job-event', (event) => {
      callback(event.payload);
    });
  }
};

// Settings API
export const settings = {
  async get(): Promise<Record<string, unknown>> {
    const result: SettingsResult = await invoke('settings_get');
    return result.settings ?? {};
  },

  async set(settings: Record<string, unknown>): Promise<boolean> {
    const result: SettingsResult = await invoke('settings_set', { settings });
    return result.success;
  }
};

// UI Helpers
class AppUI {
  private statusIndicator: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private jobStatusEl: HTMLElement | null = null;
  private unlistenJob: UnlistenFn | null = null;

  async init(): Promise<void> {
    this.statusIndicator = document.getElementById('engine-status');
    this.statusText = this.statusIndicator?.querySelector('.status-text') ?? null;
    this.jobStatusEl = document.getElementById('job-status');

    // Start listening for job events
    this.unlistenJob = await jobs.onEvent((event) => {
      this.handleJobEvent(event);
    });

    // Start engine and check health
    await this.startEngine();

    // Periodic health check
    setInterval(() => this.checkHealth(), 5000);
  }

  private async startEngine(): Promise<void> {
    this.setEngineStatus('connecting', 'Engine: Starting...');

    const result = await engine.start();
    if (result.success) {
      await this.checkHealth();
    } else {
      this.setEngineStatus('disconnected', `Engine: ${result.error ?? 'Failed to start'}`);
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const health = await engine.health();
      if (health.running) {
        const version = health.version ? ` v${health.version}` : '';
        this.setEngineStatus('connected', `Engine: Connected${version}`);
      } else {
        this.setEngineStatus('disconnected', 'Engine: Not running');
      }
    } catch {
      this.setEngineStatus('disconnected', 'Engine: Disconnected');
    }
  }

  private setEngineStatus(status: 'connected' | 'connecting' | 'disconnected', text: string): void {
    if (this.statusIndicator) {
      this.statusIndicator.className = `status-indicator ${status}`;
    }
    if (this.statusText) {
      this.statusText.textContent = text;
    }
  }

  private handleJobEvent(event: JobEvent): void {
    if (this.jobStatusEl) {
      switch (event.type) {
        case 'progress':
          this.jobStatusEl.textContent = `Job ${event.job_id}: ${(event.data as number) * 100}%`;
          break;
        case 'log':
          console.log(`[Job ${event.job_id}]`, event.data);
          break;
        case 'result':
          this.jobStatusEl.textContent = `Job ${event.job_id}: Complete`;
          break;
        case 'error':
          this.jobStatusEl.textContent = `Job ${event.job_id}: Error - ${event.data}`;
          break;
      }
    }
  }

  destroy(): void {
    if (this.unlistenJob) {
      this.unlistenJob();
    }
  }
}

// Initialize app
const app = new AppUI();

document.addEventListener('DOMContentLoaded', () => {
  app.init().catch(console.error);
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  app.destroy();
});

// Export for app-specific code
export { app };
