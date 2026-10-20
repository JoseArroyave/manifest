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
    await waitFor(() => expect(mockGetSmartRouter).toHaveBeenCalled());
    expect(mockGetSmartRouter.mock.calls[0][0]).toBe('demo');
    expect(container.textContent).toContain('Smart Router');
    const btn = container.querySelector('.settings-switch') as HTMLButtonElement;
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('hides the model picker while the layer is off', async () => {
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(mockGetSmartRouter).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });

  it('shows the model picker and the last decision when enabled', async () => {
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

  it('toggles the include-the-router toggle', async () => {
    mockGetSmartRouter.mockResolvedValue({ ...OFF, enabled: true });
    mockUpdateSmartRouter.mockResolvedValue({
      ...OFF,
      enabled: true,
      include_router_in_candidates: false,
    });
    const { container } = render(() => <SmartRouterSettings agentName={() => 'demo'} />);
    await waitFor(() => expect(container.querySelectorAll('.settings-switch').length).toBe(2));
    const toggles = container.querySelectorAll('.settings-switch');
    const includeToggle = toggles[1] as HTMLButtonElement;
    fireEvent.click(includeToggle);
    await waitFor(() =>
      expect(mockUpdateSmartRouter).toHaveBeenCalledWith('demo', {
        include_router_in_candidates: false,
      }),
    );
  });
});
