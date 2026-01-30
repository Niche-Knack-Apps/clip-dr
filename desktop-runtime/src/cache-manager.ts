/**
 * Cache Manager - Provides disk and memory caching with TTL support.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
  createdAt: number;
}

interface CacheManagerConfig {
  /** Directory for disk cache */
  cacheDir: string;

  /** Maximum memory cache size in bytes */
  maxMemorySize?: number;

  /** Default TTL in seconds (null = no expiry) */
  defaultTtl?: number | null;

  /** Whether to persist to disk */
  persistToDisk?: boolean;
}

const DEFAULT_CONFIG = {
  maxMemorySize: 50 * 1024 * 1024, // 50MB
  defaultTtl: null,
  persistToDisk: true,
};

export class CacheManager {
  private config: CacheManagerConfig & typeof DEFAULT_CONFIG;
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  private memoryCacheSize = 0;
  private initialized = false;

  constructor(config: CacheManagerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the cache manager.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.config.persistToDisk) {
      await fs.mkdir(this.config.cacheDir, { recursive: true });
    }

    this.initialized = true;
  }

  /**
   * Get a value from cache.
   */
  async get<T = unknown>(key: string): Promise<{ found: boolean; value?: T; expiresAt?: number }> {
    await this.ensureInitialized();

    // Check memory cache first
    const memoryEntry = this.memoryCache.get(key) as CacheEntry<T> | undefined;
    if (memoryEntry) {
      if (this.isExpired(memoryEntry)) {
        this.memoryCache.delete(key);
      } else {
        return {
          found: true,
          value: memoryEntry.value,
          expiresAt: memoryEntry.expiresAt ?? undefined,
        };
      }
    }

    // Check disk cache
    if (this.config.persistToDisk) {
      try {
        const diskEntry = await this.readFromDisk<T>(key);
        if (diskEntry) {
          if (this.isExpired(diskEntry)) {
            await this.deleteFromDisk(key);
          } else {
            // Promote to memory cache
            this.setMemoryCache(key, diskEntry);
            return {
              found: true,
              value: diskEntry.value,
              expiresAt: diskEntry.expiresAt ?? undefined,
            };
          }
        }
      } catch {
        // Disk read failed, continue
      }
    }

    return { found: false };
  }

  /**
   * Set a value in cache.
   */
  async set(key: string, value: unknown, ttl?: number): Promise<{ success: boolean }> {
    await this.ensureInitialized();

    const effectiveTtl = ttl ?? this.config.defaultTtl;
    const expiresAt = effectiveTtl ? Date.now() + effectiveTtl * 1000 : null;

    const entry: CacheEntry<unknown> = {
      value,
      expiresAt,
      createdAt: Date.now(),
    };

    // Set in memory cache
    this.setMemoryCache(key, entry);

    // Persist to disk if enabled
    if (this.config.persistToDisk) {
      try {
        await this.writeToDisk(key, entry);
      } catch (error) {
        console.error('[CacheManager] Failed to write to disk:', error);
      }
    }

    return { success: true };
  }

  /**
   * Delete a value from cache.
   */
  async delete(key: string): Promise<{ success: boolean }> {
    await this.ensureInitialized();

    // Remove from memory
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      this.memoryCacheSize -= this.estimateSize(memoryEntry);
      this.memoryCache.delete(key);
    }

    // Remove from disk
    if (this.config.persistToDisk) {
      try {
        await this.deleteFromDisk(key);
      } catch {
        // Ignore errors
      }
    }

    return { success: true };
  }

  /**
   * Clear cache entries matching a prefix.
   */
  async clear(prefix?: string): Promise<{ success: boolean; cleared: number }> {
    await this.ensureInitialized();

    let cleared = 0;

    // Clear from memory
    for (const key of this.memoryCache.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        const entry = this.memoryCache.get(key);
        if (entry) {
          this.memoryCacheSize -= this.estimateSize(entry);
        }
        this.memoryCache.delete(key);
        cleared++;
      }
    }

    // Clear from disk
    if (this.config.persistToDisk) {
      try {
        const files = await fs.readdir(this.config.cacheDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const key = this.fileToKey(file);
          if (!prefix || key.startsWith(prefix)) {
            await fs.unlink(join(this.config.cacheDir, file)).catch(() => {});
            cleared++;
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return { success: true, cleared };
  }

  /**
   * Get cache statistics.
   */
  getStats(): { memorySize: number; memoryCount: number; maxMemorySize: number } {
    return {
      memorySize: this.memoryCacheSize,
      memoryCount: this.memoryCache.size,
      maxMemorySize: this.config.maxMemorySize,
    };
  }

  /**
   * Prune expired entries from memory cache.
   */
  async prune(): Promise<number> {
    let pruned = 0;

    for (const [key, entry] of this.memoryCache) {
      if (this.isExpired(entry)) {
        this.memoryCacheSize -= this.estimateSize(entry);
        this.memoryCache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Check if an entry is expired.
   */
  private isExpired(entry: CacheEntry<unknown>): boolean {
    if (entry.expiresAt === null) return false;
    return Date.now() > entry.expiresAt;
  }

  /**
   * Set a value in memory cache with LRU eviction.
   */
  private setMemoryCache(key: string, entry: CacheEntry<unknown>): void {
    // Remove existing entry if present
    const existing = this.memoryCache.get(key);
    if (existing) {
      this.memoryCacheSize -= this.estimateSize(existing);
      this.memoryCache.delete(key);
    }

    const entrySize = this.estimateSize(entry);

    // Evict entries if necessary
    while (
      this.memoryCacheSize + entrySize > this.config.maxMemorySize &&
      this.memoryCache.size > 0
    ) {
      // Remove oldest entry (first in map)
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) {
        const oldEntry = this.memoryCache.get(oldestKey);
        if (oldEntry) {
          this.memoryCacheSize -= this.estimateSize(oldEntry);
        }
        this.memoryCache.delete(oldestKey);
      }
    }

    // Add new entry
    this.memoryCache.set(key, entry);
    this.memoryCacheSize += entrySize;
  }

  /**
   * Estimate the size of a cache entry in bytes.
   */
  private estimateSize(entry: CacheEntry<unknown>): number {
    // Rough estimate based on JSON stringification
    try {
      return JSON.stringify(entry).length * 2; // UTF-16 characters
    } catch {
      return 1024; // Fallback estimate
    }
  }

  /**
   * Convert a cache key to a safe filename.
   */
  private keyToFile(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 64);
    return `${safeKey}-${hash}.json`;
  }

  /**
   * Convert a filename back to a cache key (best effort).
   */
  private fileToKey(file: string): string {
    // Remove hash and extension
    const match = file.match(/^(.+)-[a-f0-9]{16}\.json$/);
    if (match) {
      return match[1].replace(/_/g, ' ');
    }
    return file;
  }

  /**
   * Read a cache entry from disk.
   */
  private async readFromDisk<T>(key: string): Promise<CacheEntry<T> | null> {
    const filePath = join(this.config.cacheDir, this.keyToFile(key));

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  /**
   * Write a cache entry to disk.
   */
  private async writeToDisk(key: string, entry: CacheEntry<unknown>): Promise<void> {
    const filePath = join(this.config.cacheDir, this.keyToFile(key));
    const content = JSON.stringify(entry);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Delete a cache entry from disk.
   */
  private async deleteFromDisk(key: string): Promise<void> {
    const filePath = join(this.config.cacheDir, this.keyToFile(key));
    await fs.unlink(filePath);
  }

  /**
   * Ensure the cache manager is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }
}
