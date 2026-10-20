import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';

const mockGetMessageDetails = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getMessageDetails: (...args: unknown[]) => mockGetMessageDetails(...args),
  flagMessageMiscategorized: vi.fn(),
  clearMessageMiscategorized: vi.fn(),
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderName: (m: string) => (m.startsWith('gpt') ? 'OpenAI' : m),
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

import MessageDetails from '../../src/components/MessageDetails';

const baseMessage = {
  id: 'msg-1',
  timestamp: '2026-02-16 10:00:00',
  agent_name: 'test-agent',
  model: 'gpt-4o',
  status: 'ok',
  autofix_status: null,
  error_message: null,
  description: null,
  service_type: 'agent',
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0.05,
  duration_ms: 1200,
  trace_id: 'trace-abc123',
  routing_tier: 'standard',
  routing_reason: 'smart_router',
  specificity_category: null,
  specificity_miscategorized: false,
  auth_type: 'api_key',
  provider_key_label: null,
  skill_name: null,
  fallback_from_model: null,
  fallback_index: null,
  session_key: null,
  feedback_rating: null,
  feedback_tags: null,
  feedback_details: null,
  request_headers: null,
  request_params: null,
  header_tier_id: null,
  header_tier_name: null,
  header_tier_color: null,
  caller_attribution: null,
  autofix_applied: false,
  autofix_role: null,
  autofix_operations: null,
  autofix_decision: null,
  autofix_sibling: null,
  router_decision_provider: null,
  router_decision_model: null,
  router_decision_reason: null,
  router_decision_latency_ms: null,
};

describe('MessageDetails Smart Router decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('shows the model the router picked', async () => {
    mockGetMessageDetails.mockResolvedValue({
      message: {
        ...baseMessage,
        router_decision_provider: 'anthropic',
        router_decision_model: 'claude-opus-4-6',
        router_decision_reason: 'needs deep reasoning',
        router_decision_latency_ms: 380,
      },
    });

    const { container } = render(() => <MessageDetails messageId="msg-1" />);

    await vi.waitFor(() => expect(container.textContent).toContain('Smart Router chose'));
    expect(container.textContent).toContain('claude-opus-4-6');
    expect(container.textContent).toContain('380 ms');
    expect(container.textContent).toContain('needs deep reasoning');
  });

  it('hides the decision when the row is not a router hop', async () => {
    mockGetMessageDetails.mockResolvedValue({ message: { ...baseMessage } });

    const { container } = render(() => <MessageDetails messageId="msg-1" />);

    await vi.waitFor(() => expect(container.textContent).toContain('Routing'));
    expect(container.textContent).not.toContain('Smart Router chose');
  });
});
