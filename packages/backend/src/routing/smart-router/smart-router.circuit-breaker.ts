import { SMART_ROUTER_CONFIG } from './smart-router.config';

/**
 * A per-process circuit breaker for the router hop.
 *
 * Three consecutive failures open it for the cooldown window; during that
 * window the Smart Router short-circuits straight to scoring-based routing
 * without touching the provider. A single success closes it again.
 *
 * Per-process on purpose: the breaker protects this replica's latency, not a
 * fleet-wide quota, so no coordination is needed.
 */
export class SmartRouterCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number = SMART_ROUTER_CONFIG.circuitBreakerThreshold,
    private readonly cooldownMs: number = SMART_ROUTER_CONFIG.circuitBreakerCooldownMs,
    private readonly enabled: boolean = SMART_ROUTER_CONFIG.circuitBreakerEnabled,
  ) {}

  isOpen(now = Date.now()): boolean {
    if (!this.enabled) return false;
    if (this.openedAt === 0) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      this.openedAt = 0;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  recordFailure(now = Date.now()): void {
    if (!this.enabled) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = now;
    }
  }
}
