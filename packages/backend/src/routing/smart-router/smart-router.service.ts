import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType, ModelRoute, TierSlot } from 'manifest-shared';
import { DEFAULT_OUTPUT_MODALITY, DEFAULT_RESPONSE_MODE } from 'manifest-shared';
import { Agent } from '../../entities/agent.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import {
  ProviderKeyService,
  SYNTHETIC_OLLAMA_PROVIDER_ID,
} from '../routing-core/provider-key.service';
import { RoutingCacheService } from '../routing-core/routing-cache.service';
import type { CachedProviderKey } from '../routing-core/routing-cache.service';
import { TierService } from '../routing-core/tier.service';
import { ProviderClient } from '../proxy/provider-client';
import type { ProviderAttemptRef } from '../proxy/proxy-types';
import { PROVIDER_ENDPOINTS, resolveEndpointKey } from '../proxy/provider-endpoints';
import {
  describeTransportError,
  getErrorName,
  isTimeoutError,
  isTransportError,
} from '../proxy/proxy-transport';
import { OPENAI_RESPONSES_ONLY_RE, stripVendorPrefix } from '../../common/constants/openai-models';
import { computeTokenCost } from '../../common/utils/cost-calculator';
import { isLocalOnlyProvider } from '../../common/utils/provider-availability';
import { resolveModelRoute } from '../routing-core/resolve-model-route';
import { SmartRouterCache, buildSmartRouterCacheKey } from './smart-router.cache';
import { SmartRouterCircuitBreaker } from './smart-router.circuit-breaker';
import { SMART_ROUTER_CONFIG } from './smart-router.config';
import {
  buildRouterPrompt,
  extractRouterText,
  extractRouterUsage,
  parseRouterDecision,
} from './smart-router.prompt';
import { summarizeRequest } from './summarize-request.util';
import type {
  RouterCandidate,
  RouterFailureKind,
  SmartRouterConfigView,
  SmartRouterDecision,
  SmartRouterInput,
} from './smart-router.types';

type ForwardOutcome =
  | { ok: true; text: string; body: unknown; latencyMs: number }
  | { ok: false; kind: 'router_timeout' | 'router_failure'; detail: string; latencyMs: number };

@Injectable()
export class SmartRouterService {
  private readonly logger = new Logger(SmartRouterService.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    private readonly discoveryService: ModelDiscoveryService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly tierService: TierService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly providerClient: ProviderClient,
    private readonly routingCache: RoutingCacheService,
    private readonly cache: SmartRouterCache,
    private readonly breaker: SmartRouterCircuitBreaker,
  ) {
    // A provider mutation (connect, disconnect, rename) already invalidates the
    // agent's routing cache; piggyback on it so a stale decision never outlives
    // the catalog it was made from.
    this.routingCache.addInvalidationListener((agentId) => this.cache.invalidateAgent(agentId));
  }

