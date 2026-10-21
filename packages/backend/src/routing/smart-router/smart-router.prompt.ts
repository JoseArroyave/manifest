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
    const content = typeof message?.content === 'string' ? message.content : '';
    // Reasoning models (e.g. Ollama's gpt-oss) split their chain-of-thought
    // into a separate `reasoning` / `reasoning_content` field and can leave
    // `content` empty or JSON-free when the token budget is spent thinking.
    // The decision JSON then lives only in the reasoning text. Prefer the
    // content, but fall back to the reasoning when the content carries no JSON
    // object. This is additive: a normal provider whose content already holds
    // the JSON is returned unchanged — the reasoning branch only runs when the
    // content has no `{`.
    const reasoning =
      typeof message?.reasoning === 'string'
        ? message.reasoning
        : typeof message?.reasoning_content === 'string'
          ? message.reasoning_content
          : '';
    if (content.includes('{')) return content;
    if (reasoning.includes('{')) return content ? `${content}\n${reasoning}` : reasoning;
    if (content) return content;
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
