import { SmartRouterCache, buildSmartRouterCacheKey } from '../smart-router.cache';
import type { ModelRoute } from 'manifest-shared';

const ROUTE: ModelRoute = { provider: 'openai', authType: 'api_key', model: 'gpt-4o' };
const SEP = '\u0000';

describe('SmartRouterCache', () => {
  it('returns null for an unknown key', () => {
    const cache = new SmartRouterCache(1000, 10);
    expect(cache.get(`agent-1${SEP}abc`)).toBeNull();
  });

  it('returns a stored decision', () => {
    const cache = new SmartRouterCache(1000, 10);
    cache.set(`agent-1${SEP}abc`, {
      route: ROUTE,
      reason: 'needs reasoning',
      tier: 'default',
      fallback_routes: null,
    });
    expect(cache.get(`agent-1${SEP}abc`)?.route).toEqual(ROUTE);
  });

  it('expires an entry once the TTL has passed', () => {
    jest.useFakeTimers();
    try {
      const cache = new SmartRouterCache(1000, 10);
      cache.set(`agent-1${SEP}abc`, {
        route: ROUTE,
        reason: 'r',
        tier: 'default',
        fallback_routes: null,
      });
      jest.advanceTimersByTime(1001);
      expect(cache.get(`agent-1${SEP}abc`)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the oldest entry when the capacity is reached', () => {
    const cache = new SmartRouterCache(60_000, 2);
    cache.set(`agent-1${SEP}a`, {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set(`agent-1${SEP}b`, {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set(`agent-1${SEP}c`, {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    expect(cache.get(`agent-1${SEP}a`)).toBeNull();
    expect(cache.get(`agent-1${SEP}c`)).not.toBeNull();
  });

  it('invalidates only the entries of one agent', () => {
    const cache = new SmartRouterCache(60_000, 10);
    cache.set(`agent-1${SEP}a`, {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set(`agent-2${SEP}b`, {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.invalidateAgent('agent-1');
    expect(cache.get(`agent-1${SEP}a`)).toBeNull();
    expect(cache.get(`agent-2${SEP}b`)).not.toBeNull();
  });
});

describe('buildSmartRouterCacheKey', () => {
  it('is stable for the same inputs', () => {
    const a = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    const b = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    expect(a).toBe(b);
  });

  it('differs when any input differs', () => {
    const base = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    expect(buildSmartRouterCacheKey('agent-2', 'hello', 0, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'bye', 0, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 1, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 0, 13)).not.toBe(base);
  });

  it('prefixes the key with the agent id so one agent can be invalidated', () => {
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 0, 12).startsWith(`agent-1${SEP}`)).toBe(
      true,
    );
  });
});
