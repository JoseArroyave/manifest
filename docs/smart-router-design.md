# Smart Router (LLM-Selected Routing) — Design

**Date:** 2026-10-19
**Status:** Approved — pending implementation plan
**Scope:** additive, opt-in, per-agent

---

## Problem

Manifest's existing resolver picks an LLM using deterministic keyword scoring + a static complexity tier model (simple/standard/complex/reasoning). When a tenant has linked several models of different sizes and specialities, the existing scorer picks the *tier*, not the *model*. The user wants a new layer where one of the already-linked models acts as a "router" — given a small description of the incoming request and the catalog of available models, it picks the best one to actually run.

This is **purely additive**. Nothing existing moves: header tiers, specificity, complexity scoring, tier assignments, the fallback chain, Autofix, and explicit-model overrides all keep their current behaviour.

## Goals

1. Add an opt-in per-agent **Smart Router** that selects the model for a request by asking a smaller LLM (also user-configured) to choose from the agent's discovered catalog.
2. When the Smart Router is off (default), behaviour is byte-identical to today.
3. When the Smart Router is on and fails for any reason, the request transparently degrades to today's scoring-based routing.
4. Stay inside the existing recorder contract (`agent_messages.routing_reason` already accepts the scoring reasons; we add one more) and the existing `RoutingCacheService` invalidation pattern.

## Non-Goals (YAGNI)

* No allowlist UI for candidate models (the column is created but stays NULL by default — future work).
* No multi-router voting.
* No persistence of router reasoning for analytics beyond the existing `agent_messages` row.
* No cross-tenant intelligence.

---

## Decisions Locked In

| # | Decision | Why |
|---|----------|-----|
| 1 | New opt-in layer that replaces `scoreRequest`, only when no header-tier / explicit-model / specificity path already matched | Respects "no movemos nada de esto". Smart Router only runs on the bare `model: 'auto'` path. |
| 2 | Catalog = `ModelDiscoveryService.getModelsForAgent(tenantId, agentId)` (connected + discovered models for this agent) | Matches the "Available models" dropdown in the UI; automatically respects per-agent provider enable/disable. |
| 3 | Router model is **manually picked** by the user in Settings | Lets the operator choose a cheap small model (e.g. `gpt-4o-mini`, `haiku`). Off if unset. |
| 4 | On Smart Router failure, **fall back to today's `resolveLazy`** | Never break the existing request path; never return an error visible to the caller. |
| 5 | Smart Router runs only when (a) `smart_router_enabled` true, (b) `model: 'auto'` or absent, (c) no header-tier match, (d) no active specificity category | Header-tiers and explicit-model wins stay untouched; specificity stays untouched. |
| 6 | Meta-prompt uses **forced JSON** (`response_format={"type":"json_object"}` when the router model supports it, otherwise regex-tolerant parsing) | Robust across providers; one retry on parse failure then fallback. |
| 7 | Only a **summary** of the request is sent to the router: estimated total tokens, tool count, presence of system prompt, last user message excerpt (≤500 chars); never the full conversation | Privacy + cost. |
| 8 | In-memory LRU cache, **TTL 30 s**, keyed by `hash(agent_id, last_user_msg, tool_count, token_estimate)` | Saves repeated identical requests; invalidation reuses `RoutingCacheService.invalidateAgent`. |
| 9 | The router call is recorded as its own `agent_messages` row with `superseded=true` and `routing_reason='smart_router'`, full tokens + cost | Same shape as a failed fallback hop; countable for billing. |
| 10 | Edge cases (no router model, no catalog, no credentials, single model) → graceful fallback to scoring | Feature off is silent. |

---

## Architecture

### New backend layout

