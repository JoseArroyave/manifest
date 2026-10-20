import { SmartRouterCircuitBreaker } from '../smart-router.circuit-breaker';

describe('SmartRouterCircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const breaker = new SmartRouterCircuitBreaker(3, 30_000, true);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000)).toBe(false);
  });

  it('opens after the threshold is reached', () => {
    const breaker = new SmartRouterCircuitBreaker(3, 30_000, true);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000)).toBe(true);
  });

  it('closes again once the cooldown has passed', () => {
    const breaker = new SmartRouterCircuitBreaker(3, 30_000, true);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000 + 30_001)).toBe(false);
  });

  it('closes on a success and resets the streak', () => {
    const breaker = new SmartRouterCircuitBreaker(3, 30_000, true);
    breaker.recordFailure(1000);
    breaker.recordFailure(1000);
    breaker.recordSuccess();
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000)).toBe(false);
  });

  it('never opens when disabled', () => {
    const breaker = new SmartRouterCircuitBreaker(1, 30_000, false);
    breaker.recordFailure(1000);
    expect(breaker.isOpen(1000)).toBe(false);
  });
});
