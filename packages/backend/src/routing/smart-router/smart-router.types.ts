import type { AuthType, ModelRoute, OutputModality, ResponseMode, TierSlot } from 'manifest-shared';
import type { StartProviderAttempt } from '../proxy/proxy-types';
import type { Agent } from '../../entities/agent.entity';

/** One model the router may choose from, as shown in the meta-prompt. */
export interface RouterCandidate {
  /** The model's discovery id — the router must echo this back verbatim. */
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  reasoning: boolean;
  code: boolean;
}

/** The outcome of a successful router call. */
export interface SmartRouterDecision {
  route: ModelRoute;
  /** The router's own explanation, truncated for storage. */
  reason: string;
  /** The tier the chosen model belongs to, or 'default'. */
  tier: TierSlot;
  /** The tier's configured fallback chain, carried forward unchanged. */
  fallback_routes: ModelRoute[] | null;
  output_modality: OutputModality;
  response_mode: ResponseMode;
  /** The model that RAN the router. */
  routerProvider: string;
  routerModel: string;
  routerAuthType: AuthType | string;
  routerKeyLabel: string | null;
  routerTenantProviderId: string | null;
  latencyMs: number;
}

/** Why a router call failed. Maps onto `agent_messages.error_class`. */
export type RouterFailureKind =
  | 'router_timeout'
  | 'router_failure'
  | 'router_invalid_response'
  | 'router_unknown_model'
  | 'router_no_credentials';

/** The parent's identity, so the router hop can be recorded against it. */
export interface SmartRouterAttemptContext {
  agentName: string;
  userId: string | null;
  /**
   * The proxy's attempt factory. When absent (the `POST /api/v1/routing/resolve`
   * probe) there is no parent Request to attach a row to, and the Smart Router
   * does not run at all.
   */
  startProviderAttempt?: StartProviderAttempt;
  /**
   * The parent Manifest Request's id. The router hop is a Provider Attempt of
   * that request, so its row must carry the same `request_id` — otherwise the
   * Messages log's join on `at.request_id = r.id` cannot see it, the request
   * detail panel cannot list it, and the quota backfill counts it as a
   * standalone message.
   */
  requestId?: string;
  /**
   * The caller's raw messages, before the proxy strips system/developer roles
   * and slices the tail for scoring. The router's summary describes the real
   * request, so it needs the unfiltered list.
   */
  rawMessages?: unknown;
  /** The caller's abort signal — a disconnected caller must not keep the hop open. */
  signal?: AbortSignal;
}

export interface SmartRouterInput {
  /**
   * The already-loaded harness row. The resolver has it in hand, so the Smart
   * Router must NOT query it again — a second read per request would tax
   * every harness, including the ones that never touch this layer. Null when
   * the harness row vanished between the two reads.
   */
  agent: Agent | null;
  tenantId: string;
  agentName: string;
  userId: string | null;
  messages: unknown;
  tools: unknown;
  attempt?: SmartRouterAttemptContext;
}

/** The shape the REST endpoints return. */
export interface SmartRouterConfigView {
  enabled: boolean;
  model: ModelRoute | null;
  include_router_in_candidates: boolean;
  has_catalog: boolean;
  last_decision_at: string | null;
}