  /**
   * Ask the router model which of this agent's models should serve the
   * request.
   *
   * Returns null for every failure — timeout, HTTP error, unparseable answer,
   * unknown model, missing credentials, internal bug. The caller then falls
   * through to scoring-based routing, so a broken router never breaks a
   * request.
   */
  async decide(input: SmartRouterInput): Promise<SmartRouterDecision | null> {
    if (!SMART_ROUTER_CONFIG.globalEnabled) return null;

    const agent = input.agent;
    if (!agent?.smart_router_enabled) return null;
    if (
      !agent.smart_router_provider ||
      !agent.smart_router_model ||
      !agent.smart_router_auth_type
    ) {
      return null;
    }

    // Without an attempt factory there is no parent Request to attach the
    // router hop to, so the Smart Router does not run at all.
    if (!input.attempt?.startProviderAttempt) return null;

    if (this.breaker.isOpen()) return null;

    const routerRoute: ModelRoute = {
      provider: agent.smart_router_provider,
      authType: agent.smart_router_auth_type as AuthType,
      model: agent.smart_router_model,
      keyLabel: agent.smart_router_key_label ?? undefined,
    };

    // Hoisted so the catch block can complete the attempt if the failure
    // happens after it was started.
    let key: CachedProviderKey | null = null;
    let attempt: ProviderAttemptRef | undefined;

    // Everything from the catalog fetch onward is inside the try: a database
    // error in the catalog or the credential lookup must not fail the
    // caller's request — it must fall through to scoring-based routing.
    try {
      const catalog = (
        await this.discoveryService.getModelsForAgent(input.tenantId, agent.id)
      ).filter((model) => !!model.authType);
      if (catalog.length < 2) return null;

      // The proxy's scoring input is already stripped of system/developer roles
      // and sliced to the last few messages, so the summary is built from the
      // raw request messages when they are available.
      const summary = summarizeRequest({
        messages: input.attempt?.rawMessages ?? input.messages,
        tools: input.tools,
      });
      const cacheKey = buildSmartRouterCacheKey(
        agent.id,
        summary.lastUserExcerpt,
        summary.toolCount,
        summary.tokenEstimate,
      );

      const cached = this.cache.get(cacheKey);
      if (cached) {
        return this.toDecision(
          cached.route,
          cached.reason,
          cached.tier,
          cached.fallback_routes,
          agent,
          0,
        );
      }

      // Build the candidate list BEFORE the attempt is started. An attempt
      // that has been started must always be completed, and there is nothing to
      // complete when there is no candidate to choose from.
      const candidates: RouterCandidate[] = catalog
        .filter((model) => agent.smart_router_include_self || model.id !== agent.smart_router_model)
        .map((model) => ({
          id: model.id,
          provider: model.provider,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          reasoning: model.capabilityReasoning,
          code: model.capabilityCode,
        }));
      if (candidates.length === 0) return null;

      // The credential lookup happens after the candidate list is built: the
      // candidates come from the catalog, not from the router's own
      // connection, so the order does not matter. Note that
      // `selectProviderKey` silently falls back to the default connection
      // when a `keyLabel` pin no longer matches a renamed connection, so a
      // renamed router connection bills another connection rather than
      // failing the router — the same behaviour the rest of the proxy has.
      key = await this.providerKeyService.selectProviderKey(
        input.tenantId,
        routerRoute.provider,
        routerRoute.authType,
        routerRoute.keyLabel ?? undefined,
        agent.id,
      );

      // The synthetic Ollama key id ('ollama') is not a real tenant_providers
      // row, so stamping it on agent_messages.tenant_provider_id violates the
      // FK and tears down the whole router decision. Map it to NULL — the same
      // "no persisted connection" treatment the proxy path uses in
      // route-credentials.ts. Local providers thus record a NULL connection id,
      // consistent with every other Ollama-served row.
      const tenantProviderId = key && key.id !== SYNTHETIC_OLLAMA_PROVIDER_ID ? key.id : null;

      attempt = input.attempt.startProviderAttempt({
        provider: routerRoute.provider,
        model: routerRoute.model,
        authType: routerRoute.authType,
        tenantProviderId,
        keyLabel: key?.label,
      });

      // A local provider (Ollama, LM Studio) legitimately has an empty apiKey —
      // the rest of the proxy treats an empty key for a local provider as
      // "available" (see provider-key.service.ts decryptOne + hasRouteCredentials,
      // which only checks keys.length). Mirror that here: the router has usable
      // credentials when a key resolved AND either it carries a non-empty key or
      // its provider is local. Without this, `!key.apiKey` is true for every
      // Ollama router model (empty string is falsy) and the router is wrongly
      // rejected as router_no_credentials.
      const routerIsLocal = isLocalOnlyProvider(routerRoute.provider);
      if (!key || (!key.apiKey && !routerIsLocal)) {
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind: 'router_no_credentials',
          detail: 'the configured router model has no usable credential',
          latencyMs: 0,
          routerRoute,
          keyLabel: key?.label ?? null,
          tenantProviderId,
        });
        this.breaker.recordFailure();
        return null;
      }

      const prompt = buildRouterPrompt(candidates, summary);
      // Empty string for a local provider (Ollama) — it needs no credential.
      const routerApiKey = key.apiKey ?? '';
      let outcome = await this.forward(routerRoute, routerApiKey, prompt, input.attempt?.signal);

      let parsed: { modelId: string; reason: string } | null = null;
      if (outcome.ok) {
        parsed = parseRouterDecision(outcome.text);
        if (!parsed) {
          // One retry with a stricter prompt — models often wrap the JSON in
          // prose the first time.
          const retry = await this.forward(
            routerRoute,
            routerApiKey,
            buildRouterPrompt(candidates, summary, true),
            input.attempt?.signal,
          );
          if (retry.ok) {
            parsed = parseRouterDecision(retry.text);
            if (parsed) outcome = retry;
          } else {
            outcome = retry;
          }
        }
      }

