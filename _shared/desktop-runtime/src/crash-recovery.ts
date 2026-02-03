/**
 * Crash Recovery - Handles engine crashes, restarts, and job resume.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { EngineClient } from './engine-client.js';
import type { JobState, JobPriority } from './types.js';

interface PersistedJob {
  id: string;
  type: string;
  payload: unknown;
  priority: JobPriority;
  state: JobState;
  progress: number;
  createdAt: number;
  startedAt?: number;
  retries: number;
}

interface RecoveryState {
  engineVersion: string;
  lastHealthCheck: number;
  pendingJobs: PersistedJob[];
  runningJobs: PersistedJob[];
}

interface CrashRecoveryConfig {
  /** Directory to store recovery state */
  stateDir: string;

  /** How often to persist state (ms) */
  persistInterval?: number;

  /** Maximum jobs to recover */
  maxRecoveredJobs?: number;

  /** Whether to auto-recover on startup */
  autoRecover?: boolean;

  /** Callback for job recovery */
  onJobRecovery?: (job: PersistedJob) => Promise<void>;
}

const DEFAULT_CONFIG = {
  persistInterval: 5000,
  maxRecoveredJobs: 100,
  autoRecover: true,
};

export class CrashRecovery extends EventEmitter {
  private config: CrashRecoveryConfig & typeof DEFAULT_CONFIG;
  private engine: EngineClient;
  private state: RecoveryState | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private statePath: string;
  private isDirty = false;
  private initialized = false;

  constructor(engine: EngineClient, config: CrashRecoveryConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.engine = engine;
    this.statePath = join(this.config.stateDir, 'recovery-state.json');
  }

  /**
   * Initialize crash recovery.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure state directory exists
    await fs.mkdir(this.config.stateDir, { recursive: true });

    // Load existing state
    await this.loadState();

    // Set up engine event listeners
    this.setupEngineListeners();

    // Start persistence timer
    this.startPersistTimer();

    // Auto-recover if configured
    if (this.config.autoRecover && this.state) {
      await this.recover();
    }

    this.initialized = true;
  }

  /**
   * Shutdown crash recovery.
   */
  async shutdown(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }

