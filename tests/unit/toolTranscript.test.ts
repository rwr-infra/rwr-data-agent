import { describe, expect, it } from 'vitest';
import { createToolTranscriptShaper, shrinkToolOutput } from '../../src/agent/toolTranscript.js';

/** A tool message carrying one result, in the SDK's tagged-union output shape. */
function toolMessage(value: unknown, id = 'call-1') {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, output: { type: 'json', value } }],
  };
}

describe('shrinkToolOutput', () => {
  it('returns the value untouched when it already fits', () => {
    const value = { results: [1, 2, 3] };
    expect(shrinkToolOutput(value, 1000)).toBe(value);
  });

  it('drops whole array items rather than cutting mid-JSON', () => {
    const value = { results: Array.from({ length: 500 }, (_, i) => ({ key: `weapon_${i}` })) };
    const shrunk = shrinkToolOutput(value, 100) as { results: unknown[]; _shed: string };
    expect(shrunk.results.length).toBeGreaterThan(0);
    expect(shrunk.results.length).toBeLessThan(500);
    // Every surviving item is a whole item, so the result is still valid JSON the model can read.
    expect(shrunk.results.every((r) => typeof r === 'object' && r !== null)).toBe(true);
    expect(shrunk._shed).toContain('results: kept');
  });

  it('clips long strings and says how much went missing', () => {
    const value = { content: 'x'.repeat(20000) };
    const shrunk = shrinkToolOutput(value, 100) as { content: string; _shed: string };
    expect(shrunk.content.length).toBeLessThan(20000);
    expect(shrunk.content).toContain('chars dropped');
    expect(shrunk._shed).toContain('content: clipped');
  });

  it('clips a bare string input', () => {
    const shrunk = shrinkToolOutput('y'.repeat(20000), 100);
    expect(typeof shrunk).toBe('string');
    expect((shrunk as string).length).toBeLessThan(20000);
  });

  it('leaves primitives alone', () => {
    expect(shrinkToolOutput(42, 1)).toBe(42);
    expect(shrinkToolOutput(null, 1)).toBe(null);
  });
});

describe('createToolTranscriptShaper — provider compatibility (always applied)', () => {
  const shaper = () => createToolTranscriptShaper({ budgetTokens: 100_000, shedTargetTokens: 600 });

  it('reports no change when nothing needs rewriting', () => {
    const s = shaper();
    const out = s.prepare([{ role: 'user', content: 'hi' }]);
    expect(out).toEqual({});
  });

  // A tool result that resolved to `undefined` serializes to no content at all. The output is a
  // tagged union and the provider's converter switches on that tag, so the tag has to survive.
  it('replaces an empty tool result with a text "null", keeping the union tag', () => {
    const s = shaper();
    const out = s.prepare([toolMessage(undefined)]);
    const part = out.messages![0].content as { output: { type: string; value: unknown } }[];
    expect(part[0].output).toEqual({ type: 'text', value: 'null' });
  });

  // Volcengine rejects assistant messages whose content carries no text part.
  it('prepends a text part to an assistant message that only carries tool calls', () => {
    const s = shaper();
    const out = s.prepare([
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'getNode', input: {} }] },
    ]);
    const content = out.messages![0].content as { type: string; text?: string }[];
    expect(content[0]).toEqual({ type: 'text', text: ' ' });
    expect(content[1].type).toBe('tool-call');
  });

  it('leaves an assistant message that already has text alone', () => {
    const s = shaper();
    const out = s.prepare([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking that up' },
          { type: 'tool-call', toolName: 'getNode', input: {} },
        ],
      },
    ]);
    expect(out).toEqual({});
  });
});

describe('createToolTranscriptShaper — shedding', () => {
  it('does not shed while the prompt fits the budget', () => {
    const s = createToolTranscriptShaper({ budgetTokens: 100_000, shedTargetTokens: 600 });
    s.prepare([toolMessage({ content: 'x'.repeat(40_000) }, 'a')]);
    expect(s.shedSteps).toEqual([]);
  });

  it('sheds the oldest results and never the newest', () => {
    // `budgetTokens` is floored at MIN_BUDGET_TOKENS (4096), so the payload has to clear that.
    const s = createToolTranscriptShaper({ budgetTokens: 1, shedTargetTokens: 600 });
    const out = s.prepare([
      toolMessage({ content: 'a'.repeat(40_000) }, 'old'),
      toolMessage({ content: 'b'.repeat(40_000) }, 'new'),
    ]);

    const valueOf = (i: number) =>
      (out.messages![i].content as { output: { value: { content: string } } }[])[0].output.value;

    expect(s.shedSteps).toEqual([0]);
    expect(valueOf(0).content.length).toBeLessThan(40_000);
    // The newest result is what the model asked for on this very step — gutting it is the worst
    // possible loss, so it survives even when the budget is still blown.
    expect(valueOf(1).content).toHaveLength(40_000);
  });

  it('records one replay entry per step, in step order', () => {
    const s = createToolTranscriptShaper({ budgetTokens: 100_000, shedTargetTokens: 600 });
    s.prepare([{ role: 'user', content: 'hi' }]);
    s.prepare([{ role: 'user', content: 'hi' }, toolMessage({ results: [1, 2, 3] })]);

    expect(s.replay).toHaveLength(2);
    expect(s.replay[0]).toBeGreaterThan(0);
    // The transcript grows as tool results accumulate — this is what token accounting attributes.
    expect(s.replay[1]).toBeGreaterThan(s.replay[0]);
  });
});