      if (!parsed) {
        // A forward that succeeded but produced an unusable answer is an
        // invalid response; a forward that failed keeps its own kind
        // (timeout / provider failure).
        const kind: RouterFailureKind = outcome.ok ? 'router_invalid_response' : outcome.kind;
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind,
          detail: outcome.ok ? 'the router answer could not be parsed' : outcome.detail,
          latencyMs: outcome.latencyMs,
          routerRoute,
          keyLabel: key.label ?? null,
          tenantProviderId,
          body: outcome.ok ? outcome.body : undefined,
        });
        this.breaker.recordFailure();
        return null;
      }

      const resolution = resolveModelRoute(parsed.modelId, catalog, {});
      if (!resolution.ok) {
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind: 'router_unknown_model',
          detail: `the router picked "${parsed.modelId}", which is not in the catalog`,
          latencyMs: outcome.latencyMs,
          routerRoute,
          keyLabel: key.label ?? null,
          tenantProviderId,
          decision: { modelId: parsed.modelId, reason: parsed.reason, provider: null },
        });
        this.breaker.recordFailure();
        return null;
      }

      const chosen = resolution.route;
      if (!(await this.providerKeyService.hasRouteCredentials(input.tenantId, chosen, agent.id))) {
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind: 'router_no_credentials',
          detail: `the router picked "${chosen.model}", which has no usable credential`,
          latencyMs: outcome.latencyMs,
          routerRoute,
          keyLabel: key.label ?? null,
          tenantProviderId,
          decision: { modelId: parsed.modelId, reason: parsed.reason, provider: chosen.provider },
        });
        this.breaker.recordFailure();
        return null;
      }

      const tierInfo = await this.tierService.findTierForModel(agent.id, chosen);
      const tier: TierSlot = tierInfo?.tier ?? 'default';
      const fallbackRoutes = tierInfo?.fallback_routes ?? null;

      this.cache.set(cacheKey, {
        route: chosen,
        reason: parsed.reason,
        tier,
        fallback_routes: fallbackRoutes,
      });

      await this.recordRouterRow(input, attempt, {
        ok: true,
        kind: null,
        detail: '',
        latencyMs: outcome.latencyMs,
        routerRoute,
        keyLabel: key.label ?? null,
        tenantProviderId,
        body: outcome.ok ? outcome.body : undefined,
        decision: { modelId: parsed.modelId, reason: parsed.reason, provider: chosen.provider },
      });

      this.breaker.recordSuccess();
      return this.toDecision(chosen, parsed.reason, tier, fallbackRoutes, agent, outcome.latencyMs);
    } catch (error) {
      // A bug in Manifest, or a database error, must never fail the caller's
      // request — and the attempt must never be left pending.
      this.logger.error(`Smart Router failed for agent=${agent.id}: ${error}`);
      if (attempt) {
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind: 'router_failure',
          detail: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
          routerRoute,
          keyLabel: key?.label ?? null,
          // `tenantProviderId` from the try block is out of scope here, so
          // re-normalize the synthetic Ollama id to NULL off the hoisted `key`.
          tenantProviderId: key && key.id !== SYNTHETIC_OLLAMA_PROVIDER_ID ? key.id : null,
        });
      }
      this.breaker.recordFailure();
      return null;
    }
  }

  private toDecision(
    route: ModelRoute,
    reason: string,
    tier: TierSlot,
    fallback_routes: ModelRoute[] | null,
    agent: Agent,
    latencyMs: number,
  ): SmartRouterDecision {
    return {
      route,
      reason,
      tier,
      fallback_routes,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: DEFAULT_RESPONSE_MODE,
      routerProvider: agent.smart_router_provider ?? route.provider,
      routerModel: agent.smart_router_model ?? route.model,
      routerAuthType: agent.smart_router_auth_type ?? route.authType,
      routerKeyLabel: agent.smart_router_key_label ?? null,
      routerTenantProviderId: null,
      latencyMs,
    };
  }

  /**
   * The router's own LLM call.
   *
   * Reuses the shared `ProviderClient` transport, so every provider shape
   * (OpenAI, Anthropic, Google) works. The call is non-streaming, bounded by
   * its own timeout (independent of `PROVIDER_TIMEOUT_MS`), and never touches
   * the caller's request recording.
   */
  private async forward(
    route: ModelRoute,
    apiKey: string,
    prompt: { system: string; user: string },
    callerSignal?: AbortSignal,
  ): Promise<ForwardOutcome> {
    const controller = new AbortController();
    // A caller that disconnects must not keep a provider call open.
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SMART_ROUTER_CONFIG.timeoutMs);
    const startedAt = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: route.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_tokens: SMART_ROUTER_CONFIG.maxTokens,
        stream: false,
      };
      if (this.supportsJsonMode(route)) {
        body.response_format = { type: 'json_object' };
      }

      const result = await this.providerClient.forward({
        provider: route.provider,
        apiKey,
        model: route.model,
        body,
        apiMode: 'chat_completions',
        stream: false,
        signal: controller.signal,
        authType: route.authType,
      });

      const latencyMs = Date.now() - startedAt;
      if (!result.response.ok) {
        const detail = await result.response.text().catch(() => '');
        return { ok: false, kind: 'router_failure', detail: detail.slice(0, 500), latencyMs };
      }
      const parsedBody = await result.response.json().catch(() => null);
      const text = extractRouterText(parsedBody);
      if (text === null) {
        return {
          ok: false,
          kind: 'router_failure',
          detail: 'the router answer carried no text',
          latencyMs,
        };
      }
      return { ok: true, text, body: parsedBody, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      // Our own timeout, a caller-side abort, and the platform's own timeout
      // are all "the router produced no answer" — a timeout, not a provider
      // failure.
      if (
        controller.signal.aborted ||
        isTimeoutError(error) ||
        getErrorName(error) === 'AbortError'
      ) {
        return {
          ok: false,
          kind: 'router_timeout',
          detail: 'the router call timed out',
          latencyMs,
        };
      }
      if (isTransportError(error)) {
        return {
          ok: false,
          kind: 'router_failure',
          detail: describeTransportError(error),
          latencyMs,
        };
      }
      return {
        ok: false,
        kind: 'router_failure',
        detail: error instanceof Error ? error.message : String(error),
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Whether the router's provider accepts `response_format: json_object`.
   *
   * Only the plain OpenAI Chat Completions endpoint does. The Responses-shaped
   * OpenAI endpoints do not, and neither do the Anthropic, Google, ChatGPT or
   * custom endpoints — for those the meta-prompt's "reply with JSON" plus the
   * tolerant parser carry the contract.
   */
  private supportsJsonMode(route: ModelRoute): boolean {
    const key = resolveEndpointKey(route.provider);
    if (!key) return false;
    if (key !== 'openai') return false;
    if (PROVIDER_ENDPOINTS[key]?.format !== 'openai') return false;
    // A Responses-only model is served by /v1/responses, which has no
    // `response_format`.
    return !OPENAI_RESPONSES_ONLY_RE.test(stripVendorPrefix(route.model));
  }

  /**
   * Write the router's own attempt row.
   *
   * The row is built here rather than through the shared `buildMessageRow`
   * helper because the router hop is always a *superseded* attempt — even when
   * it succeeded — and `buildMessageRow` derives `superseded` from the status.
   */
  private async recordRouterRow(
    input: SmartRouterInput,
    attempt: ProviderAttemptRef,
    outcome: {
      ok: boolean;
      kind: RouterFailureKind | null;
      detail: string;
      latencyMs: number;
      routerRoute: ModelRoute;
      keyLabel: string | null;
      tenantProviderId: string | null;
      body?: unknown;
      decision?: { modelId: string; reason: string; provider: string | null };
    },
  ): Promise<void> {
    const usage = extractRouterUsage(outcome.body);
    const costUsd = await this.computeCost(outcome.routerRoute, usage);
    const row: Partial<AgentMessage> = {
      id: attempt.id,
      attempt_number: attempt.attemptNumber,
      timestamp: attempt.startedAt,
      duration_ms: outcome.latencyMs,
      tenant_id: input.tenantId,
      agent_id: input.agent?.id ?? null,
      agent_name: input.agentName,
      user_id: input.userId,
      trace_id: null,
      status: outcome.ok ? 'success' : 'failed',
      model: outcome.routerRoute.model,
      provider: outcome.routerRoute.provider,
      auth_type: outcome.routerRoute.authType,
      tenant_provider_id: outcome.tenantProviderId,
      provider_key_label: outcome.keyLabel,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: costUsd,
      // The router hop is not tied to a tier — it is the step that picks one.
      routing_tier: 'default',
      routing_reason: 'smart_router',
      // The router hop is never the request's primary attempt.
      superseded: true,
      error_message: outcome.ok ? null : outcome.detail,
      error_class: outcome.ok ? null : outcome.kind,
      // A missing credential is the operator's configuration, not a provider
      // failure — it must not land in the provider error rate.
      error_origin: outcome.ok
        ? null
        : outcome.kind === 'router_timeout'
          ? 'transport'
          : outcome.kind === 'router_no_credentials'
            ? 'config'
            : 'provider',
      error_http_status: null,
      specificity_category: null,
      router_decision_provider: outcome.decision?.provider ?? null,
      router_decision_model: outcome.decision?.modelId ?? null,
      router_decision_reason: outcome.decision?.reason ?? null,
      router_decision_latency_ms: outcome.latencyMs,
    };

    try {
      const written = await attempt.pendingWrite.catch(() => false);
      if (written) {
        // The pending row the proxy inserted already carries the parent
        // Request's id. Only the INSERT path has to set it — writing `null`
        // on the UPDATE path would orphan the hop from its request.
        if (input.attempt?.requestId) {
          await this.messageRepo.update(
            { id: attempt.id },
            { ...row, request_id: input.attempt.requestId },
          );
        } else {
          await this.messageRepo.update({ id: attempt.id }, row);
        }
      } else {
        await this.messageRepo.insert({
          ...row,
          request_id: input.attempt?.requestId ?? null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to record the Smart Router attempt for agent=${input.agent?.id}: ${error}`,
      );
    }
  }

  private async computeCost(
    route: ModelRoute,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<number | null> {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return null;
    return computeTokenCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: route.model,
      pricing: this.pricingCache.getByModel(route.model, route.provider),
      isSubscription: route.authType === 'subscription',
      isLocalProvider: isLocalOnlyProvider(route.provider),
      perRequestCostUsd: null,
      reportedCostUsd: undefined,
    });
  }

  /** The REST view of the agent's Smart Router configuration. */
  async getConfig(agentId: string, tenantId: string): Promise<SmartRouterConfigView> {
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    const catalog = await this.discoveryService.getModelsForAgent(tenantId, agentId);
    return {
      enabled: agent?.smart_router_enabled ?? false,
      model: this.agentRoute(agent),
      include_router_in_candidates: agent?.smart_router_include_self ?? true,
      has_catalog: catalog.length > 0,
      last_decision_at: await this.lastDecisionAt(agentId),
    };
  }

  /** Persist a configuration change and bust the routing cache. */
  async updateConfig(
    agentId: string,
    tenantId: string,
    body: {
      enabled?: boolean;
      model?: ModelRoute | null;
      include_router_in_candidates?: boolean;
    },
  ): Promise<SmartRouterConfigView> {
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);

    // A plain object of primitives, so TypeORM's QueryDeepPartialEntity accepts
    // it without a cast.
    const patch: {
      smart_router_enabled?: boolean;
      smart_router_provider?: string | null;
      smart_router_model?: string | null;
      smart_router_auth_type?: string | null;
      smart_router_key_label?: string | null;
      smart_router_include_self?: boolean;
    } = {};

    if (body.enabled !== undefined) patch.smart_router_enabled = body.enabled;
    if (body.include_router_in_candidates !== undefined) {
      patch.smart_router_include_self = body.include_router_in_candidates;
    }
    // `undefined` leaves the router model alone; `null` clears it.
    if (body.model !== undefined) {
      if (body.model === null) {
        patch.smart_router_provider = null;
        patch.smart_router_model = null;
        patch.smart_router_auth_type = null;
        patch.smart_router_key_label = null;
      } else {
        patch.smart_router_provider = body.model.provider;
        patch.smart_router_model = body.model.model;
        patch.smart_router_auth_type = body.model.authType;
        patch.smart_router_key_label = body.model.keyLabel ?? null;
      }
    }

    await this.agentRepo.update({ id: agentId }, patch);
    this.routingCache.invalidateAgent(agentId);
    this.cache.invalidateAgent(agentId);
    return this.getConfig(agentId, tenantId);
  }

  /** When the router last ran for this agent. */
  async lastDecisionAt(agentId: string): Promise<string | null> {
    const row = await this.messageRepo.findOne({
      where: { agent_id: agentId, routing_reason: 'smart_router' },
      order: { timestamp: 'DESC' },
    });
    return row?.timestamp ?? null;
  }

  private agentRoute(agent: Agent | null): ModelRoute | null {
    if (
      !agent?.smart_router_provider ||
      !agent.smart_router_model ||
      !agent.smart_router_auth_type
    ) {
      return null;
    }
    return {
      provider: agent.smart_router_provider,
      authType: agent.smart_router_auth_type as AuthType,
      model: agent.smart_router_model,
      keyLabel: agent.smart_router_key_label ?? undefined,
    };
  }
}
