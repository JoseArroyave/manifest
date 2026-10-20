import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { ResolveAgentService } from '../routing-core/resolve-agent.service';
import { AgentNameParamDto } from '../dto/routing.dto';
import { UpdateSmartRouterDto } from './dto/smart-router.dto';
import { SmartRouterService } from './smart-router.service';

@Controller('api/v1/routing')
export class SmartRouterController {
  constructor(
    private readonly smartRouterService: SmartRouterService,
    private readonly resolveAgentService: ResolveAgentService,
  ) {}

  @Get(':agentName/smart-router')
  async getConfig(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.smartRouterService.getConfig(agent.id, agent.tenant_id);
  }

  @Patch(':agentName/smart-router')
  async updateConfig(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentNameParamDto,
    @Body() body: UpdateSmartRouterDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.smartRouterService.updateConfig(agent.id, agent.tenant_id, {
      enabled: body.enabled,
      // Passed through unchanged: `undefined` means "leave it alone" and
      // `null` means "clear the router model". Coalescing null to undefined
      // here would make it impossible to clear the model.
      model: body.model,
      include_router_in_candidates: body.include_router_in_candidates,
    });
  }
}
