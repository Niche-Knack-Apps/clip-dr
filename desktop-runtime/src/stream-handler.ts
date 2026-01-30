/**
 * Stream Handler - Handles streaming events from the engine to the UI.
 */

import { EventEmitter } from 'node:events';
import type { JobEvent, ProgressData, LogData } from './types.js';

type StreamEventType = 'data' | 'progress' | 'log' | 'partial' | 'complete' | 'error' | 'close';
type StreamEventHandler<T = unknown> = (data: T) => void;

interface StreamSubscription {
  id: string;
  jobId: string;
  handler: StreamEventHandler;
  eventTypes: Set<StreamEventType>;
}

/**
 * Manages streaming job events and distributes them to subscribers.
 */
export class StreamHandler extends EventEmitter {
  private subscriptions: Map<string, StreamSubscription> = new Map();
  private jobSubscriptions: Map<string, Set<string>> = new Map();
  private nextSubscriptionId = 1;

  /**
   * Subscribe to events for a specific job.
   */
  subscribe(
    jobId: string,
    handler: StreamEventHandler<JobEvent>,
    eventTypes: StreamEventType[] = ['data', 'progress', 'partial', 'complete', 'error']
  ): string {
    const subscriptionId = `sub_${this.nextSubscriptionId++}`;

    const subscription: StreamSubscription = {
      id: subscriptionId,
      jobId,
      handler: handler as StreamEventHandler,
      eventTypes: new Set(eventTypes),
    };

    this.subscriptions.set(subscriptionId, subscription);

    // Track job -> subscriptions mapping
    if (!this.jobSubscriptions.has(jobId)) {
      this.jobSubscriptions.set(jobId, new Set());
    }
    this.jobSubscriptions.get(jobId)!.add(subscriptionId);

    return subscriptionId;
  }

  /**
   * Unsubscribe from job events.
   */
  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;

    this.subscriptions.delete(subscriptionId);

    const jobSubs = this.jobSubscriptions.get(subscription.jobId);
    if (jobSubs) {
      jobSubs.delete(subscriptionId);
      if (jobSubs.size === 0) {
        this.jobSubscriptions.delete(subscription.jobId);
      }
    }

    return true;
  }

  /**
   * Unsubscribe all handlers for a job.
   */
  unsubscribeAll(jobId: string): number {
    const jobSubs = this.jobSubscriptions.get(jobId);
    if (!jobSubs) return 0;

    let count = 0;
    for (const subscriptionId of jobSubs) {
      this.subscriptions.delete(subscriptionId);
      count++;
    }

    this.jobSubscriptions.delete(jobId);
    return count;
  }

  /**
   * Dispatch an event to all subscribers for a job.
   */
  dispatch(event: JobEvent): void {
    const jobSubs = this.jobSubscriptions.get(event.jobId);
    if (!jobSubs) return;

    const eventType = this.mapEventType(event.type);

    for (const subscriptionId of jobSubs) {
      const subscription = this.subscriptions.get(subscriptionId);
      if (subscription && subscription.eventTypes.has(eventType)) {
        try {
          subscription.handler(event);
        } catch (error) {
          console.error('[StreamHandler] Handler error:', error);
        }
      }
    }

    // Emit global event
    this.emit(eventType, event);
    this.emit('event', event);
  }

  /**
   * Create a progress tracker for a job.
   */
  createProgressTracker(jobId: string): ProgressTracker {
    return new ProgressTracker(jobId, (event) => this.dispatch(event));
  }

  /**
   * Get subscription count for a job.
   */
  getSubscriptionCount(jobId: string): number {
    return this.jobSubscriptions.get(jobId)?.size ?? 0;
  }

  /**
   * Get all active job IDs with subscriptions.
   */
  getActiveJobIds(): string[] {
    return Array.from(this.jobSubscriptions.keys());
  }

  /**
   * Map engine event type to stream event type.
   */
  private mapEventType(type: string): StreamEventType {
    switch (type) {
      case 'progress':
        return 'progress';
      case 'log':
        return 'log';
      case 'partial':
        return 'partial';
      case 'result':
        return 'complete';
      case 'error':
        return 'error';
      default:
        return 'data';
    }
  }
}

/**
 * Helper class for tracking and emitting progress events.
 */
