# Smart Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, per-agent **Smart Router** layer that asks a small, user-picked LLM which of the agent's already-linked models should serve the incoming request, then routes the request to the model that LLM chose.

**Architecture:** A new `SmartRouterModule` under `packages/backend/src/routing/smart-router/` owns the decision: it builds a small meta-prompt from the agent's discovered-model catalog, calls the configured router model through the existing `ProviderClient` transport, parses a forced-JSON `{model_id, reason}` answer, and returns a `ModelRoute`. `ResolveService.resolveLazy` gains one dispatch branch that consults the Smart Router; every failure path returns `null` and the request falls through to today's scoring-based routing unchanged. The router hop is recorded as its own `agent_messages` row with four new `router_decision_*` columns, and a 30-second in-memory cache means a burst of identical requests produces one router row, not one per request.

**Tech Stack:** NestJS 11, TypeORM 0.3, PostgreSQL 16, SolidJS, Jest (backend unit + e2e), Vitest (frontend).

**Spec:** [`docs/smart-router-design.md`](./smart-router-design.md) (approved 2026-10-19).

---

## Scope check

One subsystem, one plan. The dashboard work is a card on the existing Routing page plus two API client functions — it does not need its own plan.

---

## Behaviour contract (read this before writing code)

These are the invariants the implementation must preserve. Each one is enforced by a test named in the task that owns it.

| #   | Invariant                                                                                                                                                                                                                                                  | Enforced by                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| B1  | With the Smart Router off (default), routing is **byte-identical** to today. No extra query, no extra call, no new row.                                                                                                                                    | Task 9 test "off agents resolve exactly as before"            |
| B2  | A header-tier match wins over the Smart Router (the header-tier early return in `resolveLazy` runs first).                                                                                                                                                 | Task 9 test "a matching header tier skips the router"         |
| B3  | An active specificity category wins over the Smart Router.                                                                                                                                                                                                 | Task 9 test "an active specificity category skips the router" |
| B4  | An explicit `model` in the request body never reaches the Smart Router (handled earlier, in `ProxyService.resolveRouting`).                                                                                                                                | Task 10 test "an explicit model skips the router"             |
| B5  | Every Smart Router failure (timeout, HTTP error, unparseable body, unknown model, missing credentials, internal bug) falls back to scoring-based routing. The caller never sees an error.                                                                  | Task 8 tests, one per failure mode                            |
| B6  | The router hop is recorded as its own `agent_messages` row with `routing_reason = 'smart_router'` and `superseded = true`, and it carries the **parent Request's `request_id`** so it joins that request in the Messages log and the request-detail panel. | Task 8 + Task 13 tests                                        |
| B6b | The _served_ attempt carries `routing_reason = 'smart_router'` too, but is **not** superseded. It stays in the provider-reliability numbers; the router's own hop does not.                                                                                | Task 12 test                                                  |
| B6c | The router's own hop never determines the Request's outcome — a failed router hop does not set `had_failure`, so the Request is never reported as "recovered". Per the glossary it still counts in Attempt metrics.                                        | Task 12 test                                                  |
| B7  | A cache hit performs **no** LLM call and writes **no** router row.                                                                                                                                                                                         | Task 3 + Task 8 tests                                         |
| B8  | The chosen model's tier is carried forward, so the existing fallback chain still applies.                                                                                                                                                                  | Task 7 + Task 8 tests                                         |
| B9  | The Smart Router never runs on `POST /api/v1/routing/resolve` (the probe endpoint) — there is no parent Request to attach a row to.                                                                                                                        | Task 9 test "the resolve probe never calls the router"        |

### Corrections to the spec (found while reading the code)

1. **`last_decision_at` reads `agent_messages.timestamp`, not `created_at`.** The `agent_messages` table has no `created_at` column (see `packages/backend/src/entities/agent-message.entity.ts` — the column is `timestamp`). The spec's SQL snippet is wrong; use `MAX(timestamp)`.
2. **The Smart Router's model list is the _discovered_ catalog (`ModelDiscoveryService.getModelsForAgent`), whose ids are internal** (`gpt-4o-mini`, `custom:<uuid>/<name>`). The router is shown those ids verbatim and must echo one back. `resolveModelRoute()` from `packages/backend/src/routing/routing-core/resolve-model-route.ts` maps the echoed id back to a canonical `ModelRoute`.
3. **`ScoringReason` lives in the backend, not in `packages/shared`.** The spec names `packages/shared/src/routing-reasons.ts`; the real home is `packages/backend/src/scoring/types.ts` (re-exported from `packages/backend/src/scoring/index.ts`). The plan uses the real path.
4. **The _served_ attempt also carries `routing_reason = 'smart_router'`.** That is how the dashboard records that the Smart Router chose the route, and it is correct — the tier really was selected by the router. The router's _own_ hop is told apart by `superseded = true`, which is what every provider-reliability exclusion keys on.
5. **The router's summary is built from the _raw_ request messages.** The proxy hands the resolver a scoring-filtered list (system/developer roles stripped, tail sliced), so the summary would otherwise never see a system prompt and would under-report the request size. The proxy therefore also passes the raw messages in the attempt context, and the summariser uses those.
6. **The circuit breaker is process-wide, by design.** The spec calls for "3 consecutive failures within a process → open for 30 s", the same shape as Autofix's breaker. The consequence is that the e2e cases in one file share a failure streak, so their order matters — the plan's e2e puts the failure cases before the breaker case for that reason.

### One deliberate deviation from the spec

(The spec's example row shows `"routing_tier": "standard"` for the router hop. The plan writes `"default"`: the router hop runs _before_ a tier is chosen — it is the step that chooses one — so it does not belong to any tier. The tier the _served_ attempt landed in is on that attempt's own row.)

The spec says "Messages count (billing) counts both rows". It does not, and should not: `packages/backend/src/billing/plan.service.ts` counts only rows with `COALESCE(superseded, false) = false`, and the router's hop is superseded by design — exactly like a failed fallback hop. Counting it would bill the tenant twice for one request. The router's tokens and cost are still **recorded** on the row (and visible in the request detail), they are simply not counted as a separate request.

### Two deliberate v1 limits

- **The router model must be a built-in provider's model.** `ProviderClient.resolveEndpoint` throws for a `custom:<uuid>` provider (the custom endpoint lives on a DB row that the shared resolver would have to fetch). The router therefore calls a built-in provider only. A custom provider may still be _chosen_ — the choice is routed by the normal proxy path, which handles custom providers fine.
- **The Smart Router does not run on `POST /api/v1/routing/resolve`.** That endpoint is a static preview; there is no parent Manifest Request to attach the router hop to. The probe keeps answering with today's scoring result. This is behaviour B9.

### Module graph — no import cycles

```
ResolveModule ──▶ SmartRouterModule ──▶ RoutingCoreModule
                                         ModelDiscoveryModule
                                         ModelPricesModule
                                         TypeOrmModule.forFeature([Agent, AgentMessage])
```

`SmartRouterModule` **must not** import `ProxyModule`: `ProxyModule` imports `ResolveModule`, so `ResolveModule → SmartRouterModule → ProxyModule → ResolveModule` would be a NestJS cycle.

Two consequences, both handled in Task 8:

- `SmartRouterModule` provides its **own** `ProviderClient` instance. `ProviderClient`'s constructor dependencies are all `@Optional()` (`packages/backend/src/routing/proxy/provider-client.ts:359`), so it works with only `OpencodeGoCatalogService` (exported by `ModelDiscoveryModule`) and `ProviderModelRegistryService` (exported by `ModelPricesModule`). The two deps it loses versus the proxy's instance — `ModelsDevReasoningCatalog` (OpenAI reasoning-effort tiers) and the shared `CodexSessionAffinity` map — are irrelevant to a tiny non-streaming JSON call.
- `SmartRouterService` writes the router's `agent_messages` row itself through the `AgentMessage` repository. The row is built **inline**, not through the shared `buildMessageRow` helper: that helper derives `superseded` from the row's status, and the router hop is always superseded — even when it succeeded.

---

## File map

### Backend — created

| File                                                                                       | Responsibility                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/routing/smart-router/smart-router.config.ts`                         | Reads the eight `SMART_ROUTER_*` env vars at module load, with defaults that preserve today's behaviour.                                                  |
| `packages/backend/src/routing/smart-router/smart-router.types.ts`                          | Pure interfaces: `SmartRouterDecision`, `SmartRouterInput`, `SmartRouterAttemptContext`, `RouterCandidate`, `RouterFailureKind`, `SmartRouterConfigView`. |
| `packages/backend/src/routing/smart-router/smart-router.cache.ts`                          | TTL + LRU cache of decisions, keyed by agent id + request hash. `invalidateAgent()` drops one agent's entries.                                            |
| `packages/backend/src/routing/smart-router/smart-router.circuit-breaker.ts`                | Per-process breaker: 3 consecutive failures → open for 30 s.                                                                                              |
| `packages/backend/src/routing/smart-router/summarize-request.util.ts`                      | Builds the privacy-preserving request summary (token estimate, tool count, last user excerpt ≤ 500 chars).                                                |
| `packages/backend/src/routing/smart-router/smart-router.prompt.ts`                         | Builds the meta-prompt; parses the router's answer; extracts text + usage from OpenAI / Anthropic / Google response shapes.                               |
| `packages/backend/src/routing/smart-router/smart-router.service.ts`                        | The decision engine: catalog, cache, forward, parse, validate, record.                                                                                    |
| `packages/backend/src/routing/smart-router/smart-router.controller.ts`                     | `GET` / `PATCH /api/v1/routing/:agentName/smart-router`.                                                                                                  |
| `packages/backend/src/routing/smart-router/dto/smart-router.dto.ts`                        | Request DTOs for the PATCH body.                                                                                                                          |
| `packages/backend/src/routing/smart-router/smart-router.module.ts`                         | Wires the above.                                                                                                                                          |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.config.spec.ts`          | Env-config unit tests.                                                                                                                                    |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.cache.spec.ts`           | Cache unit tests.                                                                                                                                         |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts` | Breaker unit tests.                                                                                                                                       |
| `packages/backend/src/routing/smart-router/__tests__/summarize-request.util.spec.ts`       | Summarizer unit tests.                                                                                                                                    |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.prompt.spec.ts`          | Prompt + parser unit tests.                                                                                                                               |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.service.spec.ts`         | Decision engine unit tests (all failure modes).                                                                                                           |
| `packages/backend/src/routing/smart-router/__tests__/smart-router.controller.spec.ts`      | Controller unit tests.                                                                                                                                    |
| `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts`           | Adds the 6 `agents` columns and the 4 `agent_messages` columns.                                                                                           |
| `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts`      | Migration unit test.                                                                                                                                      |
| `packages/backend/test/smart-router.e2e-spec.ts`                                           | End-to-end tests (12 cases; the spec's specificity case is covered by the resolver unit test instead).                                                    |

### Backend — modified

| File                                                                          | Change                                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/error-taxonomy.ts`                                       | +5 `router_*` error classes.                                                                                         |
| `packages/backend/src/entities/agent.entity.ts`                               | +6 columns.                                                                                                          |
| `packages/backend/src/entities/agent-message.entity.ts`                       | +4 columns.                                                                                                          |
| `packages/backend/src/scoring/types.ts`                                       | `'smart_router'` added to `ScoringReason`.                                                                           |
| `packages/backend/src/routing/dto/resolve-response.ts`                        | +3 optional `smart_router_*` fields.                                                                                 |
| `packages/backend/src/routing/resolve/resolve.service.ts`                     | +1 dispatch branch, +1 optional param, +1 injected service.                                                          |
| `packages/backend/src/routing/resolve/__tests__/resolve.service.spec.ts`      | New Smart Router dispatch cases.                                                                                     |
| `packages/backend/src/routing/resolve/__tests__/resolve.service.edge.spec.ts` | Constructor argument for the new dependency.                                                                         |
| `packages/backend/src/routing/resolve/resolve.module.ts`                      | Import `SmartRouterModule`.                                                                                          |
| `packages/backend/src/routing/routing-core/tier.service.ts`                   | +`findTierForModel()`.                                                                                               |
| `packages/backend/src/routing/proxy/proxy.service.ts`                         | Pass `startProviderAttempt`, the request id and the agent identity into the resolver.                                |
| `packages/backend/src/routing/proxy/proxy.service.ts` (`RoutingMeta`)         | +3 optional `smart_router_*` fields.                                                                                 |
| `packages/backend/src/routing/proxy/proxy-types.ts`                           | +1 optional `requestId` on `ProxyRequestOptions`.                                                                    |
| `packages/backend/src/routing/proxy/proxy.controller.ts`                      | Pass `requestId` into `proxyRequest`.                                                                                |
| `packages/backend/src/analytics/services/query-helpers.ts`                    | +4 aliases in `MESSAGE_ROW_SELECT_ALIASES` / `selectMessageRowColumns()`, +1 shared `excludeSmartRouterPredicate()`. |
| `packages/backend/src/analytics/services/error-breakdown.service.ts`          | Exclude the router's hop from the error groups.                                                                      |
| `packages/backend/src/analytics/services/aggregation.service.ts`              | Exclude the router's hop from the per-Request outcome.                                                               |
| `packages/backend/src/analytics/services/aggregation.service.spec.ts`         | Update the direct-traffic assertion the change breaks.                                                               |
| `packages/backend/src/routing/proxy/proxy-response-handler.ts`                | `X-Manifest-Smart-Router-Model` response header.                                                                     |
| `packages/backend/src/analytics/services/query-helpers.spec.ts`               | Update the pinned alias set.                                                                                         |
| `packages/backend/src/database/data-source-definitions.ts`                    | Register the migration.                                                                                              |
| `packages/backend/.env.example`                                               | Document the 8 env vars.                                                                                             |

### Frontend — created / modified

| File                                                         | Change                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/frontend/src/pages/SmartRouterSettings.tsx`        | **New.** The Smart Router card.                                       |
| `packages/frontend/tests/pages/SmartRouterSettings.test.tsx` | **New.** The card's unit test.                                        |
| `packages/frontend/src/pages/Routing.tsx`                    | Import + mount the card.                                              |
| `packages/frontend/src/services/api/routing.ts`              | +`getSmartRouter()`, `updateSmartRouter()`, `SmartRouterConfig` type. |
| `packages/frontend/src/services/api/messages.ts`             | +4 `router_decision_*` fields on the message row type.                |
| `packages/frontend/src/components/message-table-types.ts`    | +4 optional `router_decision_*` fields.                               |
| `packages/frontend/src/components/MessageDetails.tsx`        | Render the router decision in the expanded attempt detail.            |

### Docs

| File                   | Change                                        |
| ---------------------- | --------------------------------------------- |
| `docs/glossary.md`     | "Smart Router" entry.                         |
| `CLAUDE.md`            | Mention the layer in the LLM Routing section. |
| `.changeset/<name>.md` | `manifest` / `minor`.                         |

---

## Task ordering

Tasks 1–8 build the Smart Router in isolation (no existing file is touched). Task 9 wires it into the resolver. Tasks 10–12 add the surrounding plumbing. Task 13 is the e2e suite. Tasks 14–16 are the dashboard. Task 17 is documentation.

Every task ends with a commit. Run the backend unit suite before each commit:

```bash
cd packages/backend && npx jest --silent
```

---

## Task 1: Data model — entities, migration, `ScoringReason`

**Files:**

- Modify: `packages/backend/src/entities/agent.entity.ts`
- Modify: `packages/backend/src/entities/agent-message.entity.ts`
- Modify: `packages/backend/src/scoring/types.ts`
- Create: `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts`
- Create: `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts`
- Modify: `packages/backend/src/database/data-source-definitions.ts`

- [ ] **Step 1: Write the failing migration test**

Create `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts`:

```ts
import { AddSmartRouterConfig1803200000000 } from './1803200000000-AddSmartRouterConfig';

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (sql: string) => []);
  await new AddSmartRouterConfig1803200000000()[direction]({ query } as never);
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('AddSmartRouterConfig1803200000000', () => {
  it('adds the six agents columns on up', async () => {
    const sql = (await run('up')).join('\n');
    expect(sql).toContain('"smart_router_enabled" boolean NOT NULL DEFAULT false');
    expect(sql).toContain('"smart_router_provider" varchar');
    expect(sql).toContain('"smart_router_model" varchar');
    expect(sql).toContain('"smart_router_auth_type" varchar');
    expect(sql).toContain('"smart_router_key_label" varchar');
    expect(sql).toContain('"smart_router_include_self" boolean NOT NULL DEFAULT true');
  });

  it('adds the four agent_messages columns on up', async () => {
    const sql = (await run('up')).join('\n');
    expect(sql).toContain('"router_decision_provider" varchar');
    expect(sql).toContain('"router_decision_model" varchar');
    expect(sql).toContain('"router_decision_reason" text');
    expect(sql).toContain('"router_decision_latency_ms" integer');
  });

  it('creates no index', async () => {
    const sql = (await run('up')).join('\n');
    expect(sql).not.toContain('CREATE INDEX');
  });

  it('drops every column on down', async () => {
    const sql = (await run('down')).join('\n');
    for (const column of [
      'smart_router_enabled',
      'smart_router_provider',
      'smart_router_model',
      'smart_router_auth_type',
      'smart_router_key_label',
      'smart_router_include_self',
      'router_decision_provider',
      'router_decision_model',
      'router_decision_reason',
      'router_decision_latency_ms',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts`
Expected: FAIL — `Cannot find module './1803200000000-AddSmartRouterConfig'`.

- [ ] **Step 3: Write the migration**

Create `packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Smart Router's configuration and audit columns.
 *
 * `agents` gains the router's identity (provider / model / auth type / key
 * label), the master switch and the "include the router in the candidate list"
 * toggle. The switch defaults to false, so every existing install keeps
 * today's routing byte-for-byte until an operator opts in.
 *
 * `agent_messages` gains the four `router_decision_*` columns, filled only on
 * the Smart Router's own attempt row: what the router picked, why, and how
 * long it took. The router hop itself reuses the existing `provider`, `model`,
 * `auth_type` and `tenant_provider_id` columns, and marks itself
 * `superseded = true` so it never counts as the request's primary attempt.
 *
 * No indexes: these columns are write-only and never filtered on.
 */
export class AddSmartRouterConfig1803200000000 implements MigrationInterface {
  name = 'AddSmartRouterConfig1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_provider" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_model" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_auth_type" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_key_label" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_include_self" boolean NOT NULL DEFAULT true`,
    );

    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_provider" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_model" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_latency_ms" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_latency_ms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_model"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_include_self"`,
    );
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_key_label"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_auth_type"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_model"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_provider"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_enabled"`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the entity columns**

