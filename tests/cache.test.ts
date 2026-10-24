import { describe, it, expect } from '@jest/globals';
import { cacheKeys, cacheUtils, patternCache } from '../src/cache.js';

describe('cacheKeys', () => {
    const prefix = 'Decision: migrate authentication to the new identity provider and ';
    const a = `${prefix}keep the legacy tokens valid for ten days`;
    const b = `${prefix}keep the legacy tokens valid for two days`;

    it('embedding keys differ for equal-length texts that share their first 50 characters', () => {
        expect(a.length).toBe(b.length);
        expect(a.slice(0, 50)).toBe(b.slice(0, 50));
        expect(cacheKeys.embedding(a)).not.toBe(cacheKeys.embedding(b));
    });

    it('embedding keys are stable for identical text', () => {
        expect(cacheKeys.embedding(a)).toBe(cacheKeys.embedding(`${a}`));
    });

    it('query keys differ for queries that share their first 50 characters', () => {
        expect(cacheKeys.query('p', a, undefined, 5)).not.toBe(cacheKeys.query('p', b, undefined, 5));
    });

    it('system pattern keys differ per limit', () => {
        expect(cacheKeys.systemPatterns('p', 5)).not.toBe(cacheKeys.systemPatterns('p', 20));
    });
});

describe('invalidateProjectCache', () => {
    it('clears every cached pattern list of the project and keeps other projects', () => {
        cacheUtils.setCached(patternCache, cacheKeys.systemPatterns('proj-a', 5), [{ id: 1 }]);
        cacheUtils.setCached(patternCache, cacheKeys.systemPatterns('proj-a', 20), [{ id: 1 }, { id: 2 }]);
        cacheUtils.setCached(patternCache, cacheKeys.systemPatterns('proj-b', 5), [{ id: 3 }]);

        cacheUtils.invalidateProjectCache('proj-a');

        expect(cacheUtils.getCached(patternCache, cacheKeys.systemPatterns('proj-a', 5))).toBeNull();
        expect(cacheUtils.getCached(patternCache, cacheKeys.systemPatterns('proj-a', 20))).toBeNull();
        expect(cacheUtils.getCached(patternCache, cacheKeys.systemPatterns('proj-b', 5))).not.toBeNull();
    });
});
