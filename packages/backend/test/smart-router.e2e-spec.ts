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
/** The number of calls that reached the router during the current test. */
let routerCallCount = 0;

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

/**
 * Answer the router's call with `routerBody` and the user's call with a chat
 * completion.
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
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'pick one for me' }],
      }),
    ).expect(200);

    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(
      `SELECT routing_reason, superseded, router_decision_model, model
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

  it('joins the parent request', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api().post('/v1/chat/completions').send({
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

  it('does not call the router when the layer is off', async () => {
    await setAgentRouter({ enabled: false });
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).expect(200);

    expect(routerCallCount).toBe(0);
  });

  it('does not call the router for an explicit model', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api().post('/v1/chat/completions').send({
        model: CHOSEN_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).expect(200);

    expect(routerCallCount).toBe(0);
  });

  it('serves a repeated identical request from the cache without a second router call', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    await bearer(
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'pick one for me — case five' }],
      }),
    ).expect(200);
    await bearer(
      api().post('/v1/chat/completions').send({
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

  it('falls back to scoring when the router picks an unknown model', async () => {
    await setAgentRouter({});
    stubUpstream(routerAnswer('a-model-that-does-not-exist'));

    const res = await bearer(
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'pick one for me — case two' }],
      }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(
      `SELECT error_class FROM agent_messages WHERE agent_id = $1`,
      [TEST_AGENT_ID],
    );
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_unknown_model'),
    ).toBe(true);
  });

  it('falls back to scoring when the router call fails', async () => {
    await setAgentRouter({});
    stubUpstream({ error: 'upstream is down' }, 500);

    const res = await bearer(
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'pick one for me — case nine' }],
      }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(
      `SELECT error_class FROM agent_messages WHERE agent_id = $1`,
      [TEST_AGENT_ID],
    );
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_failure'),
    ).toBe(true);
  });

  it('falls back to scoring when the router model has no credentials', async () => {
    // 'anthropic' has no connection on this harness, so the router's own
    // credential lookup comes back empty while the catalog still has models.
    // Runs before the circuit-breaker case: the breaker is a per-process
    // singleton, and once it is open this case's router call would be
    // short-circuited and no row would be written.
    await setAgentRouter({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    stubUpstream(routerAnswer(CHOSEN_MODEL));

    const res = await bearer(
      api().post('/v1/chat/completions').send({
        model: 'auto',
        messages: [{ role: 'user', content: 'pick one for me — case eleven' }],
      }),
    ).expect(200);
    expect(res.body.choices[0].message.content).toBe('done');

    const rows = await ds.query(
      `SELECT error_class FROM agent_messages WHERE agent_id = $1`,
      [TEST_AGENT_ID],
    );
    expect(
      rows.some((r: { error_class: string | null }) => r.error_class === 'router_no_credentials'),
    ).toBe(true);
  });

  it('stops calling the router once the circuit breaker opens', async () => {
    // The breaker is a per-process singleton with a 30-second cooldown, so
    // once it opens every later router call in this file is short-circuited.
    // The assertion is therefore "the breaker opened at least once during
    // these four requests", not an exact call count.
    await setAgentRouter({});
    stubUpstream({ error: 'upstream is down' }, 500);

    const before = routerCallCount;
    for (const text of ['case ten a', 'case ten b', 'case ten c', 'case ten d']) {
      await bearer(
        api().post('/v1/chat/completions').send({
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
      api().patch(`/api/v1/routing/${AGENT_NAME}/smart-router`).send({
        enabled: true,
        model: { provider: 'openai', authType: 'api_key', model: ROUTER_MODEL },
      }),
    ).expect(200);
    expect(patched.body.enabled).toBe(true);
    expect(patched.body.model.model).toBe(ROUTER_MODEL);
  });
});