In `packages/backend/src/entities/agent.entity.ts`, after the `is_playground` column, add:

```ts
  // Smart Router: when enabled, a small user-picked LLM chooses which of this
  // agent's linked models serves each `model: 'auto'` request. The switch
  // defaults to false, so the layer is inert until an operator opts in.
  @Column('boolean', { default: false })
  smart_router_enabled!: boolean;

  // The router model's identity. `smart_router_model` alone is ambiguous
  // across providers, so the (provider, auth_type, key_label) triple pins it.
  @Column('varchar', { nullable: true })
  smart_router_provider!: string | null;

  @Column('varchar', { nullable: true })
  smart_router_model!: string | null;

  @Column('varchar', { nullable: true })
  smart_router_auth_type!: string | null;

  @Column('varchar', { nullable: true })
  smart_router_key_label!: string | null;

  // When true, the router model is also offered as a candidate for itself.
  @Column('boolean', { default: true })
  smart_router_include_self!: boolean;
```

In `packages/backend/src/entities/agent-message.entity.ts`, after the `autofix_decision` column, add:

```ts
  // Smart Router audit. Set only on the router's own attempt row.
  // `router_decision_*` is what the router PICKED; the `provider` / `model` /
  // `auth_type` columns above name the model that RAN the router. The two are
  // different things and must not be conflated.
  @Column('varchar', { nullable: true })
  router_decision_provider!: string | null;

  @Column('varchar', { nullable: true })
  router_decision_model!: string | null;

  @Column('text', { nullable: true })
  router_decision_reason!: string | null;

  @Column('integer', { nullable: true })
  router_decision_latency_ms!: number | null;
```

- [ ] **Step 6: Add `'smart_router'` to `ScoringReason`**

In `packages/backend/src/scoring/types.ts`, change:

```ts
export type ScoringReason =
  | 'scored'
  | 'formal_logic_override'
  | 'tool_detected'
  | 'large_context'
  | 'short_message'
  | 'momentum'
  | 'ambiguous'
  | 'heartbeat'
  | 'specificity'
  | 'default'
  | 'header-match'
  | 'smart_router';
```

- [ ] **Step 7: Register the migration**

In `packages/backend/src/database/data-source-definitions.ts`, add the import next to the other `1803…` imports:

```ts
import { AddSmartRouterConfig1803200000000 } from './migrations/1803200000000-AddSmartRouterConfig';
```

and add the entry at the end of the `migrations` array:

```ts
  AddSmartRouterConfig1803200000000,
```

- [ ] **Step 8: Run the backend suite**

Run: `cd packages/backend && npx jest --silent`
Expected: PASS. The `ScoringReason` union widening is backwards-compatible.

- [ ] **Step 9: Commit**

```bash
git add packages/backend/src/entities/agent.entity.ts \
  packages/backend/src/entities/agent-message.entity.ts \
  packages/backend/src/scoring/types.ts \
  packages/backend/src/database/data-source-definitions.ts \
  packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.ts \
  packages/backend/src/database/migrations/1803200000000-AddSmartRouterConfig.spec.ts
git commit -m "feat: add Smart Router config and audit columns"
```

---

## Task 2: Smart Router env configuration

**Files:**

- Create: `packages/backend/src/routing/smart-router/smart-router.config.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.config.spec.ts`
- Modify: `packages/backend/.env.example`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.config.spec.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.config.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.config'`.

- [ ] **Step 3: Write the config module**

Create `packages/backend/src/routing/smart-router/smart-router.config.ts`:

```ts
/**
 * Smart Router tuning, read from the environment.
 *
 * Every default preserves today's behaviour: the global switch is on (so an
 * operator can enable the layer per agent without a redeploy), but the layer
 * itself is inert until an agent opts in.
 */

export interface SmartRouterConfig {
  globalEnabled: boolean;
  timeoutMs: number;
  maxTokens: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  circuitBreakerEnabled: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() !== 'false';
}

export function readSmartRouterConfig(): SmartRouterConfig {
  return {
    globalEnabled: readBoolean('SMART_ROUTER_GLOBAL_ENABLED', true),
    timeoutMs: readPositiveInt('SMART_ROUTER_TIMEOUT_MS', 5000),
    maxTokens: readPositiveInt('SMART_ROUTER_MAX_TOKENS', 200),
    cacheTtlMs: readPositiveInt('SMART_ROUTER_CACHE_TTL_MS', 30_000),
    cacheMaxEntries: readPositiveInt('SMART_ROUTER_CACHE_MAX_ENTRIES', 1000),
    circuitBreakerEnabled: readBoolean('SMART_ROUTER_CIRCUIT_BREAKER_ENABLED', true),
    circuitBreakerThreshold: readPositiveInt('SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD', 3),
    circuitBreakerCooldownMs: readPositiveInt('SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS', 30_000),
  };
}

/** The process-wide configuration, captured at import time. */
export const SMART_ROUTER_CONFIG: SmartRouterConfig = readSmartRouterConfig();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.config.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Document the env vars**

In `packages/backend/.env.example`, append:

```dotenv
# --- Smart Router (LLM-selected routing) -----------------------------------
# Global kill switch for the Smart Router layer. Defaults to true; the layer
# is inert until a harness opts in on its Routing page.
SMART_ROUTER_GLOBAL_ENABLED=true
# Per-call timeout for the router's own LLM call (ms).
SMART_ROUTER_TIMEOUT_MS=5000
# Token budget for the router's JSON answer.
SMART_ROUTER_MAX_TOKENS=200
# How long a routing decision is reused for an identical request (ms).
SMART_ROUTER_CACHE_TTL_MS=30000
# Maximum cached decisions across all harnesses.
SMART_ROUTER_CACHE_MAX_ENTRIES=1000
# Circuit breaker: opens after N consecutive router failures.
SMART_ROUTER_CIRCUIT_BREAKER_ENABLED=true
SMART_ROUTER_CIRCUIT_BREAKER_THRESHOLD=3
# How long the breaker stays open (ms).
SMART_ROUTER_CIRCUIT_BREAKER_COOLDOWN_MS=30000
```

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routing/smart-router/smart-router.config.ts \
  packages/backend/src/routing/smart-router/__tests__/smart-router.config.spec.ts \
  packages/backend/.env.example
git commit -m "feat: add Smart Router configuration"
```

---

## Task 3: Decision cache (TTL + LRU)

**Files:**

- Create: `packages/backend/src/routing/smart-router/smart-router.cache.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.cache.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.cache.spec.ts`:

```ts
import { SmartRouterCache, buildSmartRouterCacheKey } from '../smart-router.cache';
import type { ModelRoute } from 'manifest-shared';

const ROUTE: ModelRoute = { provider: 'openai', authType: 'api_key', model: 'gpt-4o' };

describe('SmartRouterCache', () => {
  it('returns null for an unknown key', () => {
    const cache = new SmartRouterCache(1000, 10);
    expect(cache.get('agent-1\u0000abc')).toBeNull();
  });

  it('returns a stored decision', () => {
    const cache = new SmartRouterCache(1000, 10);
    cache.set('agent-1\u0000abc', {
      route: ROUTE,
      reason: 'needs reasoning',
      tier: 'default',
      fallback_routes: null,
    });
    expect(cache.get('agent-1\u0000abc')?.route).toEqual(ROUTE);
  });

  it('expires an entry once the TTL has passed', () => {
    jest.useFakeTimers();
    try {
      const cache = new SmartRouterCache(1000, 10);
      cache.set('agent-1\u0000abc', {
        route: ROUTE,
        reason: 'r',
        tier: 'default',
        fallback_routes: null,
      });
      jest.advanceTimersByTime(1001);
      expect(cache.get('agent-1\u0000abc')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the oldest entry when the capacity is reached', () => {
    const cache = new SmartRouterCache(60_000, 2);
    cache.set('agent-1\u0000a', {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set('agent-1\u0000b', {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set('agent-1\u0000c', {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    expect(cache.get('agent-1\u0000a')).toBeNull();
    expect(cache.get('agent-1\u0000c')).not.toBeNull();
  });

  it('invalidates only the entries of one agent', () => {
    const cache = new SmartRouterCache(60_000, 10);
    cache.set('agent-1\u0000a', {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.set('agent-2\u0000b', {
      route: ROUTE,
      reason: 'r',
      tier: 'default',
      fallback_routes: null,
    });
    cache.invalidateAgent('agent-1');
    expect(cache.get('agent-1\u0000a')).toBeNull();
    expect(cache.get('agent-2\u0000b')).not.toBeNull();
  });
});

describe('buildSmartRouterCacheKey', () => {
  it('is stable for the same inputs', () => {
    const a = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    const b = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    expect(a).toBe(b);
  });

  it('differs when any input differs', () => {
    const base = buildSmartRouterCacheKey('agent-1', 'hello', 0, 12);
    expect(buildSmartRouterCacheKey('agent-2', 'hello', 0, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'bye', 0, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 1, 12)).not.toBe(base);
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 0, 13)).not.toBe(base);
  });

  it('prefixes the key with the agent id so one agent can be invalidated', () => {
    expect(buildSmartRouterCacheKey('agent-1', 'hello', 0, 12).startsWith('agent-1\u0000')).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.cache.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.cache'`.

- [ ] **Step 3: Write the cache**

Create `packages/backend/src/routing/smart-router/smart-router.cache.ts`:

```ts
import { createHash } from 'crypto';
import type { ModelRoute, TierSlot } from 'manifest-shared';
import { SMART_ROUTER_CONFIG } from './smart-router.config';

export interface SmartRouterCacheEntry {
  route: ModelRoute;
  reason: string;
  tier: TierSlot;
  fallback_routes: ModelRoute[] | null;
}

interface StoredEntry {
  value: SmartRouterCacheEntry;
  expiresAt: number;
}

/**
 * The cache key is `<agentId> NUL <hash>` so `invalidateAgent()` can drop one
 * agent's decisions by prefix without scanning the whole map. The hash covers
 * only the request's shape — the last user message, the tool count and the
 * token estimate — so two different requests never share a decision.
 */
export function buildSmartRouterCacheKey(
  agentId: string,
  lastUserText: string,
  toolCount: number,
  tokenEstimate: number,
): string {
  const hash = createHash('sha256')
    .update(`${lastUserText}\u0000${toolCount}\u0000${tokenEstimate}`)
    .digest('hex');
  return `${agentId}\u0000${hash}`;
}

/**
 * In-memory TTL + LRU cache of routing decisions.
 *
 * The cache holds the *decision*, not the recording: a hit returns the route
 * immediately, with no LLM call and no `agent_messages` row. A burst of 100
 * identical requests therefore produces one router row, not 100.
 */
export class SmartRouterCache {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly ttlMs: number = SMART_ROUTER_CONFIG.cacheTtlMs,
    private readonly maxEntries: number = SMART_ROUTER_CONFIG.cacheMaxEntries,
  ) {}

  get(key: string): SmartRouterCacheEntry | null {
    const stored = this.entries.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return stored.value;
  }

  set(key: string, value: SmartRouterCacheEntry): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop every decision belonging to one agent. */
  invalidateAgent(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.cache.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routing/smart-router/smart-router.cache.ts \
  packages/backend/src/routing/smart-router/__tests__/smart-router.cache.spec.ts
git commit -m "feat: add Smart Router decision cache"
```

---

## Task 4: Request summarizer (the privacy boundary)

**Files:**

- Create: `packages/backend/src/routing/smart-router/summarize-request.util.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/summarize-request.util.spec.ts`

The router never sees the conversation. It sees a shape: how big the request is, whether it has tools, and the last user message truncated to 500 characters. Nothing else.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/routing/smart-router/__tests__/summarize-request.util.spec.ts`:

```ts
import { MAX_ROUTER_EXCERPT_CHARS, summarizeRequest } from '../summarize-request.util';

