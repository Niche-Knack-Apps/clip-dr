/**
 * Job Manager - Manages job queue, concurrency, and lifecycle.
 */

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type { EngineClient } from './engine-client.js';
import type {
  JobManagerConfig,
  JobState,
  JobPriority,
  JobStatus,
  JobResult,
  JobEvent,
  ProgressData,
} from './types.js';

const DEFAULT_CONFIG: Required<JobManagerConfig> = {
  concurrency: 2,
  defaultTimeout: 300000, // 5 minutes
  retryOnFailure: false,
  maxRetries: 3,
  retryDelay: 1000,
};

interface QueuedJob {
  id: string;
  type: string;
  payload: unknown;
  priority: JobPriority;
  timeout: number;
  retries: number;
  createdAt: number;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
}

interface ActiveJob {
  id: string;
  engineJobId: string;
  type: string;
  state: JobState;
  progress: number;
  message?: string;
  startedAt: number;
  unsubscribe: () => void;
  timeoutHandle: NodeJS.Timeout;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
}

export class JobManager extends EventEmitter {
  private config: Required<JobManagerConfig>;
  private engine: EngineClient;
  private queue: QueuedJob[] = [];
  private active: Map<string, ActiveJob> = new Map();
  private completed: Map<string, JobResult> = new Map();
  private isProcessing = false;

