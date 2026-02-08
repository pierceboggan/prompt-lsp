import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnalysisCache } from '../cache';

describe('AnalysisCache', () => {
  let cache: AnalysisCache;

  beforeEach(() => {
    cache = new AnalysisCache();
  });

  describe('computeHash', () => {
    it('should return consistent hash for same content', () => {
      const hash1 = cache.computeHash('hello world');
      const hash2 = cache.computeHash('hello world');
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different content', () => {
      const hash1 = cache.computeHash('hello world');
      const hash2 = cache.computeHash('hello world!');
      expect(hash1).not.toBe(hash2);
    });

    it('should return a hex string', () => {
      const hash = cache.computeHash('test');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('get/set', () => {
    it('should return null for missing entries', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should store and retrieve results', () => {
      const results = [
        {
          code: 'test',
          message: 'test message',
          severity: 'warning' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results);
      expect(cache.get('hash1')).toEqual(results);
    });

    it('should return null for expired entries', () => {
      vi.useFakeTimers();
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results, 50);

      vi.advanceTimersByTime(100);
      expect(cache.get('hash1')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('delete', () => {
    it('should remove a specific entry', () => {
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results);
      cache.delete('hash1');
      expect(cache.get('hash1')).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results);
      cache.set('hash2', results);
      cache.clear();
      expect(cache.get('hash1')).toBeNull();
      expect(cache.get('hash2')).toBeNull();
    });
  });

  describe('getStats', () => {
    it('should report correct entry count', () => {
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results);
      cache.set('hash2', results);
      const stats = cache.getStats();
      expect(stats.entries).toBe(2);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should report zero for empty cache', () => {
      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);
    });
  });

  describe('prune', () => {
    it('should remove expired entries', () => {
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];

      vi.useFakeTimers();
      cache.set('expired', results, 100); // 100ms TTL
      cache.set('fresh', results, 999999); // Long TTL

      vi.advanceTimersByTime(200);
      const pruned = cache.prune();

      expect(pruned).toBe(1);
      expect(cache.get('expired')).toBeNull();
      expect(cache.get('fresh')).not.toBeNull();
      vi.useRealTimers();
    });
  });

  describe('export/import', () => {
    it('should export and re-import cache data', () => {
      const results = [
        {
          code: 'test',
          message: 'test message',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];
      cache.set('hash1', results);

      const exported = cache.export();
      const newCache = new AnalysisCache();
      newCache.import(exported);

      expect(newCache.get('hash1')).toEqual(results);
    });

    it('should handle invalid import data gracefully', () => {
      expect(() => cache.import('invalid json')).not.toThrow();
    });

    it('should skip expired entries on import', () => {
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];

      vi.useFakeTimers();
      cache.set('will-expire', results, 100);
      const exported = cache.export();

      vi.advanceTimersByTime(200);
      const newCache = new AnalysisCache();
      newCache.import(exported);

      expect(newCache.get('will-expire')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('constructor', () => {
    it('should accept custom TTL', () => {
      const customCache = new AnalysisCache(5000);
      const results = [
        {
          code: 'test',
          message: 'test',
          severity: 'info' as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          analyzer: 'test',
        },
      ];

      vi.useFakeTimers();
      customCache.set('hash1', results); // Uses default TTL of 5000ms
      vi.advanceTimersByTime(4000);
      expect(customCache.get('hash1')).not.toBeNull();
      vi.advanceTimersByTime(2000);
      expect(customCache.get('hash1')).toBeNull();
      vi.useRealTimers();
    });
  });
});