```
packages/backend/src/
├── routing/
│   ├── smart-router/               ← NEW
│   │   ├── smart-router.module.ts
│   │   ├── smart-router.service.ts           # builds prompt, calls LLM, parses, validates
│   │   ├── smart-router.cache.ts             # LRU + TTL
│   │   ├── smart-router.controller.ts        # GET/PATCH /api/v1/routing/:agentName/smart-router
│   │   ├── dto/smart-router.dto.ts
│   │   ├── summarize-request.util.ts         # meta-prompt input builder (no PII leakage)
│   │   ├── __tests__/
│   │   │   ├── smart-router.service.spec.ts
│   │   │   ├── smart-router.cache.spec.ts
│   │   │   ├── summarize-request.util.spec.ts
│   │   │   └── smart-router.controller.spec.ts
│   └── resolve/resolve.service.ts            # + 1 method (resolveViaSmartRouter), 1 dispatch line
├── entities/
│   ├── agent.entity.ts                       # + 5 columns
│   └── agent-message.entity.ts               # + 4 columns
├── proxy/proxy-message-recorder.ts           # + 1 helper (recordRouterDecision)
└── database/migrations/1803200000000-AddSmartRouterConfig.ts   # NEW
```

### New shared type

`packages/shared/src/routing-reasons.ts` (or wherever `ScoringReason` lives) gets one more union member:

```ts
type ScoringReason =
  | 'scored' | 'short_message' | 'momentum' | 'large_context'
  | 'tool_detected' | 'formal_logic_override' | 'ambiguous' | 'heartbeat'
  | 'specificity' | 'header-match' | 'default' | 'direct'
  | 'smart_router';   // ← NEW
```

`SELECT 'smart_router'::varchar` round-trips through every place that reads `routing_reason`.

### Data flow

```
POST /v1/chat/completions { model: "auto", messages: [...] }
  └─ proxy.controller.handleProxyRequest()      [unchanged]
     └─ proxyService.proxyRequest()
        └─ resolveRouting()
           └─ resolveService.resolveLazy(...)
              ├─ resolveHeaderTier()            [unchanged — wins outright if it matches]
              ├─   ┌── NEW INSERTION ──┐
              ├─   │ if (               │
              ├─   │   agent.smart_router_enabled │
              ├─   │   && hasRouterModel()│
              ├─   │   && !headerTierMatched│
              ├─   │   && !specificityActive│
              ├─   │   && catalog.length >= 2│
              ├─   │ )                  │
              ├─   │   return resolveViaSmartRouter(...)│
              ├─   └────────────────────┘
              ├─ resolveSpecificity()           [unchanged]
              ├─ scoreRequest()                 [unchanged, skipped when smart router ran]
              └─ buildResolvedRouteChain()      [unchanged]
        └─ [proxyRequest body from line 287 onward is unchanged]
              ├─ resolveCredentials / tryForwardToProvider
              ├─ tryFallbackChain (with full existing fallbacks)
              └─ recorder.recordSuccess / recordProviderError
```

### `resolveViaSmartRouter(agent, tenantId, body, headers)` — happy path

1. `catalog = await discoveryService.getModelsForAgent(tenantId, agent.id)`
2. `routerRoute = lookupRouterRoute(agent.smart_router_model_id, catalog)`
   * If `routerRoute` has no credentials → log + call `resolveLazy()` (fallback).
3. `cacheKey = sha256(agent.id | last_user_text | tool_count | token_estimate)`
4. `cached = cache.get(cacheKey)` — hit returns synchronously.
5. `summary = summarizeForRouter(body)` (returns `{ token_estimate, has_system, has_tools, tool_count, last_user_excerpt }`).
6. `prompt = buildMetaPrompt(catalog, summary)`
   * Static header: "You are a routing assistant. Pick the best model for the incoming request. Reply only with JSON."
   * Table of candidates (id, provider, modalities, context_window).
   * The summary block.
7. `response = await tryMetaRouterForward(routerRoute, prompt, { timeout: SMART_ROUTER_TIMEOUT_MS, max_tokens: SMART_ROUTER_MAX_TOKENS })`
   * Uses existing `tryForwardToProvider` with `apiMode='chat_completions'`, `stream=false`, model params not merged (router bypasses tier-scoped overrides).
   * Adds `response_format={"type":"json_object"}` to the wire body when the router provider supports it.
