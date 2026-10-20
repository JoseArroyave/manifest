import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ModelDiscoveryModule } from '../../model-discovery/model-discovery.module';
import { ModelPricesModule } from '../../model-prices/model-prices.module';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { ProviderClient } from '../proxy/provider-client';
import { SmartRouterCache } from './smart-router.cache';
import { SmartRouterCircuitBreaker } from './smart-router.circuit-breaker';
import { SmartRouterController } from './smart-router.controller';
import { SmartRouterService } from './smart-router.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Agent, AgentMessage]),
    RoutingCoreModule,
    ModelDiscoveryModule,
    ModelPricesModule,
  ],
  controllers: [SmartRouterController],
  providers: [
    SmartRouterService,
    // useFactory, not the class itself: their constructors take primitive
    // parameters, which Nest cannot resolve as dependencies.
    { provide: SmartRouterCache, useFactory: () => new SmartRouterCache() },
    {
      provide: SmartRouterCircuitBreaker,
      useFactory: () => new SmartRouterCircuitBreaker(),
    },
    // A dedicated ProviderClient instance: ProxyModule cannot be imported here
    // (it imports ResolveModule, which imports this module). Every dependency of
    // ProviderClient is @Optional, so a local instance behaves identically for
    // the router's tiny non-streaming call.
    ProviderClient,
  ],
  exports: [SmartRouterService],
})
export class SmartRouterModule {}
