import { createHash } from 'crypto';
import config from './config.js';
import type { CacheItem } from './types.js';

const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Simple LRU Cache implementation for performance optimization
 */
class LRUCache<T = any> {
    private maxSize: number;
    private cache: Map<string, CacheItem<T>>;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key: string): T | null {
        if (!this.cache.has(key)) return null;

        // Move to end (most recently used)
        const item = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key: string, value: T, ttl: number = config.CACHE_TTL_SECONDS * 1000): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Remove least recently used
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }

        this.cache.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }

    has(key: string): boolean {
        if (!this.cache.has(key)) return false;

        const item = this.cache.get(key)!;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    clear(): void {
        this.cache.clear();
    }

    size(): number {
        // Clean expired entries
        for (const [key, item] of this.cache.entries()) {
            if (Date.now() > item.expiry) {
                this.cache.delete(key);
            }
        }
        return this.cache.size;
    }

    getMaxSize(): number {
        return this.maxSize;
    }

    // Expose cache for iteration (needed for invalidation)
    getCache(): Map<string, CacheItem<T>> {
        return this.cache;
    }
}

// Global cache instances
export const embeddingCache = new LRUCache<number[]>(config.EMBEDDING_CACHE_SIZE);
export const queryCache = new LRUCache<any>(config.QUERY_CACHE_SIZE);
export const contextCache = new LRUCache<any>(100); // For structured contexts
export const patternCache = new LRUCache<any>(50); // For system patterns

/**
 * Cache key generators for consistent caching
 */
export const cacheKeys = {
    embedding: (text: string): string => `embed:${hashText(text)}`,
    query: (projectName: string, queryText: string, memoryType: string | undefined, topK: number): string =>
        `query:${projectName}:${hashText(queryText)}:${memoryType || 'all'}:${topK}`,
    structuredContext: (projectName: string, contextType: string): string =>
        `context:${projectName}:${contextType}`,
    systemPatterns: (projectName: string, limit: number): string =>
        `patterns:${projectName}:${limit}`,
    decisions: (projectName: string, limit: number): string =>
        `decisions:${projectName}:${limit}`
};

/**
 * Cache utilities
 */
export const cacheUtils = {
    /**
     * Get cached value with TTL check
     */
    getCached: <T>(cache: LRUCache<T>, key: string): T | null => {
        if (!cache.has(key)) return null;
        return cache.get(key);
    },

    /**
     * Set cached value with TTL
     */
    setCached: <T>(cache: LRUCache<T>, key: string, value: T, ttl?: number): void => {
        cache.set(key, value, ttl);
    },

    /**
     * Invalidate cache patterns
     */
    invalidateProjectCache: (projectName: string): void => {
        // Clear all caches related to this project
        const caches = [queryCache, contextCache, patternCache];

        caches.forEach(cache => {
            for (const key of cache.getCache().keys()) {
                if (key.includes(`:${projectName}:`)) {
                    cache.getCache().delete(key);
                }
            }
        });
    },

    /**
     * Get cache statistics
     */
    getStats: () => ({
        embeddingCache: {
            size: embeddingCache.size(),
            maxSize: embeddingCache.getMaxSize()
        },
        queryCache: {
            size: queryCache.size(),
            maxSize: queryCache.getMaxSize()
        },
        contextCache: {
            size: contextCache.size(),
            maxSize: contextCache.getMaxSize()
        },
        patternCache: {
            size: patternCache.size(),
            maxSize: patternCache.getMaxSize()
        }
    })
};

export default {
    LRUCache,
    embeddingCache,
    queryCache,
    contextCache,
    patternCache,
    cacheKeys,
    cacheUtils
};
