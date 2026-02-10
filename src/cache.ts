import * as crypto from 'crypto';
import { AnalysisResult, CacheEntry } from './types';

/**
 * Content-hash based cache for analysis results.
 * Supports cross-session persistence and TTL-based expiry.
 */
export class AnalysisCache {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTTL: number = 3600000; // 1 hour in ms
  private maxEntries: number = 100;

  constructor(ttlMs?: number, maxEntries?: number) {
    if (ttlMs) {
      this.defaultTTL = ttlMs;
    }
    if (maxEntries) {
      this.maxEntries = maxEntries;
    }
  }

  /**
   * Compute content hash for cache key
   */
  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get cached results if they exist and haven't expired
   */
  get(hash: string): AnalysisResult[] | null {
    const entry = this.cache.get(hash);
    
    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(hash);
      return null;
    }

    return entry.results;
  }

  /**
   * Store results in cache
   */
  set(hash: string, results: AnalysisResult[], ttl?: number): void {
    // Auto-prune expired entries and enforce max size
    this.prune();
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
      else break;
    }

    this.cache.set(hash, {
      hash,
      results,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    });
  }

  /**
   * Clear specific entry
   */
  delete(hash: string): void {
    this.cache.delete(hash);
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; size: number } {
    let size = 0;
    for (const entry of this.cache.values()) {
      size += JSON.stringify(entry).length;
    }
    return {
      entries: this.cache.size,
      size,
    };
  }

  /**
   * Remove expired entries
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [hash, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(hash);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Export cache for persistence
   */
  export(): string {
    const entries: CacheEntry[] = [];
    for (const entry of this.cache.values()) {
      entries.push(entry);
    }
    return JSON.stringify(entries);
  }

  /**
   * Import cache from persistence
   */
  import(data: string): void {
    try {
      const entries: CacheEntry[] = JSON.parse(data);
      for (const entry of entries) {
        // Only import if not expired
        if (Date.now() - entry.timestamp <= entry.ttl) {
          this.cache.set(entry.hash, entry);
        }
      }
    } catch (e) {
      // Invalid data, ignore
    }
  }
}
