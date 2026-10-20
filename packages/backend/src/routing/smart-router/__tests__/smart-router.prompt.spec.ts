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
