/**
 * DebugLogger - Cross-platform debug logging system for Tauri/Web
 *
 * Features:
 * - Auto-intercepts console.log/warn/error/info/debug
 * - Platform detection (Tauri vs Web)
 * - IndexedDB storage for Tauri/web
 * - Log rotation (FIFO when > maxEntries)
 * - Export as .log file
 * - Session tracking
 *
 * Usage:
 *   const logger = new DebugLogger({ appName: 'MyApp' });
 *   await logger.init();
 *
 * @version 1.0.0
 * @license MIT
 */

export interface LogEntry {
  id?: number;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  sessionId: string;
  source: string;
  stack?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  appName?: string;
  maxEntries?: number;
  maxSizeBytes?: number;
  dbName?: string;
  storeName?: string;
  enabled?: boolean;
}

export interface LogStats {
  totalCount: number;
  byLevel: { info: number; warn: number; error: number; debug: number };
  sessionCount: number;
  oldestLog: string | null;
  newestLog: string | null;
  estimatedSize: number;
}

export interface GetLogsOptions {
  limit?: number;
  level?: 'info' | 'warn' | 'error' | 'debug' | null;
  sessionId?: string | null;
}

type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export class DebugLogger {
  private config: Required<Omit<LoggerConfig, 'enabled'>> & { enabled: boolean };
  private sessionId: string;
  private sessionLogs: LogEntry[] = [];
  private initialized = false;
  private db: IDBDatabase | null = null;
  private isTauri: boolean;

  private _originalConsole: Record<ConsoleLevel, (...args: unknown[]) => void>;

  constructor(options: LoggerConfig = {}) {
    this.config = {
      appName: options.appName || 'App',
      maxEntries: options.maxEntries || 500,
      maxSizeBytes: options.maxSizeBytes || 1024 * 1024, // 1MB
      dbName: options.dbName || 'debug-logs',
      storeName: options.storeName || 'logs',
      enabled: options.enabled !== false,
    };

    this.sessionId = this._generateSessionId();

    // Platform detection - Tauri apps have __TAURI__ on window
    this.isTauri =
      typeof window !== 'undefined' &&
      '__TAURI__' in window;

    // Original console methods (for restoration and internal use)
    this._originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };
  }

  // ========== Public API ==========

  /**
   * Initialize the logger
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await this._initIndexedDB();
      this._log('info', '[DebugLogger] Using IndexedDB storage');

      // Intercept console methods
      if (this.config.enabled) {
        this._interceptConsole();
      }

      // Log session start
      await this.log('info', `Session started: ${this.config.appName}`, {
        platform: this._getPlatform(),
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
      });

      this.initialized = true;
    } catch (error) {
      this._originalConsole.error('[DebugLogger] Initialization failed:', error);
    }
  }

  /**
   * Log a message
   */
  async log(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    meta: Record<string, unknown> = {}
  ): Promise<void> {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message),
      sessionId: this.sessionId,
      source: (meta.source as string) || 'app',
      ...meta,
    };

    // Add stack trace for errors
    if (level === 'error') {
      entry.stack = this._getStackTrace();
    }

    // Add to session buffer
    this.sessionLogs.push(entry);

    // Trim session buffer if needed
    if (this.sessionLogs.length > this.config.maxEntries) {
      this.sessionLogs = this.sessionLogs.slice(-this.config.maxEntries);
    }

    // Persist to storage
    try {
      await this._persist(entry);
    } catch (error) {
      this._originalConsole.error('[DebugLogger] Persist failed:', error);
    }
  }

  /**
   * Get all logs with optional filtering
   */
  async getLogs(options: GetLogsOptions = {}): Promise<LogEntry[]> {
    const { limit = 1000, level = null, sessionId = null } = options;

    if (!this.db) return this.sessionLogs;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.config.storeName, 'readonly');
      const store = tx.objectStore(this.config.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        let logs: LogEntry[] = request.result || [];

        // Apply filters
        if (level) {
          logs = logs.filter((l) => l.level === level);
        }
        if (sessionId) {
          logs = logs.filter((l) => l.sessionId === sessionId);
        }

        // Sort by timestamp descending, limit
        logs = logs
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, limit);

        resolve(logs);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Export logs as downloadable file
   */
  async downloadLogs(): Promise<{ success: boolean; filename?: string; error?: string }> {
    try {
      const logs = await this.getLogs({ limit: this.config.maxEntries });
      const content = this._formatLogsForExport(logs);
      const filename = `${this.config.appName.toLowerCase().replace(/\s+/g, '-')}-logs-${this._formatDate()}.log`;

      this._blobDownload(content, filename);
      return { success: true, filename };
    } catch (error) {
      this._originalConsole.error('[DebugLogger] Download failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Clear all logs
   */
  async clearLogs(): Promise<void> {
    this.sessionLogs = [];

    if (this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db!.transaction(this.config.storeName, 'readwrite');
        const store = tx.objectStore(this.config.storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  /**
   * Get log statistics
   */
  async getStats(): Promise<LogStats> {
    const logs = await this.getLogs({ limit: this.config.maxEntries });

    const stats: LogStats = {
      totalCount: logs.length,
      byLevel: { info: 0, warn: 0, error: 0, debug: 0 },
      sessionCount: 0,
      oldestLog: null,
      newestLog: null,
      estimatedSize: 0,
    };

    const sessions = new Set<string>();

    logs.forEach((log) => {
      stats.byLevel[log.level] = (stats.byLevel[log.level] || 0) + 1;
      sessions.add(log.sessionId);
      stats.estimatedSize += JSON.stringify(log).length;

      const logTime = new Date(log.timestamp);
      if (!stats.oldestLog || logTime < new Date(stats.oldestLog)) {
        stats.oldestLog = log.timestamp;
      }
      if (!stats.newestLog || logTime > new Date(stats.newestLog)) {
        stats.newestLog = log.timestamp;
      }
    });

    stats.sessionCount = sessions.size;

    return stats;
  }

  /**
   * Restore original console methods and cleanup
   */
  destroy(): void {
    (Object.keys(this._originalConsole) as ConsoleLevel[]).forEach((level) => {
      console[level] = this._originalConsole[level];
    });
  }

  // ========== Private Methods ==========

  /**
   * Initialize IndexedDB for storage
   */
  private _initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(this.config.dbName, 1);

        request.onerror = () => {
          this._originalConsole.warn('[DebugLogger] IndexedDB failed:', request.error);
          resolve(); // Don't fail init, just use session storage
        };

        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(this.config.storeName)) {
            const store = db.createObjectStore(this.config.storeName, {
              keyPath: 'id',
              autoIncrement: true,
            });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('level', 'level', { unique: false });
            store.createIndex('sessionId', 'sessionId', { unique: false });
          }
        };
      } catch (error) {
        this._originalConsole.warn('[DebugLogger] IndexedDB not available:', error);
        resolve();
      }
    });
  }

  /**
   * Intercept console methods to capture all logs
   */
  private _interceptConsole(): void {
    const self = this;
    const levels: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug'];

    levels.forEach((level) => {
      console[level] = function (...args: unknown[]) {
        // Call original first
        self._originalConsole[level].apply(console, args);

        // Capture to logger
        const logLevel: 'info' | 'warn' | 'error' | 'debug' = level === 'log' ? 'info' : level;
        const message = args.map((arg) => self._stringify(arg)).join(' ');

        self.log(logLevel, message, { source: 'console' });
      };
    });
  }

  /**
   * Persist log entry to storage
   */
  private async _persist(entry: LogEntry): Promise<void> {
    if (this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db!.transaction(this.config.storeName, 'readwrite');
        const store = tx.objectStore(this.config.storeName);
        store.add(entry);

        tx.oncomplete = async () => {
          await this._enforceLimit();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  /**
   * Enforce storage limits (IndexedDB)
   */
  private async _enforceLimit(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.config.storeName, 'readwrite');
      const store = tx.objectStore(this.config.storeName);
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        const count = countRequest.result;
        if (count > this.config.maxEntries) {
          // Delete oldest entries
          const deleteCount = count - this.config.maxEntries;
          const cursorRequest = store.openCursor();
          let deleted = 0;

          cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor && deleted < deleteCount) {
              store.delete(cursor.primaryKey);
              deleted++;
              cursor.continue();
            }
          };
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // Don't fail on cleanup errors
    });
  }

  // ========== Helper Methods ==========

  private _generateSessionId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  private _getPlatform(): string {
    if (this.isTauri) return 'tauri';
    return 'web';
  }

  private _stringify(arg: unknown): string {
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
    }
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }

  private _getStackTrace(): string {
    try {
      throw new Error();
    } catch (e) {
      return (e as Error).stack?.split('\n').slice(3).join('\n') || '';
    }
  }

  private _formatDate(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private _formatLogsForExport(logs: LogEntry[]): string {
    const header =
      `${this.config.appName} Debug Logs\n` +
      `Exported: ${new Date().toISOString()}\n` +
      `Platform: ${this._getPlatform()}\n` +
      `Session: ${this.sessionId}\n` +
      `${'='.repeat(60)}\n\n`;

    const body = logs
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map((log) => {
        const ts = new Date(log.timestamp).toISOString();
        const level = log.level.toUpperCase().padEnd(5);
        let line = `[${ts}] [${level}] ${log.message}`;
        if (log.stack) {
          line += `\n${log.stack}`;
        }
        return line;
      })
      .join('\n');

    return header + body;
  }

  private _blobDownload(content: string, filename: string): void {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private _log(level: ConsoleLevel, ...args: unknown[]): void {
    this._originalConsole[level]?.apply(console, args);
  }
}

// Global instance for app-wide access
let loggerInstance: DebugLogger | null = null;

export function getLogger(): DebugLogger | null {
  return loggerInstance;
}

export function setLogger(logger: DebugLogger): void {
  loggerInstance = logger;
}