describe('summarizeRequest', () => {
  it('reports the last user message', () => {
    const summary = summarizeRequest({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(summary.lastUserExcerpt).toBe('second');
  });

  it('truncates the excerpt at 500 characters', () => {
    const summary = summarizeRequest({
      messages: [{ role: 'user', content: 'x'.repeat(900) }],
    });
    expect(summary.lastUserExcerpt).toHaveLength(MAX_ROUTER_EXCERPT_CHARS);
  });

  it('ignores system and developer messages when picking the excerpt', () => {
    const summary = summarizeRequest({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'real question' },
        { role: 'developer', content: 'later instructions' },
      ],
    });
    expect(summary.lastUserExcerpt).toBe('real question');
  });

  it('flags a system prompt without including it in the excerpt', () => {
    const summary = summarizeRequest({
      messages: [
        { role: 'system', content: 'secret system prompt' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(summary.hasSystem).toBe(true);
    expect(summary.lastUserExcerpt).toBe('hello');
    expect(summary.lastUserExcerpt).not.toContain('secret system prompt');
  });

  it('counts tools', () => {
    const summary = summarizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ function: { name: 'a' } }, { function: { name: 'b' } }],
    });
    expect(summary.toolCount).toBe(2);
    expect(summary.hasTools).toBe(true);
  });

  it('reports no tools when the list is absent or empty', () => {
    expect(summarizeRequest({ messages: [] }).toolCount).toBe(0);
    expect(summarizeRequest({ messages: [], tools: [] }).hasTools).toBe(false);
  });

  it('estimates tokens from the total character count', () => {
    const summary = summarizeRequest({
      messages: [{ role: 'user', content: 'y'.repeat(400) }],
    });
    expect(summary.tokenEstimate).toBeGreaterThan(0);
    expect(summary.tokenEstimate).toBeLessThanOrEqual(200);
  });

  it('joins the text parts of a multi-part user message', () => {
    const summary = summarizeRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
      ],
    });
    expect(summary.lastUserExcerpt).toBe('part one part two');
  });

  it('survives a malformed body', () => {
    const summary = summarizeRequest({ messages: 'not-an-array' as never });
    expect(summary.lastUserExcerpt).toBe('');
    expect(summary.toolCount).toBe(0);
    expect(summary.tokenEstimate).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/summarize-request.util.spec.ts`
Expected: FAIL — `Cannot find module '../summarize-request.util'`.

- [ ] **Step 3: Write the summarizer**

Create `packages/backend/src/routing/smart-router/summarize-request.util.ts`:

```ts
/**
 * The privacy boundary of the Smart Router.
 *
 * The router model only ever sees this summary — never the conversation. It
 * carries the request's *shape* (how big, how many tools, whether there is a
 * system prompt) plus a short excerpt of the last user message, which is the
 * only part of the conversation that actually describes the task.
 */

export const MAX_ROUTER_EXCERPT_CHARS = 500;

export interface RequestSummary {
  /** Rough token estimate of the whole request (chars / 4). */
  tokenEstimate: number;
  hasSystem: boolean;
  hasTools: boolean;
  toolCount: number;
  /** The last user message, truncated to {@link MAX_ROUTER_EXCERPT_CHARS}. */
  lastUserExcerpt: string;
}

interface RawMessage {
  role?: unknown;
  content?: unknown;
}

function isRawMessage(value: unknown): value is RawMessage {
  return typeof value === 'object' && value !== null;
}

/** Flatten a message's content into plain text, whatever shape it arrived in. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRawMessage(part) && typeof part.content === 'string') return part.content;
        if (typeof part === 'object' && part !== null) {
          const typed = part as { type?: unknown; text?: unknown };
          if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function summarizeRequest(input: { messages?: unknown; tools?: unknown }): RequestSummary {
  const rawMessages = Array.isArray(input.messages) ? input.messages.filter(isRawMessage) : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];

  let hasSystem = false;
  let lastUserText = '';
  let totalChars = 0;

  for (const message of rawMessages) {
    const role = typeof message.role === 'string' ? message.role : '';
    const text = messageText(message.content);
    totalChars += text.length;
    if (role === 'system' || role === 'developer') {
      hasSystem = true;
      continue;
    }
    if (role === 'user') lastUserText = text;
  }

  return {
    tokenEstimate: Math.ceil(totalChars / 4),
    hasSystem,
    hasTools: tools.length > 0,
    toolCount: tools.length,
    lastUserExcerpt: lastUserText.slice(0, MAX_ROUTER_EXCERPT_CHARS),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/summarize-request.util.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routing/smart-router/summarize-request.util.ts \
  packages/backend/src/routing/smart-router/__tests__/summarize-request.util.spec.ts
git commit -m "feat: add Smart Router request summarizer"
```

---

## Task 5: Meta-prompt builder and answer parser

**Files:**

- Create: `packages/backend/src/routing/smart-router/smart-router.prompt.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.prompt.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.prompt.spec.ts`:

````ts
import {
  buildRouterPrompt,
  extractRouterText,
  extractRouterUsage,
  parseRouterDecision,
} from '../smart-router.prompt';
import type { RouterCandidate } from '../smart-router.types';

const CANDIDATES: RouterCandidate[] = [
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o mini',
    contextWindow: 128000,
    reasoning: false,
    code: false,
  },
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.6',
    contextWindow: 200000,
    reasoning: true,
    code: true,
  },
];

const SUMMARY = {
  tokenEstimate: 900,
  hasSystem: true,
  hasTools: false,
  toolCount: 0,
  lastUserExcerpt: 'refactor this function',
};

describe('buildRouterPrompt', () => {
  it('lists every candidate by its exact id', () => {
    const prompt = buildRouterPrompt(CANDIDATES, SUMMARY);
    expect(prompt.user).toContain('gpt-4o-mini');
    expect(prompt.user).toContain('claude-opus-4-6');
  });

  it('tells the model to answer with JSON only', () => {
    const prompt = buildRouterPrompt(CANDIDATES, SUMMARY);
    expect(prompt.system.toLowerCase()).toContain('json');
    expect(prompt.user).toContain('model_id');
  });

  it('includes the request summary', () => {
    const prompt = buildRouterPrompt(CANDIDATES, SUMMARY);
    expect(prompt.user).toContain('refactor this function');
    expect(prompt.user).toContain('900');
  });

  it('tightens the instruction in strict mode', () => {
    const loose = buildRouterPrompt(CANDIDATES, SUMMARY);
    const strict = buildRouterPrompt(CANDIDATES, SUMMARY, true);
    expect(strict.user.length).toBeGreaterThan(loose.user.length);
    expect(strict.user).toMatch(/exactly/i);
  });

  it('renders a single candidate without a table', () => {
    const prompt = buildRouterPrompt([CANDIDATES[0]], SUMMARY);
    expect(prompt.user).toContain('gpt-4o-mini');
  });
});

describe('parseRouterDecision', () => {
  it('parses a plain JSON answer', () => {
    const decision = parseRouterDecision('{"model_id":"gpt-4o-mini","reason":"small task"}');
    expect(decision).toEqual({ modelId: 'gpt-4o-mini', reason: 'small task' });
  });

  it('parses a JSON answer wrapped in prose', () => {
    const decision = parseRouterDecision('Sure! {"model_id":"gpt-4o-mini","reason":"ok"} done');
    expect(decision?.modelId).toBe('gpt-4o-mini');
  });

  it('parses a fenced code block', () => {
    const decision = parseRouterDecision('```json\n{"model_id":"gpt-4o-mini","reason":"ok"}\n```');
    expect(decision?.modelId).toBe('gpt-4o-mini');
  });

  it('accepts a missing reason', () => {
    const decision = parseRouterDecision('{"model_id":"gpt-4o-mini"}');
    expect(decision?.modelId).toBe('gpt-4o-mini');
    expect(decision?.reason).toBe('');
  });

  it('returns null for a non-JSON answer', () => {
    expect(parseRouterDecision('I think gpt-4o-mini is best')).toBeNull();
  });

  it('returns null when model_id is missing', () => {
    expect(parseRouterDecision('{"reason":"no model"}')).toBeNull();
  });

  it('returns null for an empty answer', () => {
    expect(parseRouterDecision('')).toBeNull();
  });
});

describe('extractRouterText', () => {
  it('reads an OpenAI chat completion', () => {
    const text = extractRouterText({
      choices: [{ message: { content: 'hello' } }],
    });
    expect(text).toBe('hello');
  });

  it('reads an Anthropic message', () => {
    const text = extractRouterText({
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(text).toBe('hello');
  });

  it('reads a Google generate-content response', () => {
    const text = extractRouterText({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
    });
    expect(text).toBe('hello');
  });

  it('returns null when there is no text', () => {
    expect(extractRouterText({ choices: [] })).toBeNull();
    expect(extractRouterText(null)).toBeNull();
  });
});

describe('extractRouterUsage', () => {
  it('reads OpenAI usage', () => {
    expect(extractRouterUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } })).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
  });

  it('reads Anthropic usage', () => {
    expect(extractRouterUsage({ usage: { input_tokens: 7, output_tokens: 2 } })).toEqual({
      inputTokens: 7,
      outputTokens: 2,
    });
  });

  it('reads Google usage', () => {
    expect(
      extractRouterUsage({ usageMetadata: { promptTokenCount: 5, completionTokenCount: 1 } }),
    ).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it('returns zeroed usage when there is none', () => {
    expect(extractRouterUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.prompt.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.prompt'`.

- [ ] **Step 3: Write the types file**

Create `packages/backend/src/routing/smart-router/smart-router.types.ts`:

```ts
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
```

- [ ] **Step 4: Write the prompt module**

Create `packages/backend/src/routing/smart-router/smart-router.prompt.ts`:

````ts
import type { RequestSummary } from './summarize-request.util';
import type { RouterCandidate } from './smart-router.types';

const SYSTEM_PROMPT =
  'You are a routing assistant. You pick which language model should serve an incoming request. ' +
  'Reply with a single JSON object and nothing else: {"model_id": "<id>", "reason": "<short reason>"}. ' +
  'Choose the cheapest model that can handle the task well. Never invent a model id.';

const STRICT_SUFFIX =
  '\n\nAnswer with EXACTLY one JSON object, no prose, no code fence: ' +
  '{"model_id": "<one of the ids listed above>", "reason": "<short reason>"}. ' +
  'The model_id must be copied character for character from the list.';

/** Build the meta-prompt handed to the router model. */
export function buildRouterPrompt(
  candidates: RouterCandidate[],
  summary: RequestSummary,
  strict = false,
): { system: string; user: string } {
  const lines = candidates.map((candidate) => {
    const traits = [
      candidate.reasoning ? 'reasoning' : null,
      candidate.code ? 'code' : null,
    ].filter(Boolean);
    return `- ${candidate.id} — ${candidate.displayName} (${candidate.provider}, context ${candidate.contextWindow}${
      traits.length ? `, ${traits.join('+')}` : ''
    })`;
  });

  const user = [
    'Available models:',
    ...lines,
    '',
    'Incoming request:',
    `- estimated tokens: ${summary.tokenEstimate}`,
    `- has system prompt: ${summary.hasSystem ? 'yes' : 'no'}`,
    `- tools: ${summary.toolCount}`,
    `- last user message: ${summary.lastUserExcerpt || '(empty)'}`,
    '',
    'Pick the best model id for this request.',
    'Answer with a JSON object whose "model_id" is one of the ids listed above.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user: strict ? `${user}${STRICT_SUFFIX}` : user };
}

/**
 * Parse the router's answer.
 *
 * The prompt asks for JSON, but models wrap it in prose or a code fence often
 * enough that a strict `JSON.parse` would throw away a perfectly good answer.
 * The parser therefore tries the whole string, then the first `{...}` block,
 * then gives up.
 */
export function parseRouterDecision(text: string): { modelId: string; reason: string } | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { model_id?: unknown; reason?: unknown };
      const modelId = typeof parsed?.model_id === 'string' ? parsed.model_id.trim() : '';
      if (!modelId) continue;
      const reason = typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 500) : '';
      return { modelId, reason };
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Read the router's answer text out of an OpenAI, Anthropic or Google body. */
export function extractRouterText(body: unknown): string | null {
  const root = asRecord(body);
  if (!root) return null;

  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = asRecord(asRecord(choices[0])?.message);
    const content = message?.content;
    if (typeof content === 'string') return content;
  }

  const content = root.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const typed = asRecord(part);
        return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
      })
      .filter(Boolean)
      .join('');
    if (text) return text;
  }

  const candidates = root.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const parts = asRecord(asRecord(candidates[0])?.content)?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          const typed = asRecord(part);
          return typeof typed?.text === 'string' ? typed.text : '';
        })
        .filter(Boolean)
        .join('');
      if (text) return text;
    }
  }

  return null;
}

/** Read the token usage out of an OpenAI, Anthropic or Google body. */
export function extractRouterUsage(body: unknown): { inputTokens: number; outputTokens: number } {
  const root = asRecord(body);
  const usage = asRecord(root?.usage);
  if (usage) {
    const input = usage.prompt_tokens ?? usage.input_tokens;
    const output = usage.completion_tokens ?? usage.output_tokens;
    if (typeof input === 'number' || typeof output === 'number') {
      return {
        inputTokens: typeof input === 'number' ? input : 0,
        outputTokens: typeof output === 'number' ? output : 0,
      };
    }
  }

  const metadata = asRecord(root?.usageMetadata);
  if (metadata) {
    const input = metadata.promptTokenCount;
    const output = metadata.completionTokenCount;
    return {
      inputTokens: typeof input === 'number' ? input : 0,
      outputTokens: typeof output === 'number' ? output : 0,
    };
  }

  return { inputTokens: 0, outputTokens: 0 };
}
````

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.prompt.spec.ts`
Expected: PASS (20 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routing/smart-router/smart-router.prompt.ts \
  packages/backend/src/routing/smart-router/smart-router.types.ts \
  packages/backend/src/routing/smart-router/__tests__/smart-router.prompt.spec.ts
git commit -m "feat: add Smart Router meta-prompt and answer parser"
```

---

## Task 6: Circuit breaker

**Files:**

- Create: `packages/backend/src/routing/smart-router/smart-router.circuit-breaker.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.circuit-breaker'`.

- [ ] **Step 3: Write the breaker**

Create `packages/backend/src/routing/smart-router/smart-router.circuit-breaker.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routing/smart-router/smart-router.circuit-breaker.ts \
  packages/backend/src/routing/smart-router/__tests__/smart-router.circuit-breaker.spec.ts
git commit -m "feat: add Smart Router circuit breaker"
```

---

## Task 7: `TierService.findTierForModel()`

**Files:**

- Modify: `packages/backend/src/routing/routing-core/tier.service.ts`
- Modify: `packages/backend/src/routing/routing-core/__tests__/tier.service.spec.ts`

The Smart Router picks a _model_. The existing fallback chain is configured per _tier_. So the resolver has to know which tier the picked model belongs to, and carry that tier's fallbacks forward — otherwise a Smart Router pick would silently lose the operator's configured fallback chain.

- [ ] **Step 1: Write the failing test**

The spec already exists: `packages/backend/src/routing/routing-core/__tests__/tier.service.spec.ts` (the repo keeps unit specs under `__tests__/`). Add a `describe('findTierForModel')` block to it, next to the other `TierService` cases. The instance in that file is named `svc`, not `service`.

```ts
describe('findTierForModel', () => {
  it('returns the tier that names the model and its fallbacks', async () => {
    const route = { provider: 'openai', authType: 'api_key' as const, model: 'gpt-4o' };
    tierRepo.find.mockResolvedValue([
      {
        agent_id: 'agent-1',
        tier: 'complex',
        override_route: route,
        auto_assigned_route: null,
        fallback_routes: [{ provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet-4' }],
      },
    ]);

    const found = await svc.findTierForModel('agent-1', route);
    expect(found?.tier).toBe('complex');
    expect(found?.fallback_routes).toHaveLength(1);
  });

  it('matches on provider, auth type and model regardless of the key label', async () => {
    const route = { provider: 'openai', authType: 'api_key' as const, model: 'gpt-4o' };
    tierRepo.find.mockResolvedValue([
      {
        agent_id: 'agent-1',
        tier: 'complex',
        override_route: { ...route, keyLabel: 'Work' },
        auto_assigned_route: null,
        fallback_routes: null,
      },
    ]);

    const found = await svc.findTierForModel('agent-1', route);
    expect(found?.tier).toBe('complex');
  });

  it('falls back to the auto-assigned route when there is no override', async () => {
    const route = { provider: 'openai', authType: 'api_key' as const, model: 'gpt-4o' };
    tierRepo.find.mockResolvedValue([
      {
        agent_id: 'agent-1',
        tier: 'standard',
        override_route: null,
        auto_assigned_route: route,
        fallback_routes: null,
      },
    ]);

    expect((await svc.findTierForModel('agent-1', route))?.tier).toBe('standard');
  });

  it('returns null when no tier names the model', async () => {
    tierRepo.find.mockResolvedValue([]);
    expect(
      await svc.findTierForModel('agent-1', {
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-4o',
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/routing-core/__tests__/tier.service.spec.ts`
Expected: FAIL — `svc.findTierForModel is not a function`.

- [ ] **Step 4: Implement the helper**

In `packages/backend/src/routing/routing-core/tier.service.ts`, add after `getFallbacks`:

```ts
  /**
   * Which tier names this model, and what fallbacks does that tier carry?
   *
   * The Smart Router picks a model; the fallback chain is configured per tier.
   * Resolving the picked model back to its tier lets the Smart Router hand the
   * existing chain forward unchanged, so a Smart Router pick behaves exactly
   * like a scorer pick with respect to fallbacks.
   *
   * The comparison is on (provider, authType, model) and deliberately ignores
   * the key label: a tier that pins a model to one connection still counts as
   * "the tier for that model". Returns null when no tier names it.
   */
  async findTierForModel(
    agentId: string,
    route: ModelRoute,
  ): Promise<{ tier: TierSlot; fallback_routes: ModelRoute[] | null } | null> {
    const rows = await this.tierRepo.find({ where: { agent_id: agentId } });
    const matches = (candidate: ModelRoute | null): boolean =>
      candidate !== null &&
      candidate.provider.toLowerCase() === route.provider.toLowerCase() &&
      candidate.authType === route.authType &&
      candidate.model === route.model;

    for (const row of rows) {
      if (matches(readOverrideRoute(row)) || matches(readAutoAssignedRoute(row))) {
        return {
          tier: row.tier as TierSlot,
          fallback_routes: readFallbackRoutes(row),
        };
      }
    }
    return null;
  }
```

