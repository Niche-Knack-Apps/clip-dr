# Niche-Knack App Development Contract

This document defines the shared conventions and standards that all Niche-Knack desktop applications must follow. It serves as the authoritative reference for architecture, IPC protocols, UI patterns, and development practices.

---

## Table of Contents

1. [Engine Contract](#1-engine-contract)
2. [IPC Patterns](#2-ipc-patterns)
3. [Project Structure](#3-project-structure)
4. [UI Standards](#4-ui-standards)
5. [Error Handling](#5-error-handling)
6. [Logging Conventions](#6-logging-conventions)
7. [Build & Packaging](#7-build--packaging)
8. [Testing Requirements](#8-testing-requirements)
9. [Documentation Standards](#9-documentation-standards)
10. [Security Guidelines](#10-security-guidelines)

---

## 1. Engine Contract

All compute-heavy operations must communicate through the standardized engine contract using JSON-RPC 2.0 over stdio.

### 1.1 Protocol Specification

**Transport**: JSON-RPC 2.0 over stdio (stdin/stdout)
**Encoding**: UTF-8, newline-delimited JSON

#### Request Format
```json
{
  "jsonrpc": "2.0",
  "id": "uuid-v4-string",
  "method": "namespace.action",
  "params": {}
}
```

#### Response Format
```json
{
  "jsonrpc": "2.0",
  "id": "uuid-v4-string",
  "result": {}
}
```

#### Error Response
```json
{
  "jsonrpc": "2.0",
  "id": "uuid-v4-string",
  "error": {
    "code": -32000,
    "message": "Error description",
    "data": {}
  }
}
```

### 1.2 Standard Methods

All engines MUST implement these core methods:

#### Health Check
```typescript
'engine.health': () => {
  status: 'ok' | 'error' | 'degraded';
  version: string;
  uptime: number;
  memory: { used: number; total: number };
}
```

#### Job Management
```typescript
'jobs.start': (params: {
  type: string;
  payload: unknown;
  priority?: 'low' | 'normal' | 'high';
}) => { jobId: string }

'jobs.status': (params: { jobId: string }) => {
  state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: number;  // 0-100
  message?: string;
  startedAt?: number;
  completedAt?: number;
}

'jobs.result': (params: { jobId: string }) => {
  success: boolean;
  data?: unknown;
  error?: string;
}

'jobs.cancel': (params: { jobId: string }) => {
  success: boolean;
  reason?: string;
}

'jobs.list': () => Array<{
  jobId: string;
  type: string;
  state: string;
  progress?: number;
}>
```

#### Cache Operations
```typescript
'cache.get': (params: { key: string }) => {
  found: boolean;
  value?: unknown;
  expiresAt?: number;
}

'cache.set': (params: {
  key: string;
  value: unknown;
  ttl?: number;  // seconds
}) => { success: boolean }

'cache.delete': (params: { key: string }) => { success: boolean }

'cache.clear': (params: { prefix?: string }) => {
  success: boolean;
  cleared: number;
}
```

#### Model Management (AI Apps)
```typescript
'models.list': () => Array<{
  id: string;
  name: string;
  type: string;
  loaded: boolean;
  size: number;
}>

'models.load': (params: {
  modelId: string;
  options?: Record<string, unknown>;
}) => {
  success: boolean;
  loadTime: number;
}

'models.unload': (params: { modelId: string }) => {
  success: boolean;
}

'models.status': (params: { modelId: string }) => {
  loaded: boolean;
  memoryUsage?: number;
  lastUsed?: number;
}
```

### 1.3 Streaming Events

For long-running jobs, engines emit progress events via stdout:

```typescript
interface JobEvent {
  type: 'progress' | 'log' | 'partial' | 'result' | 'error';
  jobId: string;
  timestamp: number;
  data: unknown;
}
```

**Progress Event**
```json
{
  "type": "progress",
  "jobId": "abc-123",
  "timestamp": 1699900000000,
  "data": { "percent": 45, "message": "Processing frame 45/100" }
}
```

**Partial Result Event** (for streaming results)
```json
{
  "type": "partial",
  "jobId": "abc-123",
  "timestamp": 1699900000000,
  "data": { "chunk": "partial data here" }
}
```

### 1.4 Error Codes

Standard JSON-RPC error codes plus custom ranges:

| Code | Meaning |
|------|---------|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |
| -32000 to -32099 | Server errors (reserved) |
| -31000 to -31099 | Job errors |
| -30000 to -30099 | Model errors |
| -29000 to -29099 | Cache errors |

**Custom Error Codes**
| Code | Meaning |
|------|---------|
| -31001 | Job not found |
| -31002 | Job already running |
| -31003 | Job cancelled |
| -31004 | Job timeout |
| -30001 | Model not found |
| -30002 | Model load failed |
| -30003 | Insufficient memory |
| -29001 | Cache miss |
| -29002 | Cache full |

---

## 2. IPC Patterns

### 2.1 Electron IPC (Current)

All IPC handlers use the invoke/handle pattern with context isolation:

```typescript
// preload.ts
contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) =>
    ipcRenderer.on(channel, (_event, ...args) => callback(...args)),
  off: (channel: string, callback: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(channel, callback)
});
```

### 2.2 Tauri Commands (Future)

```rust
#[tauri::command]
async fn engine_call(
    method: String,
    params: serde_json::Value,
    state: State<'_, EngineState>
) -> Result<serde_json::Value, String> {
    state.engine.call(&method, params).await
}
```

### 2.3 Channel Naming Convention

Format: `domain:action` or `domain:entity:action`

Examples:
- `engine:health`
- `jobs:start`
- `jobs:status`
- `project:open`
- `project:save`
- `settings:get`
- `settings:set`

### 2.4 Request/Response Types

All IPC calls must have typed request and response interfaces:

```typescript
// types/ipc.ts
interface IpcChannels {
  'project:open': {
    request: { path: string };
    response: { success: boolean; project?: Project; error?: string };
  };
  'project:save': {
    request: { project: Project };
    response: { success: boolean; error?: string };
  };
  // ... etc
}
```

---

## 3. Project Structure

### 3.1 Tauri App Structure (Target)

```
app-name/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── lib.rs            # Library root
│   │   ├── commands/         # IPC command handlers
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs
│   │   │   ├── project.rs
│   │   │   └── settings.rs
│   │   ├── engine/           # AI engine bridge
│   │   │   ├── mod.rs
│   │   │   ├── client.rs
│   │   │   └── types.rs
│   │   ├── menu.rs           # Application menus
│   │   ├── tray.rs           # System tray
│   │   └── updater.rs        # Auto-update logic
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── src/                      # Frontend
│   ├── index.html
│   ├── main.ts               # Entry point
│   ├── App.vue               # (if Vue)
│   ├── components/
│   ├── composables/          # (if Vue)
│   ├── stores/               # State management
│   ├── styles/
│   ├── types/
│   └── utils/
├── package.json
├── vite.config.ts            # (if Vite)
├── tsconfig.json
└── README.md
```

### 3.2 Electron App Structure (Current)

```
app-name/
├── main.js                   # Main process entry
├── preload.js                # Context bridge
├── renderer/
│   ├── index.html
│   ├── js/
│   ├── css/
│   └── assets/
├── src/                      # (Vue apps)
│   ├── main/
│   ├── preload/
│   └── renderer/
├── resources/                # Static resources
├── build/                    # Build assets (icons)
├── package.json
└── electron-builder.yml
```

### 3.3 Shared Resources

Location: `_shared/`

- `AboutPanel.vue` - Standardized about dialog
- `debug-logger.js` - Logging framework
- `niche-knack-config.js` - Common configuration

---

## 4. UI Standards

### 4.1 Design Principles

1. **Consistency**: All apps share common UI patterns
2. **Responsiveness**: UI never blocks on long operations
3. **Accessibility**: WCAG 2.1 AA compliance minimum
4. **Platform Feel**: Respect OS conventions (menus, shortcuts)

### 4.2 Color Palette

```css
:root {
  /* Primary */
  --nk-primary: #2563eb;
  --nk-primary-hover: #1d4ed8;
  --nk-primary-active: #1e40af;

  /* Neutral */
  --nk-bg: #ffffff;
  --nk-bg-secondary: #f8fafc;
  --nk-border: #e2e8f0;
  --nk-text: #1e293b;
  --nk-text-secondary: #64748b;

  /* Status */
  --nk-success: #22c55e;
  --nk-warning: #f59e0b;
  --nk-error: #ef4444;
  --nk-info: #3b82f6;

  /* Dark mode */
  --nk-dark-bg: #0f172a;
  --nk-dark-bg-secondary: #1e293b;
  --nk-dark-border: #334155;
  --nk-dark-text: #f1f5f9;
  --nk-dark-text-secondary: #94a3b8;
}
```

### 4.3 Typography

```css
:root {
  --nk-font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --nk-font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --nk-text-xs: 0.75rem;
  --nk-text-sm: 0.875rem;
  --nk-text-base: 1rem;
  --nk-text-lg: 1.125rem;
  --nk-text-xl: 1.25rem;
  --nk-text-2xl: 1.5rem;
}
```

### 4.4 Spacing

```css
:root {
  --nk-space-1: 0.25rem;
  --nk-space-2: 0.5rem;
  --nk-space-3: 0.75rem;
  --nk-space-4: 1rem;
  --nk-space-6: 1.5rem;
  --nk-space-8: 2rem;
  --nk-space-12: 3rem;
}
```

### 4.5 Component Patterns

#### Progress Indicators
- Use determinate progress bars when progress is known
- Use spinners for indeterminate operations < 5 seconds
- Use skeleton loaders for content loading
- Always show cancel option for operations > 2 seconds

#### Dialogs
- Modal dialogs for destructive actions requiring confirmation
- Non-modal for informational notifications
- Always provide keyboard shortcuts (Escape to close)

#### Forms
- Inline validation with immediate feedback
- Disable submit until valid
- Show loading state during submission

### 4.6 Keyboard Shortcuts

Standard shortcuts across all apps:

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| New | Ctrl+N | Cmd+N |
| Open | Ctrl+O | Cmd+O |
| Save | Ctrl+S | Cmd+S |
| Save As | Ctrl+Shift+S | Cmd+Shift+S |
| Close | Ctrl+W | Cmd+W |
| Quit | Ctrl+Q | Cmd+Q |
| Preferences | Ctrl+, | Cmd+, |
| Undo | Ctrl+Z | Cmd+Z |
| Redo | Ctrl+Shift+Z | Cmd+Shift+Z |
| Cut | Ctrl+X | Cmd+X |
| Copy | Ctrl+C | Cmd+C |
| Paste | Ctrl+V | Cmd+V |
| Find | Ctrl+F | Cmd+F |
| Zoom In | Ctrl++ | Cmd++ |
| Zoom Out | Ctrl+- | Cmd+- |
| Reset Zoom | Ctrl+0 | Cmd+0 |
| Toggle DevTools | F12 | F12 |

---

## 5. Error Handling

### 5.1 Error Categories

```typescript
enum ErrorCategory {
  USER = 'user',           // Invalid user input
  SYSTEM = 'system',       // OS/filesystem errors
  NETWORK = 'network',     // Connectivity issues
  ENGINE = 'engine',       // AI engine errors
  INTERNAL = 'internal'    // Unexpected bugs
}
```

### 5.2 Error Response Format

```typescript
interface AppError {
  code: string;            // Machine-readable code
  category: ErrorCategory;
  message: string;         // User-friendly message
  details?: string;        // Technical details
  recoverable: boolean;    // Can user retry?
  action?: {               // Suggested action
    label: string;
    handler: string;
  };
}
```

### 5.3 Error Handling Patterns

#### Main Process
```typescript
try {
  const result = await riskyOperation();
  return { success: true, data: result };
} catch (error) {
  logger.error('Operation failed', { error, context });
  return {
    success: false,
    error: {
      code: 'OPERATION_FAILED',
      category: 'system',
      message: 'The operation could not be completed.',
      details: error.message,
      recoverable: true
    }
  };
}
```

#### Renderer Process
```typescript
const result = await window.api.invoke('operation', params);
if (!result.success) {
  showErrorToast(result.error.message);
  if (result.error.action) {
    showActionButton(result.error.action);
  }
}
```

### 5.4 User-Facing Error Messages

- Never expose stack traces or technical details to users
- Provide actionable guidance when possible
- Log full error details for debugging
- Use consistent tone (helpful, not blaming)

---

## 6. Logging Conventions

### 6.1 Log Levels

| Level | Usage |
|-------|-------|
| ERROR | Unrecoverable errors, exceptions |
| WARN | Recoverable issues, deprecations |
| INFO | Significant state changes, user actions |
| DEBUG | Detailed debugging information |
| TRACE | Very verbose, method entry/exit |

### 6.2 Log Format

```
[TIMESTAMP] [LEVEL] [COMPONENT] Message {context}
```

Example:
```
[2024-01-15T10:30:45.123Z] [INFO] [ProjectManager] Project opened {"path": "/home/user/project.json", "duration": 234}
```

### 6.3 Structured Logging

```typescript
import { logger } from '@shared/debug-logger';

// Component-scoped logger
const log = logger.scope('ProjectManager');

log.info('Project opened', { path, duration });
log.error('Failed to save', { error: err.message, projectId });
log.debug('Cache hit', { key, size: value.length });
```

### 6.4 Log Storage

- **Development**: Console output
- **Production**: File rotation in app data directory
  - Location: `{userData}/logs/`
  - Rotation: Daily, keep 7 days
  - Max size: 10MB per file

---

## 7. Build & Packaging

### 7.1 Build Targets

| Platform | Formats |
|----------|---------|
| Linux | AppImage (primary), .deb |
| Windows | NSIS installer, portable .exe |
| macOS | .dmg, .zip |

### 7.2 Bundle Structure

```
app-name-1.0.0-linux.AppImage
├── app/
│   ├── resources/
│   │   ├── app.asar        # App code (encrypted)
│   │   └── engine/         # AI engine binary
│   └── ...
```

### 7.3 Version Scheme

Semantic Versioning: `MAJOR.MINOR.PATCH`

- MAJOR: Breaking changes
- MINOR: New features, backward compatible
- PATCH: Bug fixes

### 7.4 Auto-Update Configuration

```json
{
  "updater": {
    "active": true,
    "endpoints": [
      "https://releases.niche-knack.com/{{target}}/{{arch}}/{{current_version}}"
    ],
    "dialog": true,
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6..."
  }
}
```

### 7.5 Build Scripts

Every app must have:
- `npm run dev` - Development mode with hot reload
- `npm run build` - Production build
- `npm run build:linux` - Linux packages
- `npm run build:win` - Windows packages
- `npm run build:mac` - macOS packages

---

## 8. Testing Requirements

### 8.1 Test Types

| Type | Coverage Target | Framework |
|------|-----------------|-----------|
| Unit | 80% business logic | Vitest/Jest |
| Integration | Critical paths | Playwright |
| E2E | Happy paths | Playwright |

### 8.2 Test Structure

```
tests/
├── unit/
│   ├── services/
│   └── utils/
├── integration/
│   └── ipc/
└── e2e/
    └── flows/
```

### 8.3 Test Naming

```typescript
describe('ProjectManager', () => {
  describe('openProject', () => {
    it('should load project from valid path', async () => {});
    it('should return error for missing file', async () => {});
    it('should migrate legacy format', async () => {});
  });
});
```

### 8.4 CI Requirements

- All tests must pass before merge
- No decrease in coverage allowed
- Lint checks must pass
- Type checks must pass

---

## 9. Documentation Standards

### 9.1 Required Documentation

Each app must have:
- `README.md` - Overview, setup, usage
- `CHANGELOG.md` - Version history
- `docs/architecture.md` - System design
- Inline JSDoc/TSDoc comments for public APIs

### 9.2 README Template

```markdown
# App Name

Brief description of what the app does.

## Features

- Feature 1
- Feature 2

## Installation

### From Release
Download from [releases page](link).

### From Source
```bash
npm install
npm run build
```

## Usage

Basic usage instructions.

## Development

```bash
npm run dev
```

## License

[License type]
```

### 9.3 Code Comments

```typescript
/**
 * Opens a project file and validates its structure.
 *
 * @param path - Absolute path to the project file
 * @param options - Optional loading options
 * @returns The loaded project or an error
 * @throws {ValidationError} If the project format is invalid
 *
 * @example
 * const project = await openProject('/path/to/project.json');
 */
async function openProject(
  path: string,
  options?: OpenOptions
): Promise<Result<Project>> {
  // Implementation
}
```

---

## 10. Security Guidelines

### 10.1 Context Isolation

All apps MUST use:
```javascript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true  // when possible
}
```

### 10.2 Input Validation

- Validate all user input before processing
- Sanitize file paths to prevent directory traversal
- Use parameterized queries for databases
- Escape HTML in user-generated content

### 10.3 Sensitive Data

- Never store passwords in plaintext
- Use OS keychain for credentials when possible
- Encrypt sensitive project data at rest
- Clear sensitive data from memory when done

### 10.4 External Processes

- Validate binary paths before execution
- Use absolute paths for spawned processes
- Sanitize arguments passed to external commands
- Set resource limits (memory, CPU) where possible

### 10.5 Network Security

- Always use HTTPS for network requests
- Validate SSL certificates
- Implement request timeouts
- Rate limit API calls

---

## Appendix A: Checklist for New Apps

- [ ] Follows project structure conventions
- [ ] Implements engine contract (if compute-heavy)
- [ ] Uses standard IPC patterns
- [ ] Follows UI design standards
- [ ] Implements error handling patterns
- [ ] Uses logging framework
- [ ] Has build scripts for all platforms
- [ ] Has test coverage
- [ ] Has required documentation
- [ ] Follows security guidelines

## Appendix B: Migration Checklist (Electron → Tauri)

- [ ] Create Tauri project structure
- [ ] Port IPC handlers to Rust commands
- [ ] Update frontend to use Tauri APIs
- [ ] Configure engine bridge
- [ ] Set up auto-updater
- [ ] Update build scripts
- [ ] Test on all platforms
- [ ] Compare metrics with baseline

---

*Last Updated: 2024-01*
*Version: 1.0.0*