8. Parse response → `{ model_id, reason }`. Invalid → log + retry once with stricter prompt; second failure → fallback to `resolveLazy`.
9. `chosenRoute = resolveModelRouteFromCatalog(model_id, catalog)`
   * Unknown / no credentials → log + fallback to `resolveLazy`.
10. `cache.set(cacheKey, { route: chosenRoute, reason }, ttl)`
11. Return:

```ts
{
  tier: 'standard',                     // Smart Router does not use tiers; report as standard
  route: chosenRoute,
  fallback_routes: null,                // First hop has no fallback; scoring fallback kicks in only if smart router fails to return
  output_modality: DEFAULT_OUTPUT_MODALITY,
  response_mode: DEFAULT_RESPONSE_MODE,
  confidence: 1,
  score: 0,
  reason: 'smart_router',               // ← new ScoringReason
  // (these pass through RoutingMeta → agent_messages columns)
  smart_router_reason: parsed.reason,
  smart_router_provider: routerRoute.provider,
  smart_router_model: routerRoute.model,
}
```

The `fallback_routes` choice is deliberate: the Smart Router just made a single intentional decision. The configured fallback chain in the agent's `tier_assignments` is tied to scoring tiers, not to the Smart Router. If a Smart Router pick fails at the provider, we degrade to the scoring fallback chain — which means we *do* want fallbacks active. **Open question to confirm with user during planning: keep `fallback_routes: null`, or carry the scoring tier's fallbacks into the Smart Router result?** The recommended default is `null`; current decisions file this as an open choice.

---

## Data model

### New columns on `agents`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `smart_router_enabled` | `boolean` | `false` | Master switch. NULL = inherit deployment default; for now the deployment default is off. |
| `smart_router_provider` | `varchar` | NULL | Provider id of the configured router model. |
| `smart_router_model` | `varchar` | NULL | Model id. The (provider, model) pair is the canonical Smart Router identity. |
| `smart_router_auth_type` | `varchar` | NULL | Optional pin. |
| `smart_router_key_label` | `varchar` | NULL | Optional pin. |

`smart_router_model` alone is ambiguous across providers, so we persist the four-tuple `(provider, model, auth_type, key_label)` and use it in cache invalidation. UI editing only writes the (provider, model) pair at first; auth_type and key_label are optional pins copied from the default key when the model is selected.

### New columns on `agent_messages`

| Column | Type | Notes |
|--------|------|-------|
| `router_decision_provider` | `varchar NULL` | The provider of the model the router picked. |
| `router_decision_model` | `varchar NULL` | The model id the router picked. |
| `router_decision_reason` | `text NULL` | Router's own reasoning (≤500 chars). |
| `router_decision_latency_ms` | `integer NULL` | Wall clock from call sent to response received. |

The four columns appear *only* on Smart Router rows. Other rows have NULLs.

The frontend's `MessageTable` and `ModelCell` see new fields via `selectMessageRowColumns()` which gains the four alias mappings. `query-helpers.spec.ts` is updated to pin the alias set.

### Migration

`packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts` (timestamp 1803200000000 chosen to slot after the most recent migration at 1803100000000).

Operations:

```sql
-- agents: add 5 columns
ALTER TABLE agents
  ADD COLUMN smart_router_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN smart_router_provider varchar NULL,
  ADD COLUMN smart_router_model varchar NULL,
  ADD COLUMN smart_router_auth_type varchar NULL,
  ADD COLUMN smart_router_key_label varchar NULL;

-- agent_messages: add 4 columns
ALTER TABLE agent_messages
  ADD COLUMN router_decision_provider varchar NULL,
  ADD COLUMN router_decision_model varchar NULL,
  ADD COLUMN router_decision_reason text NULL,
  ADD COLUMN router_decision_latency_ms integer NULL;
```

No new indexes — these columns are write-only and never filtered.

Spec file `__tests__/1803200000000-AddSmartRouterConfig.spec.ts` verifies the migration on a real PostgreSQL instance and confirms `agents` defaults to `smart_router_enabled = false`.

---

## Cache invalidation