  constructor(engine: EngineClient, config: JobManagerConfig = {}) {
    super();
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Submit a job to the queue.
   */
  async submit<T = unknown>(
    type: string,
    payload: unknown,
    options: {
      priority?: JobPriority;
      timeout?: number;
    } = {}
  ): Promise<JobResult<T>> {
    const id = uuidv4();
    const priority = options.priority ?? 'normal';
    const timeout = options.timeout ?? this.config.defaultTimeout;

    return new Promise((resolve, reject) => {
      const job: QueuedJob = {
        id,
        type,
        payload,
        priority,
        timeout,
        retries: 0,
        createdAt: Date.now(),
        resolve: resolve as (result: JobResult) => void,
        reject,
      };

      this.enqueue(job);
      this.processQueue();
    });
  }

  /**
   * Get the status of a job.
   */
  getStatus(jobId: string): JobStatus | null {
    // Check active jobs
    const active = this.active.get(jobId);
    if (active) {
      return {
        state: active.state,
        progress: active.progress,
        message: active.message,
        startedAt: active.startedAt,
      };
    }

    // Check queue
    const queued = this.queue.find((j) => j.id === jobId);
    if (queued) {
      return {
        state: 'pending',
      };
    }

    // Check completed
    const completed = this.completed.get(jobId);
    if (completed) {
      return {
        state: completed.success ? 'done' : 'failed',
        completedAt: Date.now(), // We don't track this precisely
      };
    }

    return null;
  }

  /**
   * Cancel a job.
   */
  async cancel(jobId: string): Promise<boolean> {
    // Check queue first
    const queueIndex = this.queue.findIndex((j) => j.id === jobId);
    if (queueIndex !== -1) {
      const job = this.queue.splice(queueIndex, 1)[0];
      job.reject(new Error('Job cancelled'));
      return true;
    }

    // Check active jobs
    const active = this.active.get(jobId);
    if (active) {
      try {
        await this.engine.call('jobs.cancel', { jobId: active.engineJobId });
        this.cleanupActiveJob(jobId, { success: false, error: 'Job cancelled' });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Get all jobs (queued + active).
   */
  getJobs(): Array<{ id: string; type: string; state: JobState; progress?: number }> {
    const jobs: Array<{ id: string; type: string; state: JobState; progress?: number }> =
      [];

    // Queued jobs
    for (const job of this.queue) {
      jobs.push({
        id: job.id,
        type: job.type,
        state: 'pending',
      });
    }

    // Active jobs
    for (const [id, job] of this.active) {
      jobs.push({
        id,
        type: job.type,
        state: job.state,
        progress: job.progress,
      });
    }

    return jobs;
  }

  /**
   * Get queue length.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get active job count.
   */
  getActiveCount(): number {
    return this.active.size;
  }

  /**
   * Clear completed job results from memory.
   */
  clearCompleted(): void {
    this.completed.clear();
  }

  /**
   * Enqueue a job with priority ordering.
   */
  private enqueue(job: QueuedJob): void {
    const priorityOrder = { high: 0, normal: 1, low: 2 };

    // Find insertion point based on priority
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (priorityOrder[job.priority] < priorityOrder[this.queue[i].priority]) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, job);
    this.emit('job:queued', { jobId: job.id, type: job.type, priority: job.priority });
  }

  /**
   * Process the job queue.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && this.active.size < this.config.concurrency) {
        if (!this.engine.isReady()) {
          break;
        }

        const job = this.queue.shift()!;
        await this.startJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Start a job on the engine.
   */
  private async startJob(job: QueuedJob): Promise<void> {
    try {
      // Start the job on the engine
      const result = await this.engine.call<{ jobId: string }>('jobs.start', {
        type: job.type,
        payload: job.payload,
        priority: job.priority,
      });

      const engineJobId = result.jobId;

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.handleJobTimeout(job.id);
      }, job.timeout);

      // Subscribe to job events
      const unsubscribe = this.engine.onJobEvent(engineJobId, (event) => {
        this.handleJobEvent(job.id, event);
      });

      // Track active job
      const activeJob: ActiveJob = {
        id: job.id,
        engineJobId,
        type: job.type,
        state: 'running',
        progress: 0,
        startedAt: Date.now(),
        unsubscribe,
        timeoutHandle,
        resolve: job.resolve,
        reject: job.reject,
      };

      this.active.set(job.id, activeJob);
      this.emit('job:started', { jobId: job.id, type: job.type });
    } catch (error) {
      // Failed to start job
      if (this.shouldRetry(job)) {
        job.retries++;
        setTimeout(() => {
          this.enqueue(job);
          this.processQueue();
        }, this.config.retryDelay);
      } else {
        job.reject(error as Error);
      }
    }
  }

  /**
   * Handle job events from the engine.
   */
  private handleJobEvent(jobId: string, event: JobEvent): void {
    const active = this.active.get(jobId);
    if (!active) return;

    switch (event.type) {
      case 'progress': {
        const data = event.data as ProgressData;
        active.progress = data.percent;
        active.message = data.message;
        this.emit('job:progress', {
          jobId,
          progress: data.percent,
          message: data.message,
        });
        break;
      }

      case 'result': {
        const result: JobResult = {
          success: true,
          data: event.data,
        };
        this.cleanupActiveJob(jobId, result);
        active.resolve(result);
        this.processQueue();
        break;
      }

      case 'error': {
        const result: JobResult = {
          success: false,
          error: String(event.data),
        };
        this.cleanupActiveJob(jobId, result);
        active.reject(new Error(String(event.data)));
        this.processQueue();
        break;
      }
    }
  }

  /**
   * Handle job timeout.
   */
  private handleJobTimeout(jobId: string): void {
    const active = this.active.get(jobId);
    if (!active) return;

    // Try to cancel the job on the engine
    this.engine.call('jobs.cancel', { jobId: active.engineJobId }).catch(() => {
      // Ignore errors
    });

    const result: JobResult = {
      success: false,
      error: 'Job timeout',
    };

    this.cleanupActiveJob(jobId, result);
    active.reject(new Error('Job timeout'));
    this.processQueue();
  }

  /**
   * Clean up an active job.
   */
  private cleanupActiveJob(jobId: string, result: JobResult): void {
    const active = this.active.get(jobId);
    if (!active) return;

    clearTimeout(active.timeoutHandle);
    active.unsubscribe();
    this.active.delete(jobId);
    this.completed.set(jobId, result);

    this.emit('job:completed', {
      jobId,
      success: result.success,
      duration: Date.now() - active.startedAt,
    });
  }

  /**
   * Check if a job should be retried.
   */
  private shouldRetry(job: QueuedJob): boolean {
    return this.config.retryOnFailure && job.retries < this.config.maxRetries;
  }
}
