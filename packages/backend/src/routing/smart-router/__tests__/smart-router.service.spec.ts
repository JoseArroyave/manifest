import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { SmartRouterService } from '../smart-router.service';
import { SmartRouterCache } from '../smart-router.cache';
import { SmartRouterCircuitBreaker } from '../smart-router.circuit-breaker';
import { Agent } from '../../../entities/agent.entity';
import { AgentMessage } from '../../../entities/agent-message.entity';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import {
  ProviderKeyService,
  SYNTHETIC_OLLAMA_PROVIDER_ID,
} from '../../routing-core/provider-key.service';
import { TierService } from '../../routing-core/tier.service';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { ProviderClient } from '../../proxy/provider-client';
import { RoutingCacheService } from '../../routing-core/routing-cache.service';

const AGENT = {
  id: 'agent-1',
  tenant_id: 'tenant-1',
  name: 'demo',
  smart_router_enabled: true,
  smart_router_provider: 'openai',
  smart_router_model: 'gpt-4o-mini',
  smart_router_auth_type: 'api_key',
  smart_router_key_label: null,
  smart_router_include_self: true,
} as unknown as Agent;

const CATALOG = [
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: 0.00000015,
    outputPricePerToken: 0.0000006,
    capabilityReasoning: false,
    capabilityCode: false,
    authType: 'api_key',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200000,
    inputPricePerToken: 0.000015,
    outputPricePerToken: 0.000075,
    capabilityReasoning: true,
    capabilityCode: true,
    authType: 'api_key',
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routerBody(modelId: string): unknown {
  return {
    choices: [{ message: { content: JSON.stringify({ model_id: modelId, reason: 'because' }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  };
}

describe('SmartRouterService', () => {
  let service: SmartRouterService;
  let agentRepo: { findOne: jest.Mock; update: jest.Mock };
  let messageRepo: { insert: jest.Mock; update: jest.Mock; findOne: jest.Mock };
  let discovery: { getModelsForAgent: jest.Mock };
  let providerKeys: { selectProviderKey: jest.Mock; hasRouteCredentials: jest.Mock };
  let tierService: { findTierForModel: jest.Mock };
  let pricingCache: { getByModel: jest.Mock };
  let providerClient: { forward: jest.Mock };
  let routingCache: { addInvalidationListener: jest.Mock; invalidateAgent: jest.Mock };

  const attemptContext = {
    agentName: 'demo',
    userId: null,
    requestId: 'req-1',
    startProviderAttempt: jest.fn(() => ({
      id: 'attempt-1',
      attemptNumber: 1,
      startedAtMs: 0,
      startedAt: '2026-10-19T00:00:00.000Z',
      pendingWrite: Promise.resolve(true),
    })),
  };

  const input = {
    agent: AGENT,
    tenantId: 'tenant-1',
    agentName: 'demo',
    userId: null,
    messages: [{ role: 'user', content: 'refactor this' }],
    tools: undefined,
    attempt: attemptContext,
  };

  beforeEach(async () => {
    agentRepo = {
      findOne: jest.fn().mockResolvedValue(AGENT),
      update: jest.fn().mockResolvedValue(undefined),
    };
    messageRepo = {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    };
    discovery = { getModelsForAgent: jest.fn().mockResolvedValue(CATALOG) };
    providerKeys = {
      selectProviderKey: jest.fn().mockResolvedValue({
        id: 'tp-1',
        label: 'Default',
        apiKey: 'sk-test',
        region: null,
      }),
      hasRouteCredentials: jest.fn().mockResolvedValue(true),
    };
    tierService = { findTierForModel: jest.fn().mockResolvedValue(null) };
    pricingCache = {
      getByModel: jest.fn().mockReturnValue({
        model_name: 'gpt-4o-mini',
        provider: 'openai',
        input_price_per_token: 0.1,
        output_price_per_token: 0.2,
        display_name: null,
      }),
    };
    providerClient = {
      forward: jest
        .fn()
        .mockResolvedValue({ response: jsonResponse(routerBody('claude-opus-4-6')) }),
    };
    routingCache = {
      addInvalidationListener: jest.fn(),
      invalidateAgent: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartRouterService,
        { provide: SmartRouterCache, useFactory: () => new SmartRouterCache() },
        { provide: SmartRouterCircuitBreaker, useFactory: () => new SmartRouterCircuitBreaker() },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentMessage), useValue: messageRepo },
        { provide: ModelDiscoveryService, useValue: discovery },
        { provide: ProviderKeyService, useValue: providerKeys },
        { provide: TierService, useValue: tierService },
        { provide: ModelPricingCacheService, useValue: pricingCache },
        { provide: ProviderClient, useValue: providerClient },
        { provide: RoutingCacheService, useValue: routingCache },
      ],
    }).compile();

    service = moduleRef.get(SmartRouterService);
  });

  it('returns null when the agent has the Smart Router off', async () => {
    const off = { ...input, agent: { ...AGENT, smart_router_enabled: false } };
    expect(await service.decide(off)).toBeNull();
    expect(providerClient.forward).not.toHaveBeenCalled();
  });

  it('returns null when no router model is configured', async () => {
    const unset = { ...input, agent: { ...AGENT, smart_router_model: null } };
    expect(await service.decide(unset)).toBeNull();
  });

  it('returns null when the catalog has fewer than two models', async () => {
    discovery.getModelsForAgent.mockResolvedValue([CATALOG[0]]);
    expect(await service.decide(input)).toBeNull();
  });

  it('returns null when there is no attempt context to record against', async () => {
    expect(await service.decide({ ...input, attempt: undefined })).toBeNull();
    expect(providerClient.forward).not.toHaveBeenCalled();
  });

  it('picks the model the router chose', async () => {
    const decision = await service.decide(input);
    expect(decision?.route).toEqual({
      provider: 'anthropic',
      authType: 'api_key',
      model: 'claude-opus-4-6',
    });
    expect(decision?.reason).toBe('because');
  });

  it('carries the chosen model tier and its fallbacks forward', async () => {
    tierService.findTierForModel.mockResolvedValue({
      tier: 'complex',
      fallback_routes: [{ provider: 'openai', authType: 'api_key', model: 'gpt-4o' }],
    });
    const decision = await service.decide(input);
    expect(decision?.tier).toBe('complex');
    expect(decision?.fallback_routes).toHaveLength(1);
  });

  it('falls back to the default tier when the model is in no tier', async () => {
    tierService.findTierForModel.mockResolvedValue(null);
    const decision = await service.decide(input);
    expect(decision?.tier).toBe('default');
    expect(decision?.fallback_routes).toBeNull();
  });

  it('records the router hop as its own attempt row', async () => {
    await service.decide(input);
    expect(attemptContext.startProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
    expect(messageRepo.update).toHaveBeenCalled();
    const row = messageRepo.update.mock.calls[0][1];
    expect(row.routing_reason).toBe('smart_router');
    expect(row.superseded).toBe(true);
    expect(row.router_decision_model).toBe('claude-opus-4-6');
    expect(row.router_decision_reason).toBe('because');
    expect(row.router_decision_latency_ms).toEqual(expect.any(Number));
  });

  it('keeps the parent request id on the hop', async () => {
    await service.decide(input);
    const row = messageRepo.update.mock.calls[0][1];
    expect(row.request_id).toBe('req-1');
  });

  it('serves a repeated identical request from the cache without calling the model again', async () => {
    await service.decide(input);
    await service.decide(input);
    expect(providerClient.forward).toHaveBeenCalledTimes(1);
    expect(messageRepo.update).toHaveBeenCalledTimes(1);
  });

  it('falls back to scoring when the router times out', async () => {
    providerClient.forward.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    expect(await service.decide(input)).toBeNull();
    const row = messageRepo.update.mock.calls[0][1];
    expect(row.error_class).toBe('router_timeout');
  });

  it('falls back to scoring when the router returns an HTTP error', async () => {
    providerClient.forward.mockResolvedValue({ response: jsonResponse({ error: 'boom' }, 500) });
    expect(await service.decide(input)).toBeNull();
    expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_failure');
  });

  it('retries once with a stricter prompt and then falls back', async () => {
    // A fresh Response per call: a Response's body can only be read once, so
    // reusing the same instance would make the retry look like a failure.
    providerClient.forward.mockImplementation(async () => ({
      response: jsonResponse({ choices: [{ message: { content: 'I pick gpt-4o-mini' } }] }),
    }));
    expect(await service.decide(input)).toBeNull();
    expect(providerClient.forward).toHaveBeenCalledTimes(2);
    expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_invalid_response');
  });

  it('falls back when the router picks a model that is not in the catalog', async () => {
    providerClient.forward.mockResolvedValue({ response: jsonResponse(routerBody('gpt-9000')) });
    expect(await service.decide(input)).toBeNull();
    expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_unknown_model');
  });

  it('falls back when the router model has no credentials', async () => {
    providerKeys.selectProviderKey.mockResolvedValue(null);
    expect(await service.decide(input)).toBeNull();
    expect(providerClient.forward).not.toHaveBeenCalled();
    expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_no_credentials');
  });

  it('falls back when the chosen model has no credentials', async () => {
    providerKeys.hasRouteCredentials.mockResolvedValue(false);
    expect(await service.decide(input)).toBeNull();
    expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_no_credentials');
  });

  it('opens the circuit breaker after three consecutive failures', async () => {
    providerClient.forward.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    await service.decide(input);
    await service.decide(input);
    await service.decide(input);
    const callsAfterThree = providerClient.forward.mock.calls.length;
    await service.decide(input);
    expect(providerClient.forward.mock.calls.length).toBe(callsAfterThree);
  });

  describe('configuration', () => {
    it('reports the current configuration', async () => {
      const view = await service.getConfig('agent-1', 'tenant-1');
      expect(view.enabled).toBe(true);
      expect(view.model).toEqual({
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-4o-mini',
        keyLabel: undefined,
      });
      expect(view.include_router_in_candidates).toBe(true);
      expect(view.has_catalog).toBe(true);
    });

    it('reports no router model when none is configured', async () => {
      agentRepo.findOne.mockResolvedValue({ ...AGENT, smart_router_model: null });
      const view = await service.getConfig('agent-1', 'tenant-1');
      expect(view.model).toBeNull();
    });

    it('persists an update and busts the routing cache', async () => {
      await service.updateConfig('agent-1', 'tenant-1', {
        enabled: false,
        include_router_in_candidates: false,
        model: null,
      });
      expect(agentRepo.update).toHaveBeenCalledWith(
        { id: 'agent-1' },
        expect.objectContaining({
          smart_router_enabled: false,
          smart_router_include_self: false,
          smart_router_model: null,
          smart_router_provider: null,
        }),
      );
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('stores a newly chosen router model', async () => {
      await service.updateConfig('agent-1', 'tenant-1', {
        model: { provider: 'anthropic', authType: 'api_key', model: 'claude-haiku-4-5' },
      });
      expect(agentRepo.update).toHaveBeenCalledWith(
        { id: 'agent-1' },
        expect.objectContaining({
          smart_router_provider: 'anthropic',
          smart_router_model: 'claude-haiku-4-5',
          smart_router_auth_type: 'api_key',
        }),
      );
    });

    it('leaves the router model alone when the patch omits it', async () => {
      await service.updateConfig('agent-1', 'tenant-1', { enabled: true });
      const [, patch] = agentRepo.update.mock.calls[0];
      expect(patch).not.toHaveProperty('smart_router_model');
    });

    it('throws when the harness does not exist', async () => {
      agentRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateConfig('agent-1', 'tenant-1', { enabled: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports when the router last ran', async () => {
      messageRepo.findOne.mockResolvedValue({ timestamp: '2026-10-19T00:00:00.000Z' });
      expect(await service.lastDecisionAt('agent-1')).toBe('2026-10-19T00:00:00.000Z');
    });

    it('reports no decision when the router never ran', async () => {
      messageRepo.findOne.mockResolvedValue(null);
      expect(await service.lastDecisionAt('agent-1')).toBeNull();
    });
  });

  describe('failure handling', () => {
    it('falls back to scoring when the catalog read throws', async () => {
      discovery.getModelsForAgent.mockRejectedValue(new Error('catalog exploded'));
      // A database error must not fail the caller's request.
      expect(await service.decide(input)).toBeNull();
    });

    it('falls back to scoring when the credential lookup throws', async () => {
      providerKeys.selectProviderKey.mockRejectedValue(new Error('keys exploded'));
      expect(await service.decide(input)).toBeNull();
    });

    it('never lets a failed row write break the request', async () => {
      messageRepo.update.mockRejectedValue(new Error('write failed'));
      messageRepo.insert.mockRejectedValue(new Error('write failed'));
      // The decision still comes back — the caller must not see the write
      // failure.
      expect(await service.decide(input)).not.toBeNull();
    });

    it('inserts the row when the pending write never landed', async () => {
      attemptContext.startProviderAttempt.mockReturnValueOnce({
        id: 'attempt-2',
        attemptNumber: 1,
        startedAtMs: 0,
        startedAt: '2026-10-19T00:00:00.000Z',
        pendingWrite: Promise.resolve(false),
      } as never);
      await service.decide(input);
      expect(messageRepo.insert).toHaveBeenCalled();
      expect(messageRepo.update).not.toHaveBeenCalled();
    });

    it('records a transport failure that is not a timeout', async () => {
      providerClient.forward.mockRejectedValue(new Error('fetch failed'));
      expect(await service.decide(input)).toBeNull();
      expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_failure');
    });

    it('records a non-Error rejection', async () => {
      providerClient.forward.mockRejectedValue('a string, not an Error');
      expect(await service.decide(input)).toBeNull();
      expect(messageRepo.update.mock.calls[0][1].error_class).toBe('router_failure');
    });
  });

  describe('synthetic Ollama provider id', () => {
    // When the router model is Ollama (local), selectProviderKey returns a
    // synthetic key whose id is the literal 'ollama', which is not a real
    // tenant_providers row. Stamping it on agent_messages.tenant_provider_id
    // used to violate the FK and tear down the whole decision. It must be
    // normalized to NULL instead — the same treatment the proxy path gives it.
    const OLLAMA_AGENT = {
      ...AGENT,
      smart_router_provider: 'ollama',
      smart_router_model: 'gpt-oss:20b-cloud',
      smart_router_auth_type: 'local',
    } as unknown as Agent;

    const OLLAMA_CATALOG = [
      { ...CATALOG[0], id: 'gpt-oss:20b-cloud', provider: 'ollama', authType: 'local' },
      { ...CATALOG[1] },
    ];

    beforeEach(() => {
      discovery.getModelsForAgent.mockResolvedValue(OLLAMA_CATALOG);
      providerKeys.selectProviderKey.mockResolvedValue({
        id: SYNTHETIC_OLLAMA_PROVIDER_ID,
        label: 'Default',
        apiKey: 'sk-test',
        region: null,
      });
    });

    it('records the router hop with a NULL tenant_provider_id, not the synthetic id', async () => {
      const decision = await service.decide({ ...input, agent: OLLAMA_AGENT });
      // The decision must come through — the FK violation no longer tears it down.
      expect(decision).not.toBeNull();
      const row = messageRepo.update.mock.calls[0][1];
      expect(row.tenant_provider_id).toBeNull();
      expect(row.routing_reason).toBe('smart_router');
    });

    it('starts the provider attempt with a NULL tenant provider id', async () => {
      await service.decide({ ...input, agent: OLLAMA_AGENT });
      expect(attemptContext.startProviderAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'ollama', tenantProviderId: null }),
      );
    });

    it('stamps NULL on the no-credentials failure row too', async () => {
      providerKeys.selectProviderKey.mockResolvedValue({
        id: SYNTHETIC_OLLAMA_PROVIDER_ID,
        label: 'Default',
        apiKey: '',
        region: null,
      });
      expect(await service.decide({ ...input, agent: OLLAMA_AGENT })).toBeNull();
      const row = messageRepo.update.mock.calls[0][1];
      expect(row.error_class).toBe('router_no_credentials');
      expect(row.tenant_provider_id).toBeNull();
    });
  });

  describe('JSON mode', () => {
    it('asks for JSON when the router provider supports it', async () => {
      await service.decide(input);
      expect(providerClient.forward.mock.calls[0][0].body.response_format).toEqual({
        type: 'json_object',
      });
    });

    it('omits the JSON mode for a provider that does not support it', async () => {
      await service.decide({
        ...input,
        agent: { ...AGENT, smart_router_provider: 'anthropic' },
      });
      expect(providerClient.forward.mock.calls[0][0].body.response_format).toBeUndefined();
    });

    it('omits the JSON mode for a provider that is not in the registry', async () => {
      await service.decide({
        ...input,
        agent: { ...AGENT, smart_router_provider: 'not-a-real-provider' },
      });
      expect(providerClient.forward.mock.calls[0][0].body.response_format).toBeUndefined();
    });
  });
});