`SmartRouterCache` subscribes to `RoutingCacheService.addInvalidationListener((agentId) => …)`. When the agent's catalog or connections change (already fired by every provider mutation today), the cache drops entries that match the agent id. This piggybacks on the existing central cache invalidation; no new lifecycle.

---

## REST endpoints

| Method | Path | Request body | Response |
|--------|------|--------------|----------|
| GET | `/api/v1/routing/:agentName/smart-router` | — | `{ enabled, model: ModelRoute\|null, has_catalog: boolean, last_decision_at: string\|null }` |
| PATCH | `/api/v1/routing/:agentName/smart-router` | `{ enabled?: boolean, model?: ModelRoute\|null }` | same shape |

Both endpoints inherit the existing SessionGuard + ApiKeyGuard + Throttler from `app.module.ts`. No new auth path.

The PATCH writes through `routingCache.invalidateAgent(agentId)` so the next request re-resolves the new router model.

---

## Frontend

### New page section

`packages/frontend/src/pages/SmartRouterSettings.tsx` — a single section component, mounted inside the existing `Routing.tsx` (one import + one component, no new tab).

UI layout:

```
┌─ Smart Router ───────────────────────────────────────┐
│ When enabled, requests with model: 'auto' first ask   │
│ a small LLM which of your linked models is best for    │
│ the task. Header tiers, explicit model names, and      │
│ specificity routing still win when they apply.         │
│                                                       │
│ [ ◯ Enable Smart Router ]                             │
│                                                       │
│ When enabled:                                         │
│   Router model: [ ▾ gpt-4o-mini (openai/api_key) ▾ ]   │
│   [info] Decisions cache for 30s. If the router call  │
│   fails, requests transparently fall back to          │
│   tier-based routing.                                 │
│                                                       │
│ Last decision: 2 min ago → chose gpt-5                │
└───────────────────────────────────────────────────────┘
```

State comes from the new `getSmartRouter()` / `updateSmartRouter()` in `packages/frontend/src/services/api/routing.ts`.

No changes to `Workspace.tsx`, `AgentOverview.tsx`, `MessageLog.tsx`, or any other page. The Messages log gets one new column (`router_decision_*`) that shows under the model detail view, identical to how `header_tier_name` is shown today.

---

## Recording & telemetry

### Smart Router row layout

```jsonc
{
  "id": "<uuid>",
  "request_id": "<same as the user-facing request>",
  "agent_id": "...", "tenant_id": "...",
  "agent_name": "demo-agent",

  "provider": "openai",                    // the router model provider
  "model":    "gpt-4o-mini",               // the router model
  "auth_type": "api_key",

  "status": "success",                     // or "failed"

  "routing_tier": "standard",
  "routing_reason": "smart_router",        // ← new ScoringReason

  // NEW columns, only filled here
  "router_decision_provider": "openai",
  "router_decision_model":    "gpt-5",
  "router_decision_reason":   "Reasoning task, needs max context",
  "router_decision_latency_ms": 380,

  "input_tokens": 420, "output_tokens": 35,
  "cost_usd": 0.00012,
  "superseded": true,                      // doesn't count as the "primary" attempt for the request

  "fallback_from_model": null,
  "fallback_index": null,
  "parent_attempt_number": null,
  "tenant_provider_id": "...",

  "duration_ms": 380,
  "created_at": "2026-10-19T..."
}
```

The user-facing `requests` row stays the same; the Smart Router decision lives on a sibling `agent_messages` row.

### Dashboard display

* **Requests log** still shows one row per request. Expanding shows all attempts: Smart Router decision → chosen model call.
* **Messages count** (billing) counts both rows.
* **Provider reliability** metrics exclude Smart Router rows (filter `routing_reason != 'smart_router'`).

The query-helpers update makes the `selectMessageRowColumns()` projection include the new columns; the existing `query-helpers.spec.ts` test is extended.

---

## Error handling

