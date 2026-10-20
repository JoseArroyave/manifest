import { createHash } from 'crypto';
import type { ModelRoute, TierSlot } from 'manifest-shared';
import { SMART_ROUTER_CONFIG } from './smart-router.config';

export interface SmartRouterCacheEntry {
  route: ModelRoute;
  reason: string;
  tier: TierSlot;
  fallback_routes: ModelRoute[] | null;
}

interface StoredEntry {
  value: SmartRouterCacheEntry;
  expiresAt: number;
}

/**
 * The cache key is `<agentId> NUL <hash>` so `invalidateAgent()` can drop one
 * agent's decisions by prefix without scanning the whole map. The hash covers
 * only the request's shape — the last user message, the tool count and the
 * token estimate — so two different requests never share a decision.
 */
export function buildSmartRouterCacheKey(
  agentId: string,
  lastUserText: string,
  toolCount: number,
  tokenEstimate: number,
): string {
  const hash = createHash('sha256')
    .update(`${lastUserText}\u0000${toolCount}\u0000${tokenEstimate}`)
    .digest('hex');
  return `${agentId}\u0000${hash}`;
}

/**
 * In-memory TTL + LRU cache of routing decisions.
 *
 * The cache holds the *decision*, not the recording: a hit returns the route
 * immediately, with no LLM call and no `agent_messages` row. A burst of 100
 * identical requests therefore produces one router row, not 100.
 */
export class SmartRouterCache {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly ttlMs: number = SMART_ROUTER_CONFIG.cacheTtlMs,
    private readonly maxEntries: number = SMART_ROUTER_CONFIG.cacheMaxEntries,
  ) {}

  get(key: string): SmartRouterCacheEntry | null {
    const stored = this.entries.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return stored.value;
  }

  set(key: string, value: SmartRouterCacheEntry): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop every decision belonging to one agent. */
  invalidateAgent(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
