# @niche-knack/desktop-runtime

Standardized IPC protocol for Niche-Knack desktop apps to communicate with compute engines via JSON-RPC over stdio.

## Features

- **EngineClient**: Spawn and communicate with compute engines
- **JobManager**: Queue, concurrency control, and retry logic
- **CacheManager**: Disk and memory caching with TTL
- **StreamHandler**: Stream job events to UI components
- **CrashRecovery**: Engine restart and job resume

## Installation

```bash
npm install @niche-knack/desktop-runtime
```

## Quick Start

```typescript
import {
  EngineClient,
  JobManager,
  CacheManager,
  StreamHandler,
} from '@niche-knack/desktop-runtime';

// Create engine client
const engine = new EngineClient({
  enginePath: '/path/to/engine',
  autoRestart: true,
});

// Start engine
await engine.start();

// Create job manager
const jobManager = new JobManager(engine, {
  concurrency: 2,
  retryOnFailure: true,
});

// Submit a job
const result = await jobManager.submit('ocr', {
  imagePath: '/path/to/image.png',
});

console.log(result);
// { success: true, data: { text: 'extracted text...' } }
```

## Engine Contract

The runtime expects engines to implement the JSON-RPC 2.0 protocol over stdio.

### Health Check

```typescript
// Request
{ "jsonrpc": "2.0", "id": "1", "method": "engine.health" }

// Response
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "status": "ok",
    "version": "1.0.0",
    "uptime": 12345,
    "memory": { "used": 100000000, "total": 500000000 }
  }
}
```

### Job Management

```typescript
// Start a job
{ "jsonrpc": "2.0", "id": "2", "method": "jobs.start", "params": { "type": "ocr", "payload": {...} } }
// Response: { "result": { "jobId": "abc-123" } }

// Check job status
{ "jsonrpc": "2.0", "id": "3", "method": "jobs.status", "params": { "jobId": "abc-123" } }
// Response: { "result": { "state": "running", "progress": 45 } }

// Cancel a job
{ "jsonrpc": "2.0", "id": "4", "method": "jobs.cancel", "params": { "jobId": "abc-123" } }
// Response: { "result": { "success": true } }
```

### Streaming Events

Engines can emit events via stdout:

```json
{ "type": "progress", "jobId": "abc-123", "timestamp": 1699900000000, "data": { "percent": 45, "message": "Processing..." } }
{ "type": "partial", "jobId": "abc-123", "timestamp": 1699900000100, "data": { "chunk": "partial result" } }
{ "type": "result", "jobId": "abc-123", "timestamp": 1699900000200, "data": { "text": "final result" } }
```

## API Reference

### EngineClient

```typescript
const client = new EngineClient({
  enginePath: string,           // Path to engine executable
  cwd?: string,                 // Working directory
  env?: Record<string, string>, // Environment variables
  requestTimeout?: number,      // Request timeout (ms), default: 30000
  startupTimeout?: number,      // Startup timeout (ms), default: 10000
  autoRestart?: boolean,        // Auto-restart on crash, default: true
  maxRestarts?: number,         // Max restart attempts, default: 3
  restartDelay?: number,        // Delay between restarts (ms), default: 1000
});

await client.start();           // Start the engine
await client.stop();            // Stop the engine
client.isReady();               // Check if ready
await client.call(method, params); // Call a method

// Events
client.on('ready', handler);
client.on('error', handler);
client.on('exit', handler);
client.on('restart', handler);
client.on('job:progress', handler);
client.on('job:complete', handler);
client.on('job:error', handler);
```

### JobManager

