/**
 * Smart Router tuning, read from the environment.
 *
 * Every default preserves today's behaviour: the global switch is on (so an
 * operator can enable the layer per agent without a redeploy), but the layer
 * itself is inert until an agent opts in.
 */

export interface SmartRouterConfig {
  globalEnabled: boolean;
  timeoutMs: number;
  maxTokens: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  circuitBreakerEnabled: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() !== 'false';
}

export function readSmartRouterConfig(): SmartRouterConfig {
  return {
    globalEnabled: readBoolean('SMART_ROUTER_GLOBAL_ENABLED', true),
    timeoutMs: readPositiveInt('SMART_ROUTER_TIMEOUT_MS', 5000),
    maxTokens: readPositiveInt('SMART_ROUTER_MAX_TOKENS', 200),
    cacheTtlMs: readPositiveInt('SMART_ROUTER_CACHE_TTL_MS', 30_000),
    cacheMaxEntries: readPositiveInt('SMART_ROUTER_CACHE_MAX_ENTRIES', 1000),
    circuitBreakerEnabled: readBoolean('SMART_ROUTER_CIRCUIT_BREAKER_ENABLED', true),
    circuitBreakerThreshold: readPositiveInt('SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD', 3),
    circuitBreakerCooldownMs: readPositiveInt('SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS', 30_000),
  };
}

/** The process-wide configuration, captured at import time. */
export const SMART_ROUTER_CONFIG: SmartRouterConfig = readSmartRouterConfig();