    // Final state persistence
    if (this.isDirty) {
      await this.persistState();
    }
  }

  /**
   * Track a new job.
   */
  trackJob(job: {
    id: string;
    type: string;
    payload: unknown;
    priority: JobPriority;
  }): void {
    if (!this.state) {
      this.initializeState();
    }

    const persistedJob: PersistedJob = {
      ...job,
      state: 'pending',
      progress: 0,
      createdAt: Date.now(),
      retries: 0,
    };

    this.state!.pendingJobs.push(persistedJob);
    this.markDirty();
  }

  /**
   * Update job state.
   */
  updateJobState(jobId: string, state: JobState, progress?: number): void {
    if (!this.state) return;

    // Check pending jobs
    const pendingIndex = this.state.pendingJobs.findIndex((j) => j.id === jobId);
    if (pendingIndex !== -1) {
      const job = this.state.pendingJobs[pendingIndex];

      if (state === 'running') {
        // Move to running
        this.state.pendingJobs.splice(pendingIndex, 1);
        job.state = 'running';
        job.startedAt = Date.now();
        if (progress !== undefined) job.progress = progress;
        this.state.runningJobs.push(job);
      } else if (state === 'done' || state === 'failed' || state === 'cancelled') {
        // Remove from tracking
        this.state.pendingJobs.splice(pendingIndex, 1);
      }

      this.markDirty();
      return;
    }

    // Check running jobs
    const runningIndex = this.state.runningJobs.findIndex((j) => j.id === jobId);
    if (runningIndex !== -1) {
      const job = this.state.runningJobs[runningIndex];

      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        // Remove from tracking
        this.state.runningJobs.splice(runningIndex, 1);
      } else {
        // Update state/progress
        job.state = state;
        if (progress !== undefined) job.progress = progress;
      }

      this.markDirty();
    }
  }

  /**
   * Remove a job from tracking.
   */
  removeJob(jobId: string): void {
    if (!this.state) return;

    const pendingIndex = this.state.pendingJobs.findIndex((j) => j.id === jobId);
    if (pendingIndex !== -1) {
      this.state.pendingJobs.splice(pendingIndex, 1);
      this.markDirty();
      return;
    }

    const runningIndex = this.state.runningJobs.findIndex((j) => j.id === jobId);
    if (runningIndex !== -1) {
      this.state.runningJobs.splice(runningIndex, 1);
      this.markDirty();
    }
  }

  /**
   * Get jobs that need recovery.
   */
  getRecoverableJobs(): PersistedJob[] {
    if (!this.state) return [];

    // All pending and running jobs are recoverable
    return [
      ...this.state.pendingJobs,
      ...this.state.runningJobs.map((j) => ({
        ...j,
        state: 'pending' as JobState, // Reset running jobs to pending
        retries: j.retries + 1,
      })),
    ].slice(0, this.config.maxRecoveredJobs);
  }

  /**
   * Recover jobs after engine restart.
   */
  async recover(): Promise<number> {
    const jobs = this.getRecoverableJobs();
    if (jobs.length === 0) return 0;

    this.emit('recovery:start', { jobCount: jobs.length });

    let recovered = 0;
    for (const job of jobs) {
      try {
        if (this.config.onJobRecovery) {
          await this.config.onJobRecovery(job);
          recovered++;
        }
        this.emit('recovery:job', { job, success: true });
      } catch (error) {
        this.emit('recovery:job', { job, success: false, error });
      }
    }

    // Clear recovered jobs from state
    if (this.state) {
      this.state.pendingJobs = [];
      this.state.runningJobs = [];
      this.markDirty();
      await this.persistState();
    }

    this.emit('recovery:complete', { recovered, total: jobs.length });
    return recovered;
  }

  /**
   * Clear all recovery state.
   */
  async clearState(): Promise<void> {
    this.state = null;
    this.initializeState();

    try {
      await fs.unlink(this.statePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Get recovery statistics.
   */
  getStats(): {
    pendingJobs: number;
    runningJobs: number;
    lastHealthCheck: number | null;
  } {
    return {
      pendingJobs: this.state?.pendingJobs.length ?? 0,
      runningJobs: this.state?.runningJobs.length ?? 0,
      lastHealthCheck: this.state?.lastHealthCheck ?? null,
    };
  }

  /**
   * Initialize empty state.
   */
  private initializeState(): void {
    this.state = {
      engineVersion: '',
      lastHealthCheck: 0,
      pendingJobs: [],
      runningJobs: [],
    };
  }

  /**
   * Load state from disk.
   */
  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(content) as RecoveryState;
    } catch {
      // No existing state or parse error
      this.initializeState();
    }
  }

  /**
   * Persist state to disk.
   */
  private async persistState(): Promise<void> {
    if (!this.state) return;

    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.statePath, content, 'utf-8');
      this.isDirty = false;
    } catch (error) {
      console.error('[CrashRecovery] Failed to persist state:', error);
    }
  }

  /**
   * Mark state as dirty (needs persistence).
   */
  private markDirty(): void {
    this.isDirty = true;
  }

  /**
   * Start the persistence timer.
   */
  private startPersistTimer(): void {
    this.persistTimer = setInterval(async () => {
      if (this.isDirty) {
        await this.persistState();
      }
    }, this.config.persistInterval);
  }

  /**
   * Set up engine event listeners.
   */
  private setupEngineListeners(): void {
    // Track health checks
    this.engine.on('ready', () => {
      if (this.state) {
        this.state.lastHealthCheck = Date.now();
        this.markDirty();
      }
    });

    // Handle engine exit
    this.engine.on('exit', async () => {
      // Persist state immediately on exit
      if (this.isDirty) {
        await this.persistState();
      }
    });

    // Handle engine restart
    this.engine.on('restart', async () => {
      // Attempt recovery after restart
      if (this.config.autoRecover) {
        await this.recover();
      }
    });
  }
}
