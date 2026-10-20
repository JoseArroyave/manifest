import { readSmartRouterConfig } from '../smart-router.config';

describe('readSmartRouterConfig', () => {
  const KEYS = [
    'SMART_ROUTER_GLOBAL_ENABLED',
    'SMART_ROUTER_TIMEOUT_MS',
    'SMART_ROUTER_MAX_TOKENS',
    'SMART_ROUTER_CACHE_TTL_MS',
    'SMART_ROUTER_CACHE_MAX_ENTRIES',
    'SMART_ROUTER_CIRCUIT_BREAKER_ENABLED',
    'SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD',
    'SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS',
  ];

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('defaults to the documented values', () => {
    const config = readSmartRouterConfig();
    expect(config.globalEnabled).toBe(true);
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxTokens).toBe(200);
    expect(config.cacheTtlMs).toBe(30000);
    expect(config.cacheMaxEntries).toBe(1000);
    expect(config.circuitBreakerEnabled).toBe(true);
    expect(config.circuitBreakerThreshold).toBe(3);
    expect(config.circuitBreakerCooldownMs).toBe(30000);
  });

  it('reads every override from the environment', () => {
    process.env.SMART_ROUTER_GLOBAL_ENABLED = 'false';
    process.env.SMART_ROUTER_TIMEOUT_MS = '1500';
    process.env.SMART_ROUTER_MAX_TOKENS = '64';
    process.env.SMART_ROUTER_CACHE_TTL_MS = '9000';
    process.env.SMART_ROUTER_CACHE_MAX_ENTRIES = '10';
    process.env.SMART_ROUTER_CIRCUIT_BREAKER_ENABLED = 'false';
    process.env.SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD = '5';
    process.env.SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS = '1000';
    const config = readSmartRouterConfig();
    expect(config.globalEnabled).toBe(false);
    expect(config.timeoutMs).toBe(1500);
    expect(config.maxTokens).toBe(64);
    expect(config.cacheTtlMs).toBe(9000);
    expect(config.cacheMaxEntries).toBe(10);
    expect(config.circuitBreakerEnabled).toBe(false);
    expect(config.circuitBreakerThreshold).toBe(5);
    expect(config.circuitBreakerCooldownMs).toBe(1000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.SMART_ROUTER_TIMEOUT_MS = 'not-a-number';
    const config = readSmartRouterConfig();
    expect(config.timeoutMs).toBe(5000);
  });

  it('falls back to the default for a non-positive value', () => {
    process.env.SMART_ROUTER_MAX_TOKENS = '0';
    expect(readSmartRouterConfig().maxTokens).toBe(200);
    process.env.SMART_ROUTER_MAX_TOKENS = '-4';
    expect(readSmartRouterConfig().maxTokens).toBe(200);
  });

  it('treats an empty boolean as the default', () => {
    process.env.SMART_ROUTER_GLOBAL_ENABLED = '  ';
    expect(readSmartRouterConfig().globalEnabled).toBe(true);
  });
});
