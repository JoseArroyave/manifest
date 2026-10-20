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