export class ProgressTracker {
  private jobId: string;
  private dispatcher: (event: JobEvent) => void;
  private lastProgress = 0;
  private startTime: number;

  constructor(jobId: string, dispatcher: (event: JobEvent) => void) {
    this.jobId = jobId;
    this.dispatcher = dispatcher;
    this.startTime = Date.now();
  }

  /**
   * Update progress (0-100).
   */
  setProgress(percent: number, message?: string): void {
    percent = Math.max(0, Math.min(100, percent));

    // Only emit if progress increased
    if (percent > this.lastProgress) {
      this.lastProgress = percent;
      this.emitProgress({ percent, message });
    }
  }

  /**
   * Increment progress by a delta.
   */
  incrementProgress(delta: number, message?: string): void {
    this.setProgress(this.lastProgress + delta, message);
  }

  /**
   * Emit a log message.
   */
  log(level: LogData['level'], message: string, context?: Record<string, unknown>): void {
    const event: JobEvent<LogData> = {
      type: 'log',
      jobId: this.jobId,
      timestamp: Date.now(),
      data: { level, message, context },
    };
    this.dispatcher(event);
  }

  /**
   * Emit a partial result.
   */
  emitPartial(data: unknown): void {
    const event: JobEvent = {
      type: 'partial',
      jobId: this.jobId,
      timestamp: Date.now(),
      data,
    };
    this.dispatcher(event);
  }

  /**
   * Complete the job with a result.
   */
  complete(data: unknown): void {
    this.setProgress(100);
    const event: JobEvent = {
      type: 'result',
      jobId: this.jobId,
      timestamp: Date.now(),
      data,
    };
    this.dispatcher(event);
  }

  /**
   * Fail the job with an error.
   */
  error(error: string | Error): void {
    const event: JobEvent = {
      type: 'error',
      jobId: this.jobId,
      timestamp: Date.now(),
      data: error instanceof Error ? error.message : error,
    };
    this.dispatcher(event);
  }

  /**
   * Get elapsed time in milliseconds.
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get current progress percentage.
   */
  getCurrentProgress(): number {
    return this.lastProgress;
  }

  /**
   * Emit a progress event.
   */
  private emitProgress(data: ProgressData): void {
    const event: JobEvent<ProgressData> = {
      type: 'progress',
      jobId: this.jobId,
      timestamp: Date.now(),
      data,
    };
    this.dispatcher(event);
  }
}

/**
 * Create an async iterator for streaming job events.
 */
export function createJobStream(
  streamHandler: StreamHandler,
  jobId: string
): AsyncIterable<JobEvent> & { cancel: () => void } {
  let subscriptionId: string | null = null;
  let resolve: ((value: IteratorResult<JobEvent>) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  const eventQueue: JobEvent[] = [];
  let done = false;
  let cancelled = false;

  const handler = (event: JobEvent) => {
    if (done || cancelled) return;

    if (event.type === 'result' || event.type === 'error') {
      eventQueue.push(event);
      done = true;
    } else {
      eventQueue.push(event);
    }

    if (resolve) {
      const nextEvent = eventQueue.shift();
      if (nextEvent) {
        const r = resolve;
        resolve = null;
        r({ value: nextEvent, done: false });
      }
    }
  };

  subscriptionId = streamHandler.subscribe(jobId, handler);

  const iterator: AsyncIterator<JobEvent> = {
    async next(): Promise<IteratorResult<JobEvent>> {
      if (cancelled) {
        return { value: undefined, done: true };
      }

      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        const isDone = done && eventQueue.length === 0;
        return { value: event, done: isDone };
      }

      if (done) {
        return { value: undefined, done: true };
      }

      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },

    async return(): Promise<IteratorResult<JobEvent>> {
      if (subscriptionId) {
        streamHandler.unsubscribe(subscriptionId);
        subscriptionId = null;
      }
      done = true;
      return { value: undefined, done: true };
    },
  };

  const asyncIterable = {
    [Symbol.asyncIterator](): AsyncIterator<JobEvent> {
      return iterator;
    },
    cancel(): void {
      cancelled = true;
      if (subscriptionId) {
        streamHandler.unsubscribe(subscriptionId);
        subscriptionId = null;
      }
      if (reject) {
        reject(new Error('Stream cancelled'));
      }
    },
  };

  return asyncIterable;
}
