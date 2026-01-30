/**
 * Core types for the desktop-runtime engine contract.
 * Defines the JSON-RPC protocol and standard interfaces for engine communication.
 */

// ============================================================================
// JSON-RPC Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// Engine Health
// ============================================================================

export interface HealthStatus {
  status: 'ok' | 'error' | 'degraded';
  version: string;
  uptime: number;
  memory: {
    used: number;
    total: number;
  };
}

// ============================================================================
// Job Management
// ============================================================================

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobPriority = 'low' | 'normal' | 'high';

export interface JobStartParams {
  type: string;
  payload: unknown;
  priority?: JobPriority;
}

export interface JobStartResult {
  jobId: string;
}

export interface JobStatus {
  state: JobState;
  progress?: number;
  message?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface JobResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface JobCancelResult {
  success: boolean;
  reason?: string;
}

export interface JobInfo {
  jobId: string;
  type: string;
  state: JobState;
  progress?: number;
}

// ============================================================================
// Streaming Events
// ============================================================================

export type JobEventType = 'progress' | 'log' | 'partial' | 'result' | 'error';

export interface JobEvent<T = unknown> {
  type: JobEventType;
  jobId: string;
  timestamp: number;
  data: T;
}

export interface ProgressData {
  percent: number;
  message?: string;
}

export interface LogData {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

// ============================================================================
// Cache Operations
// ============================================================================

export interface CacheGetResult<T = unknown> {
  found: boolean;
  value?: T;
  expiresAt?: number;
}

export interface CacheSetParams {
  key: string;
  value: unknown;
  ttl?: number;
}

export interface CacheSetResult {
  success: boolean;
}

export interface CacheDeleteResult {
  success: boolean;
}

export interface CacheClearParams {
  prefix?: string;
}

export interface CacheClearResult {
  success: boolean;
  cleared: number;
}

// ============================================================================
// Model Management
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  type: string;
  loaded: boolean;
  size: number;
}

export interface ModelLoadParams {
  modelId: string;
  options?: Record<string, unknown>;
}

export interface ModelLoadResult {
  success: boolean;
  loadTime: number;
}

export interface ModelUnloadResult {
  success: boolean;
}

export interface ModelStatus {
  loaded: boolean;
  memoryUsage?: number;
  lastUsed?: number;
}

// ============================================================================
// Engine Contract Interface
// ============================================================================

export interface EngineContract {
  // Health
  'engine.health': () => Promise<HealthStatus>;

  // Jobs
  'jobs.start': (params: JobStartParams) => Promise<JobStartResult>;
  'jobs.status': (params: { jobId: string }) => Promise<JobStatus>;
  'jobs.result': (params: { jobId: string }) => Promise<JobResult>;
  'jobs.cancel': (params: { jobId: string }) => Promise<JobCancelResult>;
  'jobs.list': () => Promise<JobInfo[]>;

  // Cache
  'cache.get': (params: { key: string }) => Promise<CacheGetResult>;
  'cache.set': (params: CacheSetParams) => Promise<CacheSetResult>;
  'cache.delete': (params: { key: string }) => Promise<CacheDeleteResult>;
  'cache.clear': (params: CacheClearParams) => Promise<CacheClearResult>;

  // Models
  'models.list': () => Promise<ModelInfo[]>;
  'models.load': (params: ModelLoadParams) => Promise<ModelLoadResult>;
  'models.unload': (params: { modelId: string }) => Promise<ModelUnloadResult>;
  'models.status': (params: { modelId: string }) => Promise<ModelStatus>;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  // Standard JSON-RPC errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Job errors (-31xxx)
  JOB_NOT_FOUND: -31001,
  JOB_ALREADY_RUNNING: -31002,
  JOB_CANCELLED: -31003,
  JOB_TIMEOUT: -31004,

  // Model errors (-30xxx)
  MODEL_NOT_FOUND: -30001,
  MODEL_LOAD_FAILED: -30002,
  INSUFFICIENT_MEMORY: -30003,

  // Cache errors (-29xxx)
  CACHE_MISS: -29001,
  CACHE_FULL: -29002,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ============================================================================
// Client Configuration
// ============================================================================

export interface EngineClientConfig {
  /** Path to the engine executable */
  enginePath: string;

  /** Working directory for the engine process */
  cwd?: string;

  /** Environment variables to pass to the engine */
  env?: Record<string, string>;

  /** Timeout for individual requests in milliseconds */
  requestTimeout?: number;

  /** Maximum time to wait for engine startup in milliseconds */
  startupTimeout?: number;

  /** Whether to restart engine on crash */
  autoRestart?: boolean;

  /** Maximum restart attempts */
  maxRestarts?: number;

  /** Delay between restart attempts in milliseconds */
  restartDelay?: number;
}

export interface JobManagerConfig {
  /** Maximum concurrent jobs */
  concurrency?: number;

  /** Default job timeout in milliseconds */
  defaultTimeout?: number;

  /** Retry failed jobs */
  retryOnFailure?: boolean;

  /** Maximum retry attempts */
  maxRetries?: number;

  /** Delay between retries in milliseconds */
  retryDelay?: number;
}

// ============================================================================
// Event Types
// ============================================================================

export type EngineEventType =
  | 'ready'
  | 'error'
  | 'exit'
  | 'restart'
  | 'job:progress'
  | 'job:complete'
  | 'job:error';

export interface EngineEvent {
  type: EngineEventType;
  timestamp: number;
  data?: unknown;
}

export type EngineEventHandler = (event: EngineEvent) => void;