```typescript
const manager = new JobManager(engine, {
  concurrency?: number,       // Max concurrent jobs, default: 2
  defaultTimeout?: number,    // Job timeout (ms), default: 300000
  retryOnFailure?: boolean,   // Retry failed jobs, default: false
  maxRetries?: number,        // Max retry attempts, default: 3
  retryDelay?: number,        // Retry delay (ms), default: 1000
});

const result = await manager.submit(type, payload, {
  priority?: 'low' | 'normal' | 'high',
  timeout?: number,
});

manager.getStatus(jobId);     // Get job status
manager.cancel(jobId);        // Cancel a job
manager.getJobs();            // List all jobs
manager.getQueueLength();     // Queue length
manager.getActiveCount();     // Active job count

// Events
manager.on('job:queued', handler);
manager.on('job:started', handler);
manager.on('job:progress', handler);
manager.on('job:completed', handler);
```

### CacheManager

```typescript
const cache = new CacheManager({
  cacheDir: string,             // Cache directory path
  maxMemorySize?: number,       // Max memory size (bytes), default: 50MB
  defaultTtl?: number | null,   // Default TTL (seconds), null = no expiry
  persistToDisk?: boolean,      // Enable disk cache, default: true
});

await cache.init();             // Initialize
await cache.get(key);           // Get value
await cache.set(key, value, ttl); // Set value
await cache.delete(key);        // Delete value
await cache.clear(prefix);      // Clear by prefix
cache.getStats();               // Get statistics
await cache.prune();            // Remove expired entries
```

### StreamHandler

```typescript
const stream = new StreamHandler();

// Subscribe to job events
const subId = stream.subscribe(jobId, handler, ['progress', 'complete']);

// Unsubscribe
stream.unsubscribe(subId);
stream.unsubscribeAll(jobId);

// Dispatch events
stream.dispatch(event);

// Create async iterator
const iterator = createJobStream(stream, jobId);
for await (const event of iterator) {
  console.log(event);
}
iterator.cancel();

// Progress tracker
const tracker = stream.createProgressTracker(jobId);
tracker.setProgress(50, 'Halfway done');
tracker.log('info', 'Processing...');
tracker.emitPartial({ chunk: 'data' });
tracker.complete({ result: 'done' });
```

### CrashRecovery

```typescript
const recovery = new CrashRecovery(engine, {
  stateDir: string,             // State directory path
  persistInterval?: number,     // Persist interval (ms), default: 5000
  maxRecoveredJobs?: number,    // Max jobs to recover, default: 100
  autoRecover?: boolean,        // Auto-recover on startup, default: true
  onJobRecovery?: (job) => Promise<void>,  // Recovery callback
});

await recovery.init();          // Initialize
await recovery.shutdown();      // Shutdown

recovery.trackJob(job);         // Track a job
recovery.updateJobState(id, state, progress); // Update state
recovery.removeJob(id);         // Remove job

recovery.getRecoverableJobs();  // Get jobs to recover
await recovery.recover();       // Recover jobs
await recovery.clearState();    // Clear state
recovery.getStats();            // Get statistics

// Events
recovery.on('recovery:start', handler);
recovery.on('recovery:job', handler);
recovery.on('recovery:complete', handler);
```

## Error Codes

```typescript
import { ErrorCodes } from '@niche-knack/desktop-runtime';

ErrorCodes.PARSE_ERROR       // -32700
ErrorCodes.INVALID_REQUEST   // -32600
ErrorCodes.METHOD_NOT_FOUND  // -32601
ErrorCodes.INVALID_PARAMS    // -32602
ErrorCodes.INTERNAL_ERROR    // -32603
ErrorCodes.JOB_NOT_FOUND     // -31001
ErrorCodes.JOB_ALREADY_RUNNING // -31002
ErrorCodes.JOB_CANCELLED     // -31003
ErrorCodes.JOB_TIMEOUT       // -31004
ErrorCodes.MODEL_NOT_FOUND   // -30001
ErrorCodes.MODEL_LOAD_FAILED // -30002
ErrorCodes.INSUFFICIENT_MEMORY // -30003
ErrorCodes.CACHE_MISS        // -29001
ErrorCodes.CACHE_FULL        // -29002
```

## License

MIT