**Add the missing imports.** `tier.service.ts` currently imports only `{ effectiveRoute, readFallbackRoutes, routeMatches }` from `./route-helpers`. Extend that import to:

```ts
import {
  effectiveRoute,
  readAutoAssignedRoute,
  readFallbackRoutes,
  readOverrideRoute,
  routeMatches,
} from './route-helpers';
```

`TierSlot` is already imported from `manifest-shared` in this file (it is used by `resolveForTier`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/routing-core/__tests__/tier.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routing/routing-core/tier.service.ts \
  packages/backend/src/routing/routing-core/__tests__/tier.service.spec.ts
git commit -m "feat: resolve the tier that owns a Smart Router pick"
```

---

## Task 8: `SmartRouterService` — the decision engine

**Files:**

- Modify: `packages/shared/src/error-taxonomy.ts`
- Create: `packages/backend/src/routing/smart-router/smart-router.service.ts`
- Create: `packages/backend/src/routing/smart-router/smart-router.module.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.service.spec.ts`

This is the heart of the feature. Read the four steps carefully — the service owns the whole decision, including the recording of the router hop.

- [ ] **Step 1: Extend the shared error taxonomy**

The Smart Router's failure modes are error classes like any other. Add them to `packages/shared/src/error-taxonomy.ts`:

```ts
export const ERROR_CLASSES = [
  // provider (HTTP-derived)
  'rate_limit',
  'auth',
  'invalid_request',
  'not_found',
  'payload_too_large',
  'billing',
  'server_error',
  'client_error',
  // transport
  'timeout',
  'network',
  // manifest (config / policy / internal / request)
  'no_provider',
  'no_provider_key',
  'subscription_credentials_unusable',
  'local_provider_unavailable',
  'limit_exceeded',
  'plan_request_limit_limit_exceeded',
  'internal',
  // smart router — only ever set on the router's own attempt row
  'router_timeout',
  'router_failure',
  'router_invalid_response',
  'router_unknown_model',
  'router_no_credentials',
] as const;
```

> **Careful:** the list above shows `plan_request_limit_limit_exceeded` only as a transcription hazard — the real entry in the file is `plan_request_limit_exceeded`. Copy the existing entries verbatim and **append** the five `router_*` classes at the end. Do not retype the existing list.

Run: `cd packages/shared && npx jest --silent`
Expected: PASS. The Messages-log `error_class` filter (`MessagesQueryDto`, `@IsIn(ERROR_CLASSES)`) now accepts the router classes too.

- [ ] **Step 2: Write the failing service test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.service.spec.ts`. The harness below is shared by every case:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SmartRouterService } from '../smart-router.service';
import { SmartRouterCache } from '../smart-router.cache';
import { SmartRouterCircuitBreaker } from '../smart-router.circuit-breaker';
import { Agent } from '../../../entities/agent.entity';
import { AgentMessage } from '../../../entities/agent-message.entity';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { ProviderKeyService } from '../../routing-core/provider-key.service';
import { TierService } from '../../routing-core/tier.service';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { ProviderClient } from '../../proxy/provider-client';
import { RoutingCacheService } from '../../routing-core/routing-cache.service';
import { NotFoundException } from '@nestjs/common';

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
  let agentRepo: { findOne: jest.Mock };
  let messageRepo: { insert: jest.Mock; update: jest.Mock };
  let discovery: { getModelsForAgent: jest.Mock };
  let providerKeys: { selectProviderKey: jest.Mock; hasRouteCredentials: jest.Mock };
  let tierService: { findTierForModel: jest.Mock };
  let pricingCache: { getByModel: jest.Mock };
  let providerClient: { forward: jest.Mock };
  let routingCache: { addInvalidationListener: jest.Mock };

  const attemptContext = {
    agentName: 'demo',
    userId: null,
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
        {
          provide: SmartRouterCircuitBreaker,
          useFactory: () => new SmartRouterCircuitBreaker(),
        },
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

  // ...cases appended below
});
```

`SmartRouterCache` and `SmartRouterCircuitBreaker` are registered with `useFactory`, **not** as plain classes: their constructors take primitive `number`/`boolean` parameters, and Nest would try to inject `Number` as a dependency. The factory form keeps the constructor parameters available for unit tests while letting the module build them with their defaults.

```ts
{ provide: SmartRouterCache, useFactory: () => new SmartRouterCache() },
{ provide: SmartRouterCircuitBreaker, useFactory: () => new SmartRouterCircuitBreaker() },
```

Because they are `useFactory` providers, the unit test must register them the same way (see the providers array above). They do **not** need `@Injectable()`.

Now append the behavioural cases to the `describe` block:

```ts
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

  it('serves a repeated identical request from the cache without calling the model again', async () => {
    await service.decide(input);
    await service.decide(input);
    expect(providerClient.forward).toHaveBeenCalledTimes(1);
    expect(messageRepo.update).toHaveBeenCalledTimes(1);
  });

  it('falls back to scoring when the router times out', async () => {
    providerClient.forward.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
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
    providerClient.forward.mockResolvedValue({
      response: jsonResponse({ choices: [{ message: { content: 'I pick gpt-4o-mini' } }] }),
    });
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

  it('opens the circuit breaker after three consecutive failures', async () => {
    providerClient.forward.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
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
```

> These cases are not optional: `CLAUDE.md` makes **100 % line coverage on new files** a hard CI gate, and `getConfig()`, `updateConfig()`, `lastDecisionAt()`, `agentRoute()` and the three early-return branches of `supportsJsonMode()` are otherwise never executed (the controller spec mocks the service wholesale).

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.service.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.service'`.

- [ ] **Step 4: Write the service**

Create `packages/backend/src/routing/smart-router/smart-router.service.ts`:

```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType, ModelRoute, TierSlot } from 'manifest-shared';
import { DEFAULT_OUTPUT_MODALITY, DEFAULT_RESPONSE_MODE } from 'manifest-shared';
import { Agent } from '../../entities/agent.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ProviderKeyService } from '../routing-core/provider-key.service';
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
    if (!agent.smart_router_provider || !agent.smart_router_model || !agent.smart_router_auth_type) {
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
      const catalog = (await this.discoveryService.getModelsForAgent(input.tenantId, agent.id))
        .filter((model) => !!model.authType);
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

      attempt = input.attempt.startProviderAttempt({
        provider: routerRoute.provider,
        model: routerRoute.model,
        authType: routerRoute.authType,
        tenantProviderId: key?.id ?? null,
        keyLabel: key?.label,
      });

      if (!key?.apiKey) {
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind: 'router_no_credentials',
          detail: 'the configured router model has no usable credential',
          latencyMs: 0,
          routerRoute,
          keyLabel: key?.label ?? null,
          tenantProviderId: key?.id ?? null,
        });
        this.breaker.recordFailure();
        return null;
      }

      const prompt = buildRouterPrompt(candidates, summary);
      let outcome = await this.forward(
        routerRoute,
        key.apiKey,
        prompt,
        input.attempt?.signal,
      );

      let parsed: { modelId: string; reason: string } | null = null;
      if (outcome.ok) {
        parsed = parseRouterDecision(outcome.text);
        if (!parsed) {
          // One retry with a stricter prompt — models often wrap the JSON in
          // prose the first time.
          const retry = await this.forward(
            routerRoute,
            key.apiKey,
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
        const kind: RouterFailureKind =
          outcome.ok || outcome.kind === 'router_timeout'
            ? 'router_invalid_response'
            : outcome.kind;
        await this.recordRouterRow(input, attempt, {
          ok: false,
          kind,
          detail: outcome.ok ? 'the router answer could not be parsed' : outcome.detail,
          latencyMs: outcome.latencyMs,
          routerRoute,
          keyLabel: key.label ?? null,
          tenantProviderId: key.id ?? null,
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
          tenantProviderId: key.id ?? null,
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
          tenantProviderId: key.id ?? null,
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
        tenantProviderId: key.id ?? null,
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
          tenantProviderId: key?.id ?? null,
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
        return { ok: false, kind: 'router_timeout', detail: 'the router call timed out', latencyMs };
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
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`;

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
    if (!agent?.smart_router_provider || !agent.smart_router_model || !agent.smart_router_auth_type) {
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
```

- [ ] **Step 5: Leave the cache and breaker as plain classes**

`SmartRouterCache` and `SmartRouterCircuitBreaker` stay plain classes with no Nest decorator. They are registered with `useFactory` (see the module below), which is what keeps Nest from trying to inject their primitive constructor parameters.

- [ ] **Step 6: Write the module**

Create `packages/backend/src/routing/smart-router/smart-router.module.ts`:

```ts
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
import { SmartRouterService } from './smart-router.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Agent, AgentMessage]),
    RoutingCoreModule,
    ModelDiscoveryModule,
    ModelPricesModule,
  ],
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
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.service.spec.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole backend suite**

Run: `cd packages/backend && npx jest --silent`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/error-taxonomy.ts \
  packages/backend/src/routing/smart-router/
git commit -m "feat: add the Smart Router decision engine"
```

---

## Task 9: Wire the Smart Router into the resolver

**Files:**

- Modify: `packages/backend/src/routing/resolve/resolve.service.ts`
- Modify: `packages/backend/src/routing/resolve/resolve.module.ts`
- Modify: `packages/backend/src/routing/dto/resolve-response.ts`
- Modify: `packages/backend/src/routing/resolve/__tests__/resolve.service.spec.ts`
- Modify: `packages/backend/src/routing/resolve/__tests__/resolve.service.edge.spec.ts`

The resolver is where routing is decided, so the Smart Router belongs here. The dispatch must be inserted so that:

- the header-tier early return still wins outright (B2);
- an active specificity category still wins (B3);
- an agent with complexity routing **off** and the Smart Router **off** takes exactly today's path, with no extra query and no extra work (B1).

- [ ] **Step 1: Update the two existing resolver specs for the new constructor argument**

`ResolveService` gains a tenth constructor parameter, so the two specs that build it positionally stop compiling:

- `packages/backend/src/routing/resolve/__tests__/resolve.service.spec.ts` (the `new ResolveService(…)` call in its `beforeEach`)
- `packages/backend/src/routing/resolve/__tests__/resolve.service.edge.spec.ts` (the same)

In both, add a mock and pass it as the **last** argument:

```ts
const smartRouterService = {
  decide: jest.fn().mockResolvedValue(null),
} as unknown as SmartRouterService;
```

```ts
svc = new ResolveService(
  tierService as unknown as TierService,
  providerKeyService as unknown as ProviderKeyService,
  specificityService as unknown as SpecificityService,
  pricingCache as unknown as ModelPricingCacheService,
  discoveryService as unknown as ModelDiscoveryService,
  penaltyService as unknown as SpecificityPenaltyService,
  headerTierService as unknown as HeaderTierService,
  agentRepo as unknown as Repository<Agent>,
  routingCache as unknown as RoutingCacheService,
  smartRouterService,
);
```

Add the import:

```ts
import { SmartRouterService } from '../../smart-router/smart-router.service';
```

The existing specs' `agentRepo.findOne` mock returns `{ id: 'agent-1', complexity_routing_enabled: true }` — no `smart_router_enabled`, so the Smart Router stays off and the existing expectations are unchanged.

- [ ] **Step 2: Write the failing resolver test**

Add a new `describe` block to the **existing** `packages/backend/src/routing/resolve/__tests__/resolve.service.spec.ts` (the repo keeps resolver specs under `__tests__/`; do not create a second file with the same name). The block needs its own instances because the file's `beforeEach` is shared:

```ts
describe('ResolveService — Smart Router dispatch', () => {
  let smartRouter: { decide: jest.Mock };
  let smartRouterService: ResolveService;
  let agentRepo: { findOne: jest.Mock };
  let specificityService: { getActiveAssignments: jest.Mock };
  let headerTierService: { list: jest.Mock };
  let tierService: { getTiers: jest.Mock };

  const baseAgent = {
    id: 'agent-1',
    name: 'demo',
    complexity_routing_enabled: false,
    smart_router_enabled: false,
  };

  const attempt = { agentName: 'demo', userId: null, startProviderAttempt: jest.fn() };

  beforeEach(() => {
    smartRouter = { decide: jest.fn().mockResolvedValue(null) };
    agentRepo = { findOne: jest.fn().mockResolvedValue(baseAgent) };
    specificityService = { getActiveAssignments: jest.fn().mockResolvedValue([]) };
    headerTierService = { list: jest.fn().mockResolvedValue([]) };
    tierService = {
      getTiers: jest.fn().mockResolvedValue([
        {
          agent_id: 'agent-1',
          tier: 'default',
          override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
          auto_assigned_route: null,
          fallback_routes: null,
        },
      ]),
    };

    smartRouterService = new ResolveService(
      tierService as unknown as TierService,
      {
        isRouteAvailable: jest.fn().mockResolvedValue(true),
        hasRouteCredentials: jest.fn().mockResolvedValue(true),
        getDefaultKeyLabel: jest.fn().mockResolvedValue('Default'),
        getAuthType: jest.fn().mockResolvedValue('api_key'),
      } as unknown as ProviderKeyService,
      specificityService as unknown as SpecificityService,
      {} as unknown as ModelPricingCacheService,
      {} as unknown as ModelDiscoveryService,
      {
        getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()),
      } as unknown as SpecificityPenaltyService,
      headerTierService as unknown as HeaderTierService,
      agentRepo as unknown as Repository<Agent>,
      {
        addInvalidationListener: jest.fn(),
        addTenantInvalidationListener: jest.fn(),
      } as unknown as RoutingCacheService,
      { decide: smartRouter.decide } as unknown as SmartRouterService,
    );
  });

  it('never asks the Smart Router when the agent has it off', async () => {
    await smartRouterService.resolveLazy('agent-1', 'tenant-1', async () => ({ messages: [] }));
    expect(smartRouter.decide).not.toHaveBeenCalled();
  });

  it('asks the Smart Router when the agent has it on', async () => {
    agentRepo.findOne.mockResolvedValue({ ...baseAgent, smart_router_enabled: true });
    await smartRouterService.resolveLazy(
      'agent-1',
      'tenant-1',
      async () => ({ messages: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      attempt,
    );
    expect(smartRouter.decide).toHaveBeenCalledTimes(1);
  });

  it('returns the Smart Router decision as the resolved route', async () => {
    agentRepo.findOne.mockResolvedValue({ ...baseAgent, smart_router_enabled: true });
    smartRouter.decide.mockResolvedValue({
      route: { provider: 'anthropic', authType: 'api_key', model: 'claude-opus-4-6' },
      reason: 'needs reasoning',
      tier: 'complex',
      fallback_routes: [{ provider: 'openai', authType: 'api_key', model: 'gpt-4o' }],
      output_modality: 'text',
      response_mode: 'buffered',
      routerProvider: 'openai',
      routerModel: 'gpt-4o-mini',
      routerAuthType: 'api_key',
      routerKeyLabel: null,
      routerTenantProviderId: null,
      latencyMs: 120,
    });

    const resolved = await smartRouterService.resolveLazy(
      'agent-1',
      'tenant-1',
      async () => ({ messages: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      attempt,
    );

    expect(resolved.reason).toBe('smart_router');
    expect(resolved.tier).toBe('complex');
    expect(resolved.route?.model).toBe('claude-opus-4-6');
    expect(resolved.fallback_routes).toHaveLength(1);
    expect(resolved.smart_router_reason).toBe('needs reasoning');
    expect(resolved.smart_router_model).toBe('gpt-4o-mini');
  });

  it('falls through to the default tier when the Smart Router declines', async () => {
    agentRepo.findOne.mockResolvedValue({ ...baseAgent, smart_router_enabled: true });
    smartRouter.decide.mockResolvedValue(null);
    const resolved = await smartRouterService.resolveLazy(
      'agent-1',
      'tenant-1',
      async () => ({ messages: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      attempt,
    );
    expect(resolved.reason).toBe('default');
    expect(resolved.route?.model).toBe('gpt-4o');
  });

  it('lets a matching header tier win over the Smart Router', async () => {
    agentRepo.findOne.mockResolvedValue({ ...baseAgent, smart_router_enabled: true });
    headerTierService.list.mockResolvedValue([
      {
        id: 'ht-1',
        name: 'Support',
        enabled: true,
        header_key: 'x-support',
        header_value: '1',
        badge_color: null,
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
        fallback_routes: null,
        output_modality: 'text',
        response_mode: 'buffered',
      },
    ]);
    const resolved = await smartRouterService.resolveLazy(
      'agent-1',
      'tenant-1',
      async () => ({ messages: [] }),
      undefined,
      undefined,
      undefined,
      { 'x-support': '1' },
      attempt,
    );
    expect(resolved.reason).toBe('header-match');
    expect(smartRouter.decide).not.toHaveBeenCalled();
  });

  it('lets an active specificity category win over the Smart Router', async () => {
    agentRepo.findOne.mockResolvedValue({
      ...baseAgent,
      complexity_routing_enabled: true,
      smart_router_enabled: true,
    });
    specificityService.getActiveAssignments.mockResolvedValue([
      {
        agent_id: 'agent-1',
        category: 'coding',
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
        fallback_routes: null,
      },
    ]);
    // The file's mocked scanMessages returns null by default; make it detect.
    (scanMessages as unknown as jest.Mock).mockReturnValue({
      category: 'coding',
      confidence: 0.9,
    });

    const resolved = await smartRouterService.resolveLazy(
      'agent-1',
      'tenant-1',
      async () => ({ messages: [{ role: 'user', content: 'refactor this function' }] }),
      undefined,
      undefined,
      undefined,
      undefined,
      attempt,
    );

    expect(resolved.reason).toBe('specificity');
    expect(smartRouter.decide).not.toHaveBeenCalled();
  });

  it('never asks the Smart Router on the resolve probe (no attempt context)', async () => {
    agentRepo.findOne.mockResolvedValue({ ...baseAgent, smart_router_enabled: true });
    await smartRouterService.resolveLazy('agent-1', 'tenant-1', async () => ({ messages: [] }));
    expect(smartRouter.decide).not.toHaveBeenCalled();
  });
});
```

> **Reuse the file's existing mocks where they fit.** The block above declares its own for clarity, but the file already has a `providerKeyService` mock and a `scanMessages` mock (`mockedScan`) at the top of the file, and reusing them keeps the two sets from drifting.
>
> Two things are load-bearing:
>
> - The `ProviderKeyService` mock must carry **every method the resolver calls**: `isRouteAvailable`, `hasRouteCredentials`, `getDefaultKeyLabel` and `getAuthType`. `enrichRouteKeyLabel()` calls `getDefaultKeyLabel()` on every route-resolution path, so a mock missing it throws a `TypeError` in six of the seven cases above. The file's own mock already has all of them — reuse it rather than the near-copy, and make sure `getDefaultKeyLabel` resolves to the same value the file uses.
> - The specificity case makes `mockedScan` return a detection. Restore it to `null` afterwards (in an `afterEach`) so the file's other cases are unaffected.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/resolve/__tests__/resolve.service.spec.ts src/routing/resolve/__tests__/resolve.service.edge.spec.ts`
Expected: FAIL — `decide` is never called, and the new resolver cases are missing.

- [ ] **Step 4: Extend `ResolveResponse`**

In `packages/backend/src/routing/dto/resolve-response.ts`, add three optional fields before the closing brace:

```ts
  /**
   * The Smart Router's own explanation for its pick. Present only when the
   * request was routed by the Smart Router (`reason === 'smart_router'`).
   */
  smart_router_reason?: string;
  /** The model that RAN the router — not the model the router picked. */
  smart_router_provider?: string;
  /** The model that RAN the router — not the model the router picked. */
  smart_router_model?: string;
```

- [ ] **Step 5: Dispatch in `resolveLazy`**

In `packages/backend/src/routing/resolve/resolve.service.ts`:

1. Add the import:

```ts
import { SmartRouterService } from '../smart-router/smart-router.service';
import type { SmartRouterAttemptContext } from '../smart-router/smart-router.types';
```

2. Add the constructor dependency (after `private readonly routingCache: RoutingCacheService,`). Step 1 already updated the two existing specs that build the service positionally — without that, they do not compile:

```ts
    private readonly smartRouterService: SmartRouterService,
```

3. Add the optional parameter to `resolveLazy` and to `resolve` (which forwards to `resolveLazy`):

```ts
  async resolveLazy(
    agentId: string,
    tenantId: string,
    resolveInput: () => Promise<ScorerInput>,
    recentTiers?: MomentumInput['recentTiers'],
    specificityOverride?: string,
    recentCategories?: readonly SpecificityCategory[],
    headers?: IncomingHttpHeaders,
    attempt?: SmartRouterAttemptContext,
  ): Promise<ResolveResponse> {
```

4. **Replace** the whole region that starts at `const agent = await this.agentRepo.findOne({ where: { id: agentId } });` and ends just before `const input: ScorerInput = { messages, tools, tool_choice: toolChoice, max_tokens: maxTokens };` with the following. The old early return `if (agent && !agent.complexity_routing_enabled) { return this.resolveForTier(...); }` and the old `const specificityResult = await this.resolveSpecificity(...)` block live inside that region and disappear with it:

```ts
const agent = await this.agentRepo.findOne({ where: { id: agentId } });
const complexityOn = !agent || agent.complexity_routing_enabled;
// The Smart Router only ever runs for an agent that opted in. For every
// other agent this line is false and the code below is byte-for-byte the
// path it always took.
const smartRouterOn = agent?.smart_router_enabled === true;

if (!smartRouterOn && !complexityOn) {
  return this.resolveForTier(agentId, tenantId, 'default', 'default');
}

const { messages, tools, tool_choice: toolChoice, max_tokens: maxTokens } = await resolveInput();

// Specificity is only consulted for agents with complexity routing on —
// exactly as before. When it matches, it wins over the Smart Router.
if (complexityOn) {
  const specificityResult = await this.resolveSpecificity(
    agentId,
    tenantId,
    messages,
    tools,
    specificityOverride,
    recentCategories,
  );
  if (specificityResult) return specificityResult;
}

// The attempt context is what makes the hop recordable, so its absence
// (the resolve probe) skips the Smart Router entirely — not even the
// service is called.
if (smartRouterOn && attempt?.startProviderAttempt) {
  const decision = await this.smartRouterService.decide({
    agent,
    tenantId,
    agentName: attempt?.agentName ?? agent?.name ?? '',
    userId: attempt?.userId ?? null,
    messages,
    tools,
    attempt,
  });
  if (decision) {
    // Every other resolution path (header tier, specificity, scoring)
    // enriches the route with the connection's key label, so a multi-key
    // harness bills the same connection whichever path routed it. The
    // Smart Router's route must do the same.
    const enriched = await this.enrichRouteKeyLabel(agentId, tenantId, decision.route);
    return {
      tier: decision.tier,
      route: enriched,
      fallback_routes: decision.fallback_routes,
      output_modality: decision.output_modality,
      response_mode: decision.response_mode,
      confidence: 1,
      score: 0,
      reason: 'smart_router',
      smart_router_reason: decision.reason,
      smart_router_provider: decision.routerProvider,
      smart_router_model: decision.routerModel,
    };
  }
}

if (!complexityOn) {
  return this.resolveForTier(agentId, tenantId, 'default', 'default');
}
```

5. Confirm the region was replaced, not duplicated. The file must now contain **one** `const agent = await this.agentRepo.findOne(...)` and **one** `const specificityResult = await this.resolveSpecificity(...)` in `resolveLazy`. The scoring code that follows the replaced region (`const input: ScorerInput = ...`, the `scoreRequest` call, the tier lookup) stays exactly as it is.

> `decision.tier` is typed `TierSlot` (see Task 8's types file) and `TierService.findTierForModel` casts the `tier_assignments.tier` value to it. If TypeScript still complains, cast at the return site with `decision.tier as TierSlot` — `TierSlot` is already imported from `manifest-shared` in this file.

- [ ] **Step 6: Register the module**

In `packages/backend/src/routing/resolve/resolve.module.ts`, add the import and the module:

```ts
import { SmartRouterModule } from '../smart-router/smart-router.module';
```

```ts
  imports: [
    OtlpModule,
    RoutingCoreModule,
    ModelPricesModule,
    ModelDiscoveryModule,
    SmartRouterModule,
    forwardRef(() => HeaderTiersModule),
  ],
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/resolve/__tests__/resolve.service.spec.ts src/routing/resolve/__tests__/resolve.service.edge.spec.ts`
Expected: PASS — the seven new "Smart Router dispatch" cases, plus the file's existing cases, unchanged.

- [ ] **Step 8: Run the whole backend suite**

Run: `cd packages/backend && npx jest --silent`
Expected: PASS. Nothing existing changes behaviour, because `smart_router_enabled` defaults to `false` and the extra `agentRepo.findOne` is the call the resolver already made.

- [ ] **Step 9: Commit**

```bash
git add packages/backend/src/routing/resolve/ \
  packages/backend/src/routing/dto/resolve-response.ts
git commit -m "feat: route through the Smart Router when a harness opts in"
```

---

## Task 10: Pass the attempt context from the proxy

**Files:**

- Modify: `packages/backend/src/routing/proxy/proxy.service.ts`

The resolver needs three things the proxy already has: the attempt factory (so the router hop becomes a real Provider Attempt with the right `request_id` and `attempt_number`), the agent name, and the user id.

- [ ] **Step 1: Write the failing test**

Add to `packages/backend/src/routing/proxy/__tests__/proxy.service.spec.ts`. That spec mocks `ResolveService` wholesale — `resolveLazy: jest.fn(async (agentId, tenantId, resolveInput, ...rest) => …)` — so the test must assert on the **call the resolver received**, not on the Smart Router service (which the mock never touches).

```ts
it('hands the resolver an attempt context that carries the attempt factory', async () => {
  resolveService.resolve.mockResolvedValue({
    tier: 'standard',
    route: route('openai', 'api_key', 'gpt-4o'),
    fallback_routes: null,
    confidence: 0.9,
    score: 5,
    reason: 'scored',
  });
  // The provider forward has to be mocked too: the default
  // `fallbackService.tryForwardToProvider` is a bare jest.fn() that
  // returns undefined, and the proxy reads `forward.attempt` off the
  // result.
  fallbackService.tryForwardToProvider.mockResolvedValue({
    response: okResponse(200),
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
  });
  const startProviderAttempt = jest.fn(() => ({
    id: 'attempt-1',
    attemptNumber: 1,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    pendingWrite: Promise.resolve(true),
  }));

  await svc.proxyRequest(baseOpts({ startProviderAttempt, requestId: 'req-1' }));

  const call = (resolveService.resolveLazy as jest.Mock).mock.calls.at(-1);
  // resolveLazy(agentId, tenantId, resolveInput, recentTiers,
  //             specificityOverride, recentCategories, headers, attempt)
  const attemptContext = call?.[7];
  expect(attemptContext).toEqual(
    expect.objectContaining({
      agentName: 'demo-agent',
      userId: 'user-1',
      requestId: 'req-1',
      startProviderAttempt,
    }),
  );
});
```

> `route()` and `baseOpts()` are helpers the file already defines; `resolveService.resolve.mockResolvedValue(...)` is how the other cases in that file make the resolver return a route.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/proxy/__tests__/proxy.service.spec.ts`
Expected: FAIL — the resolver is called with seven arguments, not eight.

- [ ] **Step 3: Thread the context through `resolveRouting`**

In `packages/backend/src/routing/proxy/proxy.service.ts`:

1. Extend `RoutingMeta` (the interface at the top of the file) with:

```ts
  /** The Smart Router's own explanation, when the request was routed by it. */
  smart_router_reason?: string;
  /** The model that RAN the Smart Router. */
  smart_router_provider?: string;
  /** The model that RAN the Smart Router. */
  smart_router_model?: string;
```

2. Add the parameter to `resolveRouting`:

```ts
  private async resolveRouting(
    agentId: string,
    tenantId: string,
    body: ProxyRequestOptions['body'],
    resolveChatBody: ResolveChatBody | undefined,
    sessionMomentumKey: string | undefined,
    specificityOverride: ProxyRequestOptions['specificityOverride'],
    headers: ProxyRequestOptions['headers'],
    apiMode: ProxyApiMode,
    attemptContext?: SmartRouterAttemptContext,
  ): Promise<ResolvedRouting> {
```

3. Pass it into `resolveLazy` (the `this.resolveService.resolveLazy(...)` call inside `resolveRouting`) as the eighth argument. The other call site of `resolveRouting` — `forwardResolvedHealed`, the Autofix re-forward path — passes nothing: the healed retry must re-use the route that was already resolved, not ask the router a second time. Because the new parameter is optional, that call site needs no change.

```ts
          recentTiers,
          specificityOverride,
          recentCategories,
          headers,
          attemptContext,
        ));
```

4. Build the context at the call site in `proxyRequest` and pass it to `resolveRouting`:

```ts
const smartRouterAttempt: SmartRouterAttemptContext | undefined = startProviderAttempt
  ? {
      agentName: agentName ?? '',
      userId: opts.userId ?? null,
      startProviderAttempt,
      requestId: opts.requestId,
      // The raw request messages, before the scoring filter strips the
      // system/developer roles and slices the tail.
      rawMessages: Array.isArray(body.messages) ? body.messages : undefined,
      signal: opts.signal,
    }
  : undefined;

const resolved = await this.resolveRouting(
  agentId,
  tenantId,
  routingSource,
  resolveRoutingChatBody,
  sessionMomentumKey,
  specificityOverride,
  headers,
  apiMode,
  smartRouterAttempt,
);
```

5. Add the import:

```ts
import type { SmartRouterAttemptContext } from '../smart-router/smart-router.types';
```

6. Add the request id to the proxy's options, and set it in the controller.

In `packages/backend/src/routing/proxy/proxy-types.ts`, add to `ProxyRequestOptions`:

```ts
  /**
   * The parent Manifest Request's id. The controller mints it before routing
   * and records the pending Request under it. The Smart Router hop needs it so
   * its Provider Attempt joins the same request.
   */
  requestId?: string;
```

In `packages/backend/src/routing/proxy/proxy.controller.ts`, the controller already mints `requestId` (line 250) and passes it to `recordPendingRequest`. Add it to the `proxyService.proxyRequest({ … })` call:

```ts
        await this.proxyService.proxyRequest({
          agentId: req.ingestionContext.agentId,
          tenantId,
          requestId,
          ...
```

6. Forward the new meta fields in `buildBaseMeta` (in `packages/backend/src/routing/proxy/proxy.service.ts`):

```ts
      smart_router_reason: resolved.smart_router_reason,
      smart_router_provider: resolved.smart_router_provider,
      smart_router_model: resolved.smart_router_model,
```

7. Surface the router in a response header, so a caller can see which model made the choice. In `packages/backend/src/routing/proxy/proxy-response-handler.ts`, extend `buildMetaHeaders()`:

```ts
if (meta.smart_router_model) {
  headers['X-Manifest-Smart-Router-Model'] = meta.smart_router_model;
}
```

Only the model name goes into a header — the router's free-text reason stays in the database, because a header value must be a safe ASCII token and a model's reason is not.

- [ ] **Step 4: Add the client signal to the attempt context**

In `packages/backend/src/routing/smart-router/smart-router.types.ts`, add `signal?: AbortSignal;` to `SmartRouterAttemptContext`. The signal is already honoured inside the service (Task 8 wires it into `forward()`'s `AbortController`), so this step is only about the type and about the proxy populating it:

```ts
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
```

becomes

```ts
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
```

(the call is unchanged — the router's own `AbortController` is already what
`signal` points at; the change is that the caller's signal now aborts it)

(the router's own timeout already aborts `controller`; the caller's signal is honoured by linking it in `forward()` — see the note below)

**The caller's disconnect signal is already wired in Task 8.** `forward()` takes an optional `callerSignal`, links it into its own `AbortController`, and removes the listener in its `finally` block; both call sites inside `decide()` pass `input.attempt?.signal`. Nothing to do here beyond making sure the proxy hands the signal down — which Step 3 does (`signal: opts.signal` in the attempt context).

A caller-side abort is reported as `router_timeout`, which is correct: from Manifest's point of view the hop produced no answer, so the request falls back to scoring routing.

- [ ] **Step 5: Cover the new response header**

The `X-Manifest-Smart-Router-Model` header is a new line in `buildMetaHeaders()`, and `CLAUDE.md` makes 100 % patch coverage a hard gate — so it needs its own test. In `packages/backend/src/routing/proxy/__tests__/proxy.service.spec.ts`:

```ts
it('surfaces the Smart Router model in the response headers', async () => {
  resolveService.resolve.mockResolvedValue({
    tier: 'standard',
    route: route('openai', 'api_key', 'gpt-4o'),
    fallback_routes: null,
    confidence: 1,
    score: 0,
    reason: 'smart_router',
    smart_router_model: 'gpt-4o-mini',
    smart_router_reason: 'needs a small model',
  });
  fallbackService.tryForwardToProvider.mockResolvedValue({
    response: okResponse(200),
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
  });

  const result = await svc.proxyRequest(baseOpts());

  const headers = buildMetaHeaders(result.meta);
  expect(headers['X-Manifest-Smart-Router-Model']).toBe('gpt-4o-mini');
});
```

(`buildMetaHeaders` is exported from `packages/backend/src/routing/proxy/proxy-response-handler.ts`; `okResponse` and `route` are helpers the spec file already defines.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/proxy/__tests__/proxy.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole backend suite**

Run: `cd packages/backend && npx jest --silent`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/routing/proxy/proxy.service.ts \
  packages/backend/src/routing/proxy/proxy-types.ts \
  packages/backend/src/routing/proxy/proxy.controller.ts \
  packages/backend/src/routing/proxy/proxy-response-handler.ts \
  packages/backend/src/routing/smart-router/
git commit -m "feat: hand the Smart Router a provider attempt context"
```

---

## Task 11: REST endpoints

**Files:**

- Create: `packages/backend/src/routing/smart-router/dto/smart-router.dto.ts`
- Create: `packages/backend/src/routing/smart-router/smart-router.controller.ts`
- Create: `packages/backend/src/routing/smart-router/__tests__/smart-router.controller.spec.ts`
- Modify: `packages/backend/src/routing/smart-router/smart-router.module.ts`

- [ ] **Step 1: Write the DTO**

Create `packages/backend/src/routing/smart-router/dto/smart-router.dto.ts`:

```ts
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ModelRouteDto } from '../../dto/routing.dto';

export class UpdateSmartRouterDto {
  /** Master switch for the layer. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * The router model. `null` clears the configured router and turns the layer
   * off (there is nothing to ask without a model).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  model?: ModelRouteDto | null;

  /** Whether the router model is also offered as a candidate for itself. */
  @IsOptional()
  @IsBoolean()
  include_router_in_candidates?: boolean;
}
```

- [ ] **Step 2: Write the failing controller test**

Create `packages/backend/src/routing/smart-router/__tests__/smart-router.controller.spec.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.controller.spec.ts`
Expected: FAIL — `Cannot find module '../smart-router.controller'`.

- [ ] **Step 4: Write the controller**

Create `packages/backend/src/routing/smart-router/smart-router.controller.ts`:

```ts
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
    return this.smartRouterService.getConfig(agent.id, ctx.tenantId);
  }

  @Patch(':agentName/smart-router')
  async updateConfig(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentNameParamDto,
    @Body() body: UpdateSmartRouterDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.smartRouterService.updateConfig(agent.id, ctx.tenantId, {
      enabled: body.enabled,
      // Passed through unchanged: `undefined` means "leave it alone" and
      // `null` means "clear the router model". Coalescing null to undefined
      // here would make it impossible to clear the model.
      model: body.model,
      include_router_in_candidates: body.include_router_in_candidates,
    });
  }
}
```

- [ ] **Step 5: Register the controller**

In `packages/backend/src/routing/smart-router/smart-router.module.ts`, add:

```ts
import { SmartRouterController } from './smart-router.controller';
```

and

```ts
  controllers: [SmartRouterController],
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/routing/smart-router/__tests__/smart-router.controller.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/routing/smart-router/
git commit -m "feat: add the Smart Router configuration endpoints"
```

---

## Task 12: Surface the decision in the analytics layer

**Files:**

- Modify: `packages/backend/src/analytics/services/query-helpers.ts`
- Modify: `packages/backend/src/analytics/services/query-helpers.spec.ts`
- Modify: `packages/backend/src/analytics/controllers/provider-analytics.controller.ts`
- Modify: `packages/backend/src/analytics/controllers/provider-analytics.controller.spec.ts`
- Modify: `packages/backend/src/analytics/services/error-breakdown.service.ts`
- Modify: `packages/backend/src/analytics/services/aggregation.service.ts`
- Modify: `packages/backend/src/analytics/services/aggregation.service.spec.ts`

The Messages log shows one row per Provider Attempt, so the Smart Router's own row shows up there automatically — it just needs the decision columns projected.

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/analytics/services/query-helpers.spec.ts`, add the case **inside the `describe` block that already has `makeMockQb()`** — that helper only exists there, and the file defines several unrelated `makeMockQb` helpers of its own:

```ts
it('projects the Smart Router decision columns', () => {
  const { qb, addSelectCalls } = makeMockQb();
  selectMessageRowColumns(qb, 'cost');

  expect(addSelectCalls.find(([, a]) => a === 'router_decision_provider')).toEqual([
    'at.router_decision_provider',
    'router_decision_provider',
  ]);
  expect(addSelectCalls.find(([, a]) => a === 'router_decision_model')).toEqual([
    'at.router_decision_model',
    'router_decision_model',
  ]);
  expect(addSelectCalls.find(([, a]) => a === 'router_decision_reason')).toEqual([
    'at.router_decision_reason',
    'router_decision_reason',
  ]);
  expect(addSelectCalls.find(([, a]) => a === 'router_decision_latency_ms')).toEqual([
    'at.router_decision_latency_ms',
    'router_decision_latency_ms',
  ]);
  expect(MESSAGE_ROW_SELECT_ALIASES).toContain('router_decision_model');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && npx jest src/analytics/services/query-helpers.spec.ts`
Expected: FAIL — the aliases are not projected.

- [ ] **Step 3: Project the four columns**

In `packages/backend/src/analytics/services/query-helpers.ts`:

1. Append to `MESSAGE_ROW_SELECT_ALIASES`:

```ts
  'router_decision_provider',
  'router_decision_model',
  'router_decision_reason',
  'router_decision_latency_ms',
```

2. Append the matching `addSelect` calls to `selectMessageRowColumns`:

```ts
    .addSelect('at.router_decision_provider', 'router_decision_provider')
    .addSelect('at.router_decision_model', 'router_decision_model')
    .addSelect('at.router_decision_reason', 'router_decision_reason')
    .addSelect('at.router_decision_latency_ms', 'router_decision_latency_ms');
```

> The `MESSAGE_ROW_SELECT_ALIASES` order must match the `addSelect` order exactly — the existing test asserts `emittedAliases` equals the const. Append to **both** lists in the same order.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/backend && npx jest src/analytics/services/query-helpers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Exclude the router's own hop from provider reliability**

The Smart Router's hop is a Manifest-internal routing step, not a provider serving the user's request, so it must not count against a provider's reliability.

**Careful: the _served_ attempt also carries `routing_reason = 'smart_router'`** — that is how the dashboard records "this request was routed by the Smart Router". The two rows are told apart by `superseded`: the router's own hop is always superseded (it is not the request's primary attempt), the served attempt never is. So the exclusion must be:

```sql
NOT (COALESCE(at.superseded, false) AND at.routing_reason = 'smart_router')
```

Add the predicate to `packages/backend/src/analytics/services/query-helpers.ts` as a shared helper, next to `MANIFEST_ORIGIN_PREDICATE`. It takes the query's alias because the same predicate is needed on two differently-aliased tables:

```ts
/**
 * The Smart Router's own hop is a Manifest-internal routing step, not a
 * provider serving the caller's request. Exclude it from provider-reliability,
 * error-rate and attempt-counter queries.
 *
 * The *served* attempt also carries `routing_reason = 'smart_router'` (that
 * is how the dashboard records that the Smart Router chose the route), so the
 * exclusion must key on `superseded` as well: the router's hop is always
 * superseded, the served attempt never is.
 *
 * @param alias the query's alias for `agent_messages` ('at' in the analytics
 * services, 'pa' in aggregation.service.ts).
 */
export function excludeSmartRouterPredicate(alias: string): string {
  return `NOT (COALESCE(${alias}.superseded, false) AND ${alias}.routing_reason = 'smart_router')`;
}
```

Then use it in three places:

1. `packages/backend/src/analytics/controllers/provider-analytics.controller.ts`, on the attempt query (around line 199), right after the `.andWhere(sqlIsCompletedStatus('at.status'));` line:

   ```ts
         .andWhere(excludeSmartRouterPredicate('at'));
   ```

2. `packages/backend/src/analytics/services/error-breakdown.service.ts`, in **`queryErrorGroups()`** (the query that fetches the error rows — around line 72), not in `assemble()`, which only divides counts that are already fetched:

   ```ts
         .andWhere(excludeSmartRouterPredicate('at'));
   ```

3. `packages/backend/src/analytics/services/aggregation.service.ts`, in the `attempt_stats` CTE (around line 290), which computes `attempts`, `successful_attempts` and `had_failure` per Request. A **failed** router hop must not set `had_failure`, or the Request would be reported as "recovered" even though nothing was retried:

   ```sql
   BOOL_OR(
     ${sqlIsFailedStatus('pa.status')}
     AND NOT (COALESCE(pa.superseded, false) AND pa.routing_reason = 'smart_router')
   ) AS had_failure
   ```

   The CTE's table alias is `pa`, not `at`. The `attempts` and `successful_attempts` counts are **left alone**: per the glossary, a superseded Attempt counts in Attempt metrics but does not determine the Request outcome. The router's hop is a superseded Attempt, so it counts as an attempt of the Request and does not decide its outcome.

   The CTE has a second `UNION ALL` branch — the synthetic request for **unlinked** legacy attempts — that computes `had_failure` from `sqlIsFailedStatus('pa.status')` directly. **Leave it alone**: an unlinked attempt has no `request_id`, so it can never be the Smart Router's hop (the proxy always links the hop to its parent Request).

   **This change breaks an existing test.** `packages/backend/src/analytics/services/aggregation.service.spec.ts` asserts `expect(sql).not.toContain('routing_reason')` on exactly this SQL (the "keeps direct traffic by default" case), and the new predicate puts the literal `routing_reason` in the query. Update that assertion to what the case is actually about — the direct-traffic exclusion and the new router exclusion:

   ```ts
   expect(sql).not.toContain('direct_attempt');
   expect(sql).toContain("pa.routing_reason = 'smart_router'");
   ```

   For the same reason, `packages/backend/src/analytics/services/attempt-stats.service.ts` (the per-agent attempt and error tiles) is **not** changed: the router hop is a real provider call that cost the tenant tokens and money, and hiding it would understate the harness's usage. It stays visible in the Messages log and the request detail either way.

> `IS DISTINCT FROM` is not used here: `routing_reason` is NULL on most rows and `NULL <> 'smart_router'` is NULL, which would exclude every ordinary attempt.

- [ ] **Step 6: Add a test for the exclusion**

In `packages/backend/src/analytics/controllers/provider-analytics.controller.spec.ts`, add a case that asserts the attempt query carries the predicate. The file already has a `makeQb()` helper that returns a chainable query-builder mock, and `messageRepo.createQueryBuilder` is the factory the controller uses — so the assertion is on the `andWhere` calls of the builders it produced:

```ts
it('excludes the Smart Router hop from provider reliability', async () => {
  messageRepo.createQueryBuilder.mockReturnValue(makeQb({ rawOne: undefined }));
  await controller.getAnalytics(ctx, 'subscription');

  const builders = messageRepo.createQueryBuilder.mock.results.map(
    (r) => r.value as Record<string, jest.Mock>,
  );
  const excluded = builders.some((qb) =>
    (qb.andWhere as jest.Mock).mock.calls.some(([clause]: [string]) =>
      String(clause).includes("at.routing_reason = 'smart_router'"),
    ),
  );
  expect(excluded).toBe(true);
});
```

(`ctx` and the controller are the file's own fixtures; `getAnalytics(ctx, 'subscription')` is the route the existing `describe('getAnalytics')` block exercises.)

Also add a unit test for the shared predicate in `packages/backend/src/analytics/services/query-helpers.spec.ts`:

```ts
it('excludes only the superseded Smart Router hop', () => {
  expect(excludeSmartRouterPredicate('at')).toContain('at.superseded');
  expect(excludeSmartRouterPredicate('at')).toContain("at.routing_reason = 'smart_router'");
  expect(excludeSmartRouterPredicate('pa')).toContain('pa.superseded');
});
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/backend && npx jest src/analytics`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/analytics/
git commit -m "feat: surface the Smart Router decision in the analytics layer"
```

---

## Task 13: End-to-end tests

**Files:**

- Create: `packages/backend/test/smart-router.e2e-spec.ts`

- [ ] **Step 1: Write the e2e spec**

Create `packages/backend/test/smart-router.e2e-spec.ts`. The setup mirrors `packages/backend/test/anthropic-beta-header.e2e-spec.ts`: a `tenant_providers` row with `cached_models`, an `agent_enabled_providers` link, and a `tier_assignments` default row. The upstream is stubbed at the `global.fetch` level, so the whole path — resolver dispatch, router call, parsing, attempt recording, fallback — runs for real against the test database.

```ts
/**
 * End-to-end cover for the Smart Router layer.
 *
 * The provider transport is stubbed at the `global.fetch` level, so the whole
 * path — resolver dispatch, the router's own LLM call, answer parsing, the
 * Provider Attempt recording and the fallback to scoring-based routing — runs
 * for real against the test database.
 *
 * The router's call is told apart from the user's call by its body: the
 * meta-prompt always contains the literal `model_id`, a real chat completion
 * never does.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import {
  createTestApp,
  TEST_AGENT_ID,
  TEST_API_KEY,
  TEST_OTLP_KEY,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from './helpers';
import { encrypt, getEncryptionSecret } from '../src/common/utils/crypto.util';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { PricingSyncService } from '../src/database/pricing-sync.service';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

const AGENT_NAME = 'test-agent';
const ROUTER_MODEL = 'gpt-4o-mini';
const CHOSEN_MODEL = 'gpt-4o';
const PROVIDER_ROW = 'up-smart-router';

let app: INestApplication;
let ds: DataSource;
let originalFetch: typeof global.fetch;

function routerAnswer(modelId: string): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ model_id: modelId, reason: 'best fit' }),
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
  };
}

/** The number of calls that reached the router during the current test. */
let routerCallCount = 0;

/**
 * Answer the router's call with `routerBody` and the user's call with a chat
 * completion. The router's call is told apart by its body: the meta-prompt
 * always contains the literal `model_id`, a real chat completion never does.
 */
function stubUpstream(routerBody: unknown, routerStatus = 200): void {
  routerCallCount = 0;
  originalFetch = global.fetch;
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body = init?.body ? String(init.body) : '';

    if (body.includes('model_id')) {
      routerCallCount += 1;
      return new Response(JSON.stringify(routerBody), {
        status: routerStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

/**
 * Count the calls that reach the router without answering them — used by the
 * cases that assert the router was NOT called. The user's call is answered
 * with a normal chat completion.
 */
function countRouterCalls(): () => number {
  routerCallCount = 0;
  originalFetch = global.fetch;
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body = init?.body ? String(init.body) : '';
    if (body.includes('model_id')) {
      routerCallCount += 1;
      return new Response(JSON.stringify(routerAnswer(CHOSEN_MODEL)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return () => routerCallCount;
}

async function setAgentRouter(fields: Record<string, unknown>): Promise<void> {
  await ds.query(
    `UPDATE agents
        SET smart_router_enabled = $2,
            smart_router_provider = $3,
            smart_router_model = $4,
            smart_router_auth_type = $5,
            smart_router_include_self = $6
      WHERE id = $1`,
    [
      TEST_AGENT_ID,
      fields.enabled ?? true,
      fields.provider ?? 'openai',
      fields.model ?? ROUTER_MODEL,
      fields.authType ?? 'api_key',
      fields.includeSelf ?? true,
    ],
  );
  app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
  app.get(RoutingCacheService).invalidateTenant(TEST_TENANT_ID);
}

beforeAll(async () => {
  app = await createTestApp();
  ds = app.get(DataSource);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  // Price the two models so the router's hop and the chosen hop can be costed.
  const sync = app.get(PricingSyncService);
  (sync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>).set(
    `openai/${ROUTER_MODEL}`,
    { input: 0.00000015, output: 0.0000006, contextWindow: 128000 },
  );
  (sync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>).set(
    `openai/${CHOSEN_MODEL}`,
    { input: 0.0000025, output: 0.00001, contextWindow: 128000 },
  );
  await app.get(ModelPricingCacheService).reload();

  // One provider with two models, so the catalog has something to choose from.
  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type,
        api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,'openai','api_key',$5,true,$6,$6,'sk-openai',$7)`,
    [
      PROVIDER_ROW,
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_AGENT_ID,
      encrypt('fake-openai-key', getEncryptionSecret()),
      now,
      JSON.stringify([
        {
          id: ROUTER_MODEL,
          displayName: ROUTER_MODEL,
          provider: 'openai',
          authType: 'api_key',
          contextWindow: 128000,
          inputPricePerToken: 0.00000015,
          outputPricePerToken: 0.0000006,
          capabilityReasoning: false,
          capabilityCode: false,
          qualityScore: 5,
        },
        {
          id: CHOSEN_MODEL,
          displayName: CHOSEN_MODEL,
          provider: 'openai',
          authType: 'api_key',
          contextWindow: 128000,
          inputPricePerToken: 0.0000025,
          outputPricePerToken: 0.00001,
          capabilityReasoning: false,
          capabilityCode: true,
          qualityScore: 8,
        },
      ]),
    ],
  );

  await ds.query(
    `INSERT INTO agent_enabled_providers (agent_id, tenant_provider_id) VALUES ($1,$2)`,
    [TEST_AGENT_ID, PROVIDER_ROW],
  );

  // Pin the model on EVERY scoring tier, the way
  // `packages/backend/test/proxy.e2e-spec.ts` does. The seeded test agent has
  // `complexity_routing_enabled = true`, so when the router declines the
  // request falls to the scoring path, which lands on the 'standard' tier —
  // and a tier with no override has no route, so the proxy would answer with
  // the M101 "no model to route to" stub instead of a real completion.
  for (const tier of ['simple', 'standard', 'complex', 'reasoning', 'default']) {
    await ds.query(
      `INSERT INTO tier_assignments
         (id, agent_id, tier, override_route, updated_at)
       VALUES ($1,$2,$3,$4::jsonb, now())
       ON CONFLICT (agent_id, tier) DO UPDATE SET override_route = EXCLUDED.override_route`,
      [
        `tier-${tier}-smart-router`,
        TEST_AGENT_ID,
        tier,
        JSON.stringify({ provider: 'openai', authType: 'api_key', model: CHOSEN_MODEL }),
      ],
    );
  }

  app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
  app.get(RoutingCacheService).invalidateTenant(TEST_TENANT_ID);
}, 30000);

afterAll(async () => {
  global.fetch = originalFetch;
  await app.close();
});

const api = () => request(app.getHttpServer());
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${TEST_OTLP_KEY}`);
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

describe('Smart Router', () => {
  afterEach(async () => {
    global.fetch = originalFetch;
    await ds.query(`DELETE FROM agent_messages WHERE agent_id = $1`, [TEST_AGENT_ID]);
    await ds.query(`DELETE FROM requests WHERE agent_id = $1`, [TEST_AGENT_ID]);
    await setAgentRouter({ enabled: false });
  });

  it('routes to the model the router picked and records both attempts', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    const res = await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case one' }],
        }),
    ).expect(200);

    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(
      `SELECT routing_reason, superseded, router_decision_model, model, attempt_number
         FROM agent_messages WHERE agent_id = $1 ORDER BY attempt_number ASC`,
      [TEST_AGENT_ID],
    );
    const routerRow = rows.find(
      (r: { routing_reason: string }) => r.routing_reason === 'smart_router',
    );
    expect(routerRow).toBeDefined();
    expect(routerRow.superseded).toBe(true);
    expect(routerRow.router_decision_model).toBe(CHOSEN_MODEL);
    // The row names the model that RAN the router, not the one it picked.
    expect(routerRow.model).toBe(ROUTER_MODEL);
  });

  it('falls back to scoring when the router picks an unknown model', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer('a-model-that-does-not-exist'));

    const res = await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case two' }],
        }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(`SELECT error_class FROM agent_messages WHERE agent_id = $1`, [
      TEST_AGENT_ID,
    ]);
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_unknown_model'),
    ).toBe(true);
  });

  it('does not call the router when the layer is off', async () => {
    await setAgentRouter({ enabled: false });
    const routerCalls = countRouterCalls();

    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'hello' }],
        }),
    ).expect(200);

    expect(routerCalls()).toBe(0);
  });

  it('does not call the router for an explicit model', async () => {
    await setAgentRouter({});
    const routerCalls = countRouterCalls();

    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hello' }],
        }),
    ).expect(200);

    expect(routerCalls()).toBe(0);
  });

  it('serves a repeated identical request from the cache without a second router call', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case five' }],
        }),
    ).expect(200);
    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case five' }],
        }),
    ).expect(200);

    const rows = await ds.query(
      `SELECT COUNT(*)::int AS count FROM agent_messages
        WHERE agent_id = $1 AND routing_reason = 'smart_router'`,
      [TEST_AGENT_ID],
    );
    // One router row for two identical requests — the second was a cache hit.
    expect(rows[0].count).toBe(1);
  });

  it('joins the parent request', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case six' }],
        }),
    ).expect(200);

    const rows = await ds.query(
      `SELECT r.id AS request_id, m.request_id AS attempt_request_id
         FROM agent_messages m JOIN requests r ON r.id = m.request_id
        WHERE m.agent_id = $1 AND m.routing_reason = 'smart_router'`,
      [TEST_AGENT_ID],
    );
    // The router hop belongs to the same Manifest Request as the served attempt.
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_request_id).toBe(rows[0].request_id);
  });

  it('does not call the router when a header tier matches', async () => {
    await ds.query(
      `INSERT INTO header_tiers
         (id, tenant_id, agent_id, name, header_key, header_value, badge_color,
          sort_order, enabled, override_route, fallback_routes, output_modality,
          response_mode, created_at, updated_at)
       VALUES ('ht-smart-router', $1, $2, 'Support', 'x-support', '1', 'blue', 0, true,
               $3::jsonb, $4::jsonb, 'text', 'buffered', $5, $5)
       ON CONFLICT DO NOTHING`,
      [
        TEST_TENANT_ID,
        TEST_AGENT_ID,
        JSON.stringify({ provider: 'openai', authType: 'api_key', model: CHOSEN_MODEL }),
        JSON.stringify([]),
        new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19),
      ],
    );
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
    await setAgentRouter({});
    const routerCalls = countRouterCalls();

    await bearer(
      api()
        .post('/v1/chat/completions')
        .set('x-support', '1')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case seven' }],
        }),
    ).expect(200);

    expect(routerCalls()).toBe(0);
  });

  it('skips the router when the catalog holds a single model', async () => {
    const rows = await ds.query(`SELECT cached_models FROM tenant_providers WHERE id = $1`, [
      PROVIDER_ROW,
    ]);
    const fullCatalog = rows[0].cached_models;

    // `tenant_providers.cached_models` is a TEXT column holding JSON, so it
    // has to be cast to jsonb to index into it and cast back to text on the
    // way out.
    await ds.query(
      `UPDATE tenant_providers
          SET cached_models = jsonb_build_array(cached_models::jsonb->0)::text
        WHERE id = $1`,
      [PROVIDER_ROW],
    );
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
    app.get(RoutingCacheService).invalidateTenant(TEST_TENANT_ID);
    await setAgentRouter({});
    const routerCalls = countRouterCalls();

    await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case eight' }],
        }),
    ).expect(200);

    expect(routerCalls()).toBe(0);

    // Restore the two-model catalog for the other cases. `fullCatalog` is
    // already the JSON text, so it is written as-is — re-stringifying it would
    // store a JSON string instead of an array and break the catalog.
    await ds.query(`UPDATE tenant_providers SET cached_models = $2 WHERE id = $1`, [
      PROVIDER_ROW,
      fullCatalog,
    ]);
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
    app.get(RoutingCacheService).invalidateTenant(TEST_TENANT_ID);
  });

  it('falls back to scoring when the router call fails', async () => {
    await setAgentRouter({});
    stubUpstream({ error: 'upstream is down' }, 500);

    const res = await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case nine' }],
        }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(`SELECT error_class FROM agent_messages WHERE agent_id = $1`, [
      TEST_AGENT_ID,
    ]);
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_failure'),
    ).toBe(true);
  });

  it('falls back to scoring when the router model has no credentials', async () => {
    // Runs before the circuit-breaker case: the breaker is a per-process
    // singleton, and once it is open this case's router call would be
    // short-circuited and no row would be written.
    // 'anthropic' has no connection on this harness, so the router's own
    // credential lookup comes back empty while the catalog still has models.
    await setAgentRouter({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    const res = await bearer(
      api()
        .post('/v1/chat/completions')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'pick one for me — case eleven' }],
        }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(`SELECT error_class FROM agent_messages WHERE agent_id = $1`, [
      TEST_AGENT_ID,
    ]);
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_no_credentials'),
    ).toBe(true);
  });

  it('stops calling the router once the circuit breaker opens', async () => {
    // NOTE: this case runs last among the router cases on purpose. The
    // breaker is a per-process singleton with a 30-second cooldown, so once
    // it opens every later router call in this file is short-circuited.
    await setAgentRouter({});
    stubUpstream({ error: 'upstream is down' }, 500);

    // The breaker is a per-process singleton, so its failure streak is shared
    // with the other cases in this file. The assertion is therefore "the
    // breaker opened at least once during these four requests", not an exact
    // call count.
    const before = routerCallCount;
    for (const text of ['case ten a', 'case ten b', 'case ten c', 'case ten d']) {
      await bearer(
        api()
          .post('/v1/chat/completions')
          .send({
            model: 'auto',
            messages: [{ role: 'user', content: `pick one for me — ${text}` }],
          }),
      ).expect(200);
    }
    // Four requests, at most three router calls: the breaker short-circuited
    // the rest.
    expect(routerCallCount - before).toBeLessThan(4);
  });

  it('exposes and updates the configuration over REST', async () => {
    const before = await auth(api().get(`/api/v1/routing/${AGENT_NAME}/smart-router`)).expect(200);
    expect(before.body.enabled).toBe(false);

    const patched = await auth(
      api()
        .patch(`/api/v1/routing/${AGENT_NAME}/smart-router`)
        .send({
          enabled: true,
          model: { provider: 'openai', authType: 'api_key', model: ROUTER_MODEL },
        }),
    ).expect(200);
    expect(patched.body.enabled).toBe(true);
    expect(patched.body.model.model).toBe(ROUTER_MODEL);
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `cd packages/backend && npx jest test/smart-router.e2e-spec.ts`
Expected: PASS (12 tests).

> The spec's "specificity category active → no router call" case is covered by the **resolver unit test** in Task 9 ("lets an active specificity category win over the Smart Router") rather than here: the e2e would have to reproduce the keyword detector's confidence threshold, which is a unit-level concern.
>
> The spec's "router times out" case is covered here as an HTTP-500 failure (the e2e stub cannot easily reproduce a client-side abort, which is what a timeout is). The `router_timeout` error class itself is asserted by the service unit test in Task 8 ("falls back to scoring when the router times out").

> The e2e suite needs a PostgreSQL instance. Follow the repo convention: a fresh database per session, created with
> `docker exec postgres_db psql -U myuser -d postgres -c "CREATE DATABASE manifest_smart_router;"` and pointed at by
> `DATABASE_URL` in `packages/backend/.env`. See the "IMPORTANT: Cloud Mode Always" section of `CLAUDE.md`.

- [ ] **Step 3: Run the whole e2e suite**

Run: `cd packages/backend && npm run test:e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/test/smart-router.e2e-spec.ts
git commit -m "test: cover the Smart Router end to end"
```

---

## Task 14: Frontend API client

**Files:**

- Modify: `packages/frontend/src/services/api/routing.ts`

- [ ] **Step 1: Add the client functions**

In `packages/frontend/src/services/api/routing.ts`, after the "Routing: Message recording" block, add:

```ts
/* -- Routing: Smart Router -- */

export interface SmartRouterConfig {
  enabled: boolean;
  /** The configured router model, or null when none is set. */
  model: ModelRoute | null;
  /** Whether the router model is also offered as a candidate for itself. */
  include_router_in_candidates: boolean;
  /** Whether the harness has any discovered model to choose from. */
  has_catalog: boolean;
  /** When the router last ran for this harness, or null. */
  last_decision_at: string | null;
}

export function getSmartRouter(agentName: string) {
  return fetchJson<SmartRouterConfig>(routingPath(agentName, 'smart-router'));
}

export function updateSmartRouter(
  agentName: string,
  body: {
    enabled?: boolean;
    model?: ModelRoute | null;
    include_router_in_candidates?: boolean;
  },
) {
  return fetchMutate<SmartRouterConfig>(routingPath(agentName, 'smart-router'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

`ModelRoute` is already imported at the top of this file.

- [ ] **Step 2: Check the api barrel re-export**

`packages/frontend/src/pages/SettingsAutofixSection.tsx` imports from `'../services/api.js'`. Confirm `packages/frontend/src/services/api.ts` (or `api/index.ts`) re-exports `./api/routing.js` with `export *`. If it lists exports explicitly, add `getSmartRouter`, `updateSmartRouter` and the `SmartRouterConfig` type to that list.

- [ ] **Step 3: Run the frontend tests**

Run: `cd packages/frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/services/api/
git commit -m "feat: add the Smart Router API client"
```

---

## Task 15: The Smart Router card

**Files:**

- Create: `packages/frontend/src/pages/SmartRouterSettings.tsx`
- Modify: `packages/frontend/src/pages/Routing.tsx`

- [ ] **Step 1: Write the component**

Create `packages/frontend/src/pages/SmartRouterSettings.tsx`:

```tsx
import { createResource, createSignal, For, Show, type Component } from 'solid-js';
import { getAvailableModels, getSmartRouter, updateSmartRouter } from '../services/api.js';
import type { ModelRoute } from '../services/api.js';

/**
 * The Smart Router card on the Routing page.
 *
 * When enabled, a request with `model: 'auto'` first asks a small LLM which
 * of the harness's linked models should serve it. Header tiers, an explicit
 * model name and specificity routing still win when they apply, and any
 * failure of the router itself falls back to scoring-based routing.
 */
const SmartRouterSettings: Component<{ agentName: () => string }> = (props) => {
  const [config, { mutate }] = createResource(() => props.agentName(), getSmartRouter);
  const [models] = createResource(() => props.agentName(), getAvailableModels);
  const [saving, setSaving] = createSignal(false);

  const enabled = () => (!config.loading && !config.error ? (config()?.enabled ?? false) : false);
  const busy = () => saving() || config.loading || Boolean(config.error);

  const save = async (body: Parameters<typeof updateSmartRouter>[1]) => {
    const agentName = props.agentName();
    setSaving(true);
    try {
      const next = await updateSmartRouter(agentName, body);
      if (props.agentName() === agentName) mutate(next);
    } catch {
      // `updateSmartRouter` already surfaces the backend error as a toast.
    } finally {
      setSaving(false);
    }
  };

  const selectedModel = () => {
    const current = config()?.model;
    if (!current) return '';
    return `${current.provider}|${current.authType}|${current.model}`;
  };

  const lastDecision = () => {
    const at = config()?.last_decision_at;
    if (!at) return 'No decision yet';
    return `Last decision ${new Date(at).toLocaleString()}`;
  };

  return (
    <>
      <h2 class="settings-section__title">Smart Router</h2>
      <div class="settings-card settings-card--flush">
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Smart model selection</span>
            <span class="settings-card__label-desc">
              When enabled, requests with <code>model: &apos;auto&apos;</code> first ask a small LLM
              which of your linked models is best for the task. Header tiers, explicit model names
              and specificity routing still win when they apply. If the router call fails, requests
              transparently fall back to scoring-based routing.
            </span>
          </div>
          <div class="settings-card__control settings-card__control--end">
            <button
              type="button"
              role="switch"
              aria-checked={enabled()}
              aria-label="Smart Router"
              class="settings-switch"
              classList={{ 'settings-switch--on': enabled() }}
              disabled={busy()}
              onClick={() => void save({ enabled: !enabled() })}
            >
              <span class="settings-switch__track">
                <span class="settings-switch__thumb" />
              </span>
            </button>
          </div>
        </div>

        <Show when={enabled()}>
          <div class="settings-card__row">
            <div class="settings-card__label">
              <span class="settings-card__label-title">Router model</span>
              <span class="settings-card__label-desc">
                The small model that makes the choice. Cheaper is better — it runs on every request
                the cache misses.
              </span>
            </div>
            <div class="settings-card__control">
              <select
                class="select"
                value={selectedModel()}
                disabled={busy()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (!value) {
                    void save({ model: null });
                    return;
                  }
                  const [provider, authType, model] = value.split('|');
                  void save({
                    model: {
                      provider,
                      authType: authType as ModelRoute['authType'],
                      model,
                    },
                  });
                }}
              >
                <option value="">Select a model…</option>
                <For each={models() ?? []}>
                  {(model) => (
                    <option
                      value={`${model.provider}|${model.auth_type ?? 'api_key'}|${model.model_name}`}
                    >
                      {model.display_name ?? model.model_name} ({model.provider})
                    </option>
                  )}
                </For>
              </select>
            </div>
          </div>

          <div class="settings-card__row">
            <div class="settings-card__label">
              <span class="settings-card__label-title">
                Include the router model as a candidate
              </span>
              <span class="settings-card__label-desc">
                When off, the router never picks itself.
              </span>
            </div>
            <div class="settings-card__control settings-card__control--end">
              <button
                type="button"
                role="switch"
                aria-checked={config()?.include_router_in_candidates ?? true}
                aria-label="Include the router model as a candidate"
                class="settings-switch"
                classList={{
                  'settings-switch--on': config()?.include_router_in_candidates ?? true,
                }}
                disabled={busy()}
                onClick={() =>
                  void save({
                    include_router_in_candidates: !(config()?.include_router_in_candidates ?? true),
                  })
                }
              >
                <span class="settings-switch__track">
                  <span class="settings-switch__thumb" />
                </span>
              </button>
            </div>
          </div>

          <p class="settings-card__legal">{lastDecision()}</p>
        </Show>
      </div>
    </>
  );
};

export default SmartRouterSettings;
```

- [ ] **Step 2: Mount the card on the Routing page**

In `packages/frontend/src/pages/Routing.tsx`:

1. Add the import next to the other section imports:

```ts
import SmartRouterSettings from './SmartRouterSettings.js';
```

2. Mount the card **outside** the legacy-tabs `<Show when={!isCleanAgent()}>` block, so it renders for both the clean and the legacy view. `Routing.tsx` has several `<Show>` blocks; the one that matters is the tab switch, which ends with the `</Show>` immediately before `<RoutingFooter`. The exact anchor is between that `</Show>` and the `<RoutingFooter …>` element:

```tsx
          </Show>

          <SmartRouterSettings agentName={agentName} />

          <RoutingFooter
```

`agentName` is already in scope in that component (it is the page's agent accessor).

- [ ] **Step 3: Extend the existing Routing page test's API mock**

`packages/frontend/tests/pages/Routing.test.tsx` mocks the API module with an **explicitly enumerated** factory:

```ts
vi.mock('../../src/services/api.js', () => ({
  getTierAssignments: (...args: unknown[]) => mockGetTierAssignments(...args),
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
  // …
}));
```

A mock factory that does not list a function makes that export `undefined`, and the newly mounted card would call `undefined` as its resource fetcher and throw. Add both new functions to that factory:

```ts
const mockGetSmartRouter = vi.fn();
const mockUpdateSmartRouter = vi.fn();
```

```ts
  getSmartRouter: (...args: unknown[]) => mockGetSmartRouter(...args),
  updateSmartRouter: (...args: unknown[]) => mockUpdateSmartRouter(...args),
```

and give them a default resolved value in the file's `beforeEach`:

```ts
mockGetSmartRouter.mockResolvedValue({
  enabled: false,
  model: null,
  include_router_in_candidates: true,
  has_catalog: true,
  last_decision_at: null,
});
mockUpdateSmartRouter.mockResolvedValue({
  enabled: false,
  model: null,
  include_router_in_candidates: true,
  has_catalog: true,
  last_decision_at: null,
});
```

- [ ] **Step 4: Add a test for the new card**

`CLAUDE.md` makes 100 % line coverage on new files a hard CI gate, and the card is ~160 new lines. Create `packages/frontend/tests/pages/SmartRouterSettings.test.tsx`, modelled on `packages/frontend/tests/pages/SettingsAutofixSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@solidjs/testing-library';

const mockGetSmartRouter = vi.fn();
const mockUpdateSmartRouter = vi.fn();
const mockGetAvailableModels = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getSmartRouter: (...args: unknown[]) => mockGetSmartRouter(...args),
  updateSmartRouter: (...args: unknown[]) => mockUpdateSmartRouter(...args),
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
}));

import SmartRouterSettings from '../../src/pages/SmartRouterSettings';

const OFF = {
  enabled: false,
  model: null,
  include_router_in_candidates: true,
  has_catalog: true,
  last_decision_at: null,
};

describe('SmartRouterSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSmartRouter.mockResolvedValue(OFF);
    mockGetAvailableModels.mockResolvedValue([
      {
        model_name: 'gpt-4o-mini',
        provider: 'openai',
        auth_type: 'api_key',
        display_name: 'GPT-4o mini',
      },
    ]);
    mockUpdateSmartRouter.mockResolvedValue(OFF);
  });
  afterEach(() => cleanup());

  it('renders the card with the switch off', async () => {
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(mockGetSmartRouter).toHaveBeenCalledWith('demo'));
    expect(container.textContent).toContain('Smart Router');
    const btn = container.querySelector('.settings-switch') as HTMLButtonElement;
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('hides the model picker while the layer is off', async () => {
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(mockGetSmartRouter).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });

  it('shows the model picker and the include-self toggle when enabled', async () => {
    mockGetSmartRouter.mockResolvedValue({
      ...OFF,
      enabled: true,
      model: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
      last_decision_at: '2026-10-19T00:00:00.000Z',
    });
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    expect(container.textContent).toContain('Last decision');
  });

  it('turns the layer on', async () => {
    mockUpdateSmartRouter.mockResolvedValue({ ...OFF, enabled: true });
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(mockGetSmartRouter).toHaveBeenCalled());
    const btn = container.querySelector('.settings-switch') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockUpdateSmartRouter).toHaveBeenCalledWith('demo', { enabled: true }),
    );
  });

  it('clears the router model when the placeholder is chosen', async () => {
    mockGetSmartRouter.mockResolvedValue({
      ...OFF,
      enabled: true,
      model: { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' },
    });
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = '';
    fireEvent.change(select);
    await waitFor(() =>
      expect(mockUpdateSmartRouter).toHaveBeenCalledWith('demo', { model: null }),
    );
  });
});
```

- [ ] **Step 5: Run the frontend tests**

Run: `cd packages/frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/pages/SmartRouterSettings.tsx \
  packages/frontend/src/pages/Routing.tsx \
  packages/frontend/tests/pages/SmartRouterSettings.test.tsx \
  packages/frontend/tests/pages/Routing.test.tsx
git commit -m "feat: add the Smart Router card to the routing page"
```

---

## Task 16: Show the decision in the request detail

**Files:**

- Modify: `packages/frontend/src/services/api/messages.ts`
- Modify: `packages/frontend/src/components/message-table-types.ts`
- Modify: `packages/frontend/src/components/MessageDetails.tsx`

- [ ] **Step 1: Extend the row types**

In `packages/frontend/src/services/api/messages.ts`, add to the message row interface (next to `routing_reason`):

```ts
/** The Smart Router's own attempt row: what the router picked. */
router_decision_provider: string | null;
router_decision_model: string | null;
router_decision_reason: string | null;
router_decision_latency_ms: number | null;
```

In `packages/frontend/src/components/message-table-types.ts`, add the same four fields as optional:

```ts
  router_decision_provider?: string | null;
  router_decision_model?: string | null;
  router_decision_reason?: string | null;
  router_decision_latency_ms?: number | null;
```

- [ ] **Step 2: Render the decision**

In `packages/frontend/src/components/MessageDetails.tsx`, after the `MetaField label="Reason"` field, add:

```tsx
<Show when={m.router_decision_model}>
  <MetaField
    label="Smart Router chose"
    value={`${m.router_decision_model} (${m.router_decision_latency_ms ?? 0} ms)`}
  />
  <Show when={m.router_decision_reason}>
    <MetaField label="Smart Router reason" value={m.router_decision_reason} />
  </Show>
</Show>
```

- [ ] **Step 3: Label the router error classes**

In `packages/frontend/src/services/formatters.ts`, add the five router classes to `ERROR_CLASS_LABELS`:

```ts
  router_timeout: 'Router timed out',
  router_failure: 'Router call failed',
  router_invalid_response: 'Router answer unusable',
  router_unknown_model: 'Router picked an unknown model',
  router_no_credentials: 'Router model has no key',
```

(Without them the fallback in `formatErrorClass` renders "router timeout" and friends — readable, but the explicit labels are better.)

- [ ] **Step 4: Cover the new detail branch**

The new `<Show when={m.router_decision_model}>` branch is new lines in an existing file, and the repo's patch-coverage gate is 100 %. Add a case to the existing `packages/frontend/tests/pages/MessageLog.test.tsx` (or whichever file covers `MessageDetails`) that renders an attempt carrying `router_decision_model` and asserts the decision shows up, plus a case for an attempt without it (the branch is hidden).

- [ ] **Step 5: Run the frontend tests**

Run: `cd packages/frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/services/api/messages.ts \
  packages/frontend/src/components/message-table-types.ts \
  packages/frontend/src/components/MessageDetails.tsx \
  packages/frontend/src/services/formatters.ts \
  packages/frontend/tests/
git commit -m "feat: show the Smart Router decision in the request detail"
```

---

## Task 17: Documentation and release

**Files:**

- Modify: `docs/glossary.md`
- Modify: `CLAUDE.md`
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Add the glossary entry**

`docs/glossary.md` is a metrics-and-taxonomy glossary, so the entry belongs in the existing **`### Superseded Attempt`** section, not as a new behavioural section. That section currently says a Superseded Attempt is "a failed Provider Attempt" and that "Newly written Superseded Attempts keep `agent_messages.status = 'failed'`". The Smart Router's hop introduces a **new shape**: it is superseded but it _succeeded_. Amend the section to cover it — the amendment must be precise, because the section is the contract the metrics read:

```markdown
### Superseded Attempt

A Superseded Attempt is a Provider Attempt that did not determine the Request outcome: either a failed Provider Attempt after which Manifest continued the same Request with another Attempt, or a Manifest-internal routing Attempt that ran alongside the Attempt that served the Request.

Newly written Superseded Attempts from a failure keep `agent_messages.status = 'failed'` and have `agent_messages.superseded = true`; historical rows may retain a legacy failure status such as `fallback_error`. The Smart Router's own routing Attempt is superseded but keeps `agent_messages.status = 'success'` and carries `agent_messages.routing_reason = 'smart_router'`. They count in Attempt metrics, but do not determine the Request outcome: a failed Smart Router Attempt never makes its Request a Recovered Request. The Smart Router's routing Attempt is additionally excluded from provider-reliability and error-rate aggregates, because a routing hop is not a provider serving the caller's request.
```

Then add a **Smart Router** paragraph to the same section that states:

- the Smart Router is an opt-in per-agent layer that asks a small, user-picked LLM which of the harness's linked models should serve a request;
- it only runs for `model: 'auto'` requests, and never when a header tier, an explicit model or an active specificity category applies;
- the router hop is recorded as its own Provider Attempt with `routing_reason = 'smart_router'` and `superseded = true`, and it carries the parent Request's `request_id`;
- the model that actually served the request carries `routing_reason = 'smart_router'` too, but is **not** superseded, and it is the one that counts;
- decisions are cached for 30 seconds, and a cache hit writes no row;
- every router failure falls back to scoring-based routing, so the caller never sees an error.

The behavioural description belongs in `CLAUDE.md` (the next step), not in the glossary.

- [ ] **Step 2: Update `CLAUDE.md`**

In the "LLM Routing" bullet list under **Architecture Notes**, add a bullet:

```
  - **Smart Router** (opt-in, per-agent): a small user-picked LLM picks which of the agent's linked models serves each `model: 'auto'` request. It runs only when no header tier, explicit model or specificity category applies, and every failure falls back to scoring-based routing. The router hop is recorded as its own `agent_messages` row (`routing_reason='smart_router'`, `superseded=true`).
```

- [ ] **Step 3: Add the changeset**

Create `.changeset/smart-router-layer.md`:

```md
---
'manifest': minor
---

Add an opt-in Smart Router: a small LLM picks which of a harness's linked models should serve each request.
```

> Only `manifest` is a selectable changeset target — `manifest-backend`, `manifest-frontend` and `manifest-shared` are in the ignore list (see `CLAUDE.md`, "Releases").

- [ ] **Step 4: Run the whole verification suite**

```bash
cd packages/backend && npx jest --coverage
cd packages/frontend && npx vitest run --coverage
cd packages/shared && npx jest --coverage
```

Expected: all PASS, with **100 % line coverage** on every new file (the repo's patch-coverage rule). Any uncovered line in the new `packages/backend/src/routing/smart-router/**` files must get a test — this is a hard CI gate, not a recommendation.

- [ ] **Step 5: Commit**

```bash
git add docs/glossary.md CLAUDE.md .changeset/smart-router-layer.md
git commit -m "docs: document the Smart Router layer"
```

---

## Manual verification (before opening the PR)

Per `CLAUDE.md`, dev sessions use a fresh PostgreSQL database and `MANIFEST_MODE=cloud`:

```bash
docker start postgres_db 2>/dev/null || \
  docker run -d --name postgres_db -e POSTGRES_USER=myuser -e POSTGRES_PASSWORD=mypassword \
    -e POSTGRES_DB=mydatabase -p 5432:5432 postgres:16

DB_NAME="manifest_smart_$(openssl rand -hex 4)"
docker exec postgres_db psql -U myuser -d postgres -c "CREATE DATABASE $DB_NAME;"
# point packages/backend/.env DATABASE_URL at $DB_NAME, keep SEED_DATA=true
```

Then, in the dashboard:

1. Open a harness → **Routing** → the **Smart Router** card appears.
2. Turn it on and pick a router model from the dropdown.
3. Send a chat request through `/v1/chat/completions` with `model: 'auto'`.
4. Open the **Requests log** → the request has two attempts: the router hop (`routing_reason = smart_router`, `superseded`) and the chosen model.
5. Turn the router model into an unreachable provider (or set `SMART_ROUTER_GLOBAL_ENABLED=false`) and repeat: the request still succeeds, routed by scoring, and the router row carries the failure class.

The Wingman drawer (bottom-right FAB) must still load `https://wingman.manifest.build` in dev mode — it is part of the dev surface, and a broken iframe means the dev environment is broken.