| Failure | Behaviour | Recorded info |
|---------|-----------|---------------|
| Router call times out (>5 s) | Fallback to `resolveLazy` | `agent_messages` row: `status='failed'`, `error_class='router_timeout'` |
| Router call returns HTTP 4xx / 5xx | Fallback to `resolveLazy` | `status='failed'`, `error_class='router_failure'` (carries raw sanitised body) |
| Response body unparseable | Retry once with stricter prompt; second failure → fallback | `error_class='router_invalid_response'` (only the final failure is recorded) |
| Parsed JSON has `model_id` not in catalog | Fallback to `resolveLazy` | `error_class='router_unknown_model'`, `router_decision_model` set to the bad value |
| `model_id` is in catalog but no credentials | Fallback to `resolveLazy` | `error_class='router_no_credentials'` |
| SmartRouterService internal bug | `Logger.error` + fallback | Stack in logs; request never fails |
| Cache corruption (any) | Catch + recompute | invisible to caller |

### Circuit breaker

Same shape as Autofix's: 3 consecutive failures within a process → open for 30 s → close on first success. Per-process, no coordination. Configurable via env (defaults on).

---

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `SMART_ROUTER_GLOBAL_ENABLED` | `true` | Hard global kill switch |
| `SMART_ROUTER_TIMEOUT_MS` | `5000` | Per call |
| `SMART_ROUTER_MAX_TOKENS` | `200` | JSON `{model_id, reason}` |
| `SMART_ROUTER_CACHE_TTL_MS` | `30000` | In-memory LRU |
| `SMART_ROUTER_CACHE_MAX_ENTRIES` | `1000` | LRU capacity |
| `SMART_ROUTER_CIRCUIT_BREAKER_ENABLED` | `true` | |
| `SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD` | `3` | |
| `SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | |

Per the CLAUDE.md "backwards-compatible defaults" rule: all env-gated, all defaults preserve current behaviour.

---

## Testing

### Unit tests (target: 100% line coverage in new files)

* `smart-router.service.spec.ts`:
  * Builds a valid meta-prompt from a synthetic catalog.
  * Parses a valid JSON response with the right `model_id`.
  * Falls back to `resolveLazy` on each failure mode (timeout, non-JSON, unknown model, missing credentials).
  * Records a row on every success and every failure.
  * Cache hit short-circuits the LLM call.
  * Circuit breaker opens after N consecutive failures.
* `smart-router.cache.spec.ts`:
  * get/set/TTL/LRU eviction.
  * `invalidateAgent` clears only matching entries.
* `summarize-request.util.spec.ts`:
  * Truncates long content at the 500-char limit.
  * Drops system/developer messages.
  * Estimates token count (rough), includes tool count.
* `smart-router.controller.spec.ts`:
  * GET returns `200` with the current config shape, honours auth guards.
  * PATCH validates DTOs (off switch, model schema).
  * PATCH writes through `routingCache.invalidateAgent`.
* `resolve.service.spec.ts` (modify): exercises the new dispatch line.
* `proxy-message-recorder.spec.ts` (modify): new route writes `superseded=true` and the four new columns.
* `query-helpers.spec.ts` (modify): alias set now includes the four new columns.

### E2E tests (`smart-router.e2e-spec.ts`)

1. Smart Router on + router model has credentials → request hits the chosen model, **two** `agent_messages` rows in the same request (router + chosen).
2. Smart Router on + router times out → request completes via scoring; **one failed router row** + **one scoring-row**.
3. Smart Router on + router picks unknown model → fallback to scoring; failed router row carries `error_class='router_unknown_model'`.
4. Smart Router on + router model lacks credentials → fallback to scoring; failed router row carries `error_class='router_no_credentials'`.
5. Smart Router on + only one model in catalog → skip router, route directly.
6. Smart Router off → no router rows written; behaviour byte-identical to baseline.
7. Explicit `model: 'gpt-5'` with Smart Router on → no router call.
8. Header tier rule matches with Smart Router on → no router call.
9. Specificity category active with Smart Router on → no router call.
10. Circuit breaker: 3 timeouts in a row → next request short-circuits to scoring without an LLM call.

### Coverage requirement

Per `CLAUDE.md`: patch coverage 100 %, project coverage no drop beyond the configured threshold.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Latency from router call degrades user-perceived TTFB | TTL 30 s cache hit; circuit breaker; 5 s timeout; cache hit bypasses the LLM call entirely |
| Router cost eats savings when picking a cheap model | By default the router model is small (user picks); spec recommends `gpt-4o-mini` / `haiku`-class |
| Model drift: router starts picking suboptimal models | The `agent_messages` row records what was chosen + the router's reason — easy to audit; choice to add analytics later stays open |
| Race: catalog changes while router is deciding | Cache TTL is short; `routingCache.invalidateAgent` clears stale entries on the next request |
| Storage growth from `router_decision_reason` text | TTL retention applies to `agent_messages`; the text is short (~50 chars avg) |
| Recursive call: router picks *itself* as the chosen model | Include the router model in the candidate table by default; allow opt-out via the same checkbox UI; cheap models are short-running so even self-pick is fine |
| Telemetry noise: every request gets a router row even when nothing changed | Cache hits don't add a row, but the `agent_messages` recorder is called only on the **first** request that triggers a router call. Subsequent cache hits do not produce new rows. (Confirmed design choice — final wording in implementation plan.) |

---

## Files modified (summary)

**Backend — new:**
* `packages/backend/src/routing/smart-router/smart-router.module.ts`
* `packages/backend/src/routing/smart-router/smart-router.service.ts`
* `packages/backend/src/routing/smart-router/smart-router.cache.ts`
* `packages/backend/src/routing/smart-router/smart-router.controller.ts`
* `packages/backend/src/routing/smart-router/dto/smart-router.dto.ts`
* `packages/backend/src/routing/smart-router/summarize-request.util.ts`
* `packages/backend/src/routing/smart-router/__tests__/*` (4 files)
* `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts`
* `packages/backend/src/database/migrations/__tests__/1803200000000-AddSmartRouterConfig.spec.ts`

**Backend — modified:**
* `packages/backend/src/routing/resolve/resolve.service.ts` — one method, one dispatch line
* `packages/backend/src/routing/resolve/resolve.module.ts` — register the new SmartRouterModule
* `packages/backend/src/entities/agent.entity.ts` — 5 columns
* `packages/backend/src/entities/agent-message.entity.ts` — 4 columns
* `packages/backend/src/routing/proxy/proxy-message-recorder.ts` — 1 helper
* `packages/backend/src/analytics/services/query-helpers.ts` — alias additions
* `packages/backend/src/analytics/services/__tests__/query-helpers.spec.ts` — pin the alias set
* `packages/backend/src/proxy/proxy-response-handler.ts` — pass the new `smart_router_*` meta fields through (only if surfaced to caller; confirm in plan phase)
* `packages/shared/src/routing-reasons.ts` (or the right file) — one new union member
* `packages/backend/src/database/data-source-definitions.ts` — register the migration
* `packages/backend/test/helpers.ts` — no new entities (migration is plain ALTER), no change needed
* `.env.example` — document new env vars

**Frontend — new:**
* `packages/frontend/src/pages/SmartRouterSettings.tsx`

**Frontend — modified:**
* `packages/frontend/src/pages/Routing.tsx` — import + mount (1 component)
* `packages/frontend/src/services/api/routing.ts` — 2 functions
* `packages/frontend/src/components/MessageTable.tsx` (or `ModelCell.tsx`) — show `router_decision_*` in the expanded detail (existing detail row pattern; no new component)

**Docs:**
* `docs/glossary.md` — add "Smart Router" entry
* `CLAUDE.md` — extend the "Routing" section to mention the Smart Router layer

---

## Open questions to resolve during implementation planning

* Whether the Smart Router result should carry the chosen model's tier fallbacks forward or stay with `fallback_routes: null`. **Default = null; revisit if it causes UX issues.**
* Whether `smart_router_model` selection in the UI should also pin the auth_type / key_label or default to "any key on this provider". **Default = use the default key on the chosen provider.**
* Whether the Smart Router result row should appear in the Messages log alongside normal attempts, or only on the request detail. **Default = both, same as `header_tier_*` rows.**
* Whether to ship the allowlist column (currently created as nullable, unused). **Default = yes (cheap), keep it nullable until needed.**
