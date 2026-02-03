/**
 * Engine Client - Spawns and communicates with compute engines via JSON-RPC over stdio.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type {
  EngineClientConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JobEvent,
  EngineEventType,
  EngineEvent,
  EngineEventHandler,
} from './types.js';

const DEFAULT_CONFIG: Required<Omit<EngineClientConfig, 'enginePath' | 'cwd' | 'env'>> = {
  requestTimeout: 30000,
  startupTimeout: 10000,
  autoRestart: true,
  maxRestarts: 3,
  restartDelay: 1000,
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class EngineClient extends EventEmitter {
  private config: EngineClientConfig & typeof DEFAULT_CONFIG;
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private restartCount = 0;
  private isShuttingDown = false;
  private ready = false;

  constructor(config: EngineClientConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the engine process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Engine already running');
    }

    this.isShuttingDown = false;
    await this.spawn();
  }

  /**
   * Stop the engine process.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.ready = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Engine shutting down'));
      this.pendingRequests.delete(id);
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process) {
      return new Promise((resolve) => {
        const forceKillTimeout = setTimeout(() => {
          this.process?.kill('SIGKILL');
        }, 5000);

        this.process!.once('exit', () => {
          clearTimeout(forceKillTimeout);
          this.process = null;
          resolve();
        });

        this.process!.kill('SIGTERM');
      });
    }
  }

  /**
   * Check if the engine is running and ready.
   */
  isReady(): boolean {
    return this.ready && this.process !== null;
  }

  /**
   * Call a method on the engine.
   */
  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.isReady()) {
      throw new Error('Engine not ready');
    }

    const id = uuidv4();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.config.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.send(request);
    });
  }

  /**
   * Subscribe to engine events.
   */
  on(event: EngineEventType, handler: EngineEventHandler): this {
    return super.on(event, handler);
  }

  /**
   * Subscribe to job events for a specific job.
   */
  onJobEvent(jobId: string, handler: (event: JobEvent) => void): () => void {
    const listener = (event: JobEvent) => {
      if (event.jobId === jobId) {
        handler(event);
      }
    };

    this.on('job:progress', listener as EngineEventHandler);
    this.on('job:complete', listener as EngineEventHandler);
    this.on('job:error', listener as EngineEventHandler);

    // Return unsubscribe function
    return () => {
      this.off('job:progress', listener as EngineEventHandler);
      this.off('job:complete', listener as EngineEventHandler);
      this.off('job:error', listener as EngineEventHandler);
    };
  }

  /**
   * Spawn the engine process.
   */
  private async spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error('Engine startup timeout'));
        this.process?.kill();
      }, this.config.startupTimeout);

      this.process = spawn(this.config.enginePath, [], {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.on('error', (error) => {
        clearTimeout(startupTimeout);
        this.emitEvent('error', error);
        reject(error);
      });

      this.process.on('exit', (code, signal) => {
        this.ready = false;
        this.emitEvent('exit', { code, signal });
        this.handleExit(code, signal);
      });

      // Set up stdout reader for JSON-RPC responses
      if (this.process.stdout) {
        this.readline = createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity,
        });

        this.readline.on('line', (line) => {
          this.handleLine(line);
        });
      }

      // Log stderr
      if (this.process.stderr) {
        this.process.stderr.on('data', (data) => {
          const message = data.toString().trim();
          if (message) {
            console.error(`[Engine stderr] ${message}`);
          }
        });
      }

      // Wait for initial health check
      this.waitForReady()
        .then(() => {
          clearTimeout(startupTimeout);
          this.ready = true;
          this.restartCount = 0;
          this.emitEvent('ready', null);
          resolve();
        })
        .catch((error) => {
          clearTimeout(startupTimeout);
          reject(error);
        });
    });
  }

  /**
   * Wait for the engine to be ready.
   */
  private async waitForReady(): Promise<void> {
    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Try to call health check
    const id = uuidv4();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method: 'engine.health',
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Health check timeout'));
      }, 5000);

      this.pendingRequests.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      this.send(request);
    });
  }

  /**
   * Send a JSON-RPC request to the engine.
   */
  private send(request: JsonRpcRequest): void {
    if (!this.process?.stdin) {
      throw new Error('Engine stdin not available');
    }

    const line = JSON.stringify(request) + '\n';
    this.process.stdin.write(line);
  }

  /**
   * Handle a line of output from the engine.
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const data = JSON.parse(line);

      // Check if it's a JSON-RPC response
      if ('jsonrpc' in data && 'id' in data) {
        this.handleResponse(data as JsonRpcResponse);
      }
      // Check if it's a streaming event
      else if ('type' in data && 'jobId' in data) {
        this.handleJobEvent(data as JobEvent);
      }
    } catch (error) {
      console.error('[Engine] Failed to parse line:', line, error);
    }
  }

  /**
   * Handle a JSON-RPC response.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn('[Engine] Received response for unknown request:', response.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle a streaming job event.
   */
  private handleJobEvent(event: JobEvent): void {
    switch (event.type) {
      case 'progress':
        this.emitEvent('job:progress', event);
        break;
      case 'result':
        this.emitEvent('job:complete', event);
        break;
      case 'error':
        this.emitEvent('job:error', event);
        break;
      default:
        // Log, partial, etc.
        this.emitEvent('job:progress', event);
    }
  }

  /**
   * Handle engine process exit.
   */
  private handleExit(code: number | null, signal: string | null): void {
    if (this.isShuttingDown) {
      return;
    }

    console.error(`[Engine] Process exited with code ${code}, signal ${signal}`);

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Engine process exited'));
      this.pendingRequests.delete(id);
    }

    // Attempt restart if configured
    if (this.config.autoRestart && this.restartCount < this.config.maxRestarts) {
      this.restartCount++;
      console.log(
        `[Engine] Attempting restart ${this.restartCount}/${this.config.maxRestarts}`
      );

      setTimeout(() => {
        this.spawn()
          .then(() => {
            this.emitEvent('restart', { attempt: this.restartCount });
          })
          .catch((error) => {
            console.error('[Engine] Restart failed:', error);
            this.emitEvent('error', error);
          });
      }, this.config.restartDelay);
    }
  }

  /**
   * Emit an engine event.
   */
  private emitEvent(type: EngineEventType, data: unknown): void {
    const event: EngineEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);
  }
}
