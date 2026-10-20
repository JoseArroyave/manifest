import { Test } from '@nestjs/testing';
import { SmartRouterController } from '../smart-router.controller';
import { SmartRouterService } from '../smart-router.service';
import { ResolveAgentService } from '../../routing-core/resolve-agent.service';
import type { TenantContext } from '../../../common/decorators/tenant-context.decorator';

describe('SmartRouterController', () => {
  let controller: SmartRouterController;
  let service: { getConfig: jest.Mock; updateConfig: jest.Mock };
  let resolveAgent: { resolve: jest.Mock };

  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as TenantContext;
  const params = { agentName: 'demo' };

  beforeEach(async () => {
    service = {
      getConfig: jest.fn().mockResolvedValue({
        enabled: false,
        model: null,
        include_router_in_candidates: true,
        has_catalog: true,
        last_decision_at: null,
      }),
      updateConfig: jest.fn().mockResolvedValue({
        enabled: true,
        model: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
        include_router_in_candidates: true,
        has_catalog: true,
        last_decision_at: null,
      }),
    };
    resolveAgent = {
      resolve: jest.fn().mockResolvedValue({ id: 'agent-1', tenant_id: 'tenant-1' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [SmartRouterController],
      providers: [
        { provide: SmartRouterService, useValue: service },
        { provide: ResolveAgentService, useValue: resolveAgent },
      ],
    }).compile();

    controller = moduleRef.get(SmartRouterController);
  });

  it('returns the current configuration', async () => {
    const view = await controller.getConfig(ctx, params);
    expect(view.enabled).toBe(false);
    expect(resolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'demo');
    expect(service.getConfig).toHaveBeenCalledWith('agent-1', 'tenant-1');
  });

  it('applies a configuration change', async () => {
    const view = await controller.updateConfig(ctx, params, {
      enabled: true,
      model: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
    });
    expect(view.enabled).toBe(true);
    expect(service.updateConfig).toHaveBeenCalledWith('agent-1', 'tenant-1', {
      enabled: true,
      model: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
    });
  });

  it('passes a null model through so the router can be cleared', async () => {
    await controller.updateConfig(ctx, params, { model: null });
    expect(service.updateConfig).toHaveBeenCalledWith('agent-1', 'tenant-1', {
      enabled: undefined,
      model: null,
      include_router_in_candidates: undefined,
    });
  });
});
