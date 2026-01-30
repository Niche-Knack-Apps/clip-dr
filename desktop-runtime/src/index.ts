/**
 * @niche-knack/desktop-runtime
 *
 * Standardized IPC protocol for Niche-Knack desktop apps to communicate
 * with compute engines via JSON-RPC over stdio.
 */

// Core client
export { EngineClient } from './engine-client.js';

// Job management
export { JobManager } from './job-manager.js';

// Caching
export { CacheManager } from './cache-manager.js';

// Streaming
export {
  StreamHandler,
  ProgressTracker,
  createJobStream,
} from './stream-handler.js';

// Crash recovery
export { CrashRecovery } from './crash-recovery.js';

// Types
export type {
  // JSON-RPC
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,

  // Engine health
  HealthStatus,

  // Jobs
  JobState,
  JobPriority,
  JobStartParams,
  JobStartResult,
  JobStatus,
  JobResult,
  JobCancelResult,
  JobInfo,

  // Events
  JobEventType,
  JobEvent,
  ProgressData,
  LogData,

  // Cache
  CacheGetResult,
  CacheSetParams,
  CacheSetResult,
  CacheDeleteResult,
  CacheClearParams,
  CacheClearResult,

  // Models
  ModelInfo,
  ModelLoadParams,
  ModelLoadResult,
  ModelUnloadResult,
  ModelStatus,

  // Contract
  EngineContract,

  // Config
  EngineClientConfig,
  JobManagerConfig,

  // Engine events
  EngineEventType,
  EngineEvent,
  EngineEventHandler,
} from './types.js';

export { ErrorCodes } from './types.js';

// Re-export error code type
export type { ErrorCode } from './types.js';
