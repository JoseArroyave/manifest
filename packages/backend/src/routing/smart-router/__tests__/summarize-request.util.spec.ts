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
