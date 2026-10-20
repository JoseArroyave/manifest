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
    // Pin the agent this save targets. If the user switches harnesses before
    // it resolves, don't mutate the (now different) agent's config.
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
