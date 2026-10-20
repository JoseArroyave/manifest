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
