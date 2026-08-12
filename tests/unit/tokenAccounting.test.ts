import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage, Tool } from 'ai';
import {
  aggregateBestOfN,
  buildBreakdown,
  estimateTokens,
  measureToolCallTokens,
  measureToolDefTokens,
  measureTurn,
  resolveUsage,
  type TurnTokens,
} from '../../src/api/tokenAccounting.js';

const TOKENS: TurnTokens = {
  system: 100,
  toolDefs: 50,
  context: 200,
  messages: 80,
  reasoning: 30,
  answer: 120,
};

describe('estimateTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  // The two scripts are counted separately: a single divisor would misattribute whole slices,
  // because a Chinese system prompt sits next to pure-ASCII tool schemas in the same breakdown.
  it('counts CJK denser than ASCII', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('武器')).toBe(2);
    expect(estimateTokens('武器'.repeat(10))).toBeGreaterThan(estimateTokens('ab'.repeat(10)));
  });
});

describe('measureToolDefTokens', () => {
  it('is zero when the registry could not be built', () => {
    expect(measureToolDefTokens(null)).toBe(0);
  });

  /**
   * Tool definitions are re-sent on every step, so this is a first-class slice — and it is cached
   * against the registry *object identity*. `getAgentTools` keeps a per-scope registry alive for
   * exactly this reason; handing out a fresh object per request would re-measure every definition.
   */
  it('caches against the registry object identity', () => {
    const registry = {
      getNode: {
        description: 'Look up an entity',
        inputSchema: { jsonSchema: { type: 'object' } },
      },
    } as unknown as Record<string, Tool>;

    const first = measureToolDefTokens(registry);
    expect(first).toBeGreaterThan(0);

    // Same object, mutated: the cached figure must come back, proving the cache is keyed on
    // identity rather than recomputed. A fresh object would be measured again.
    (registry as Record<string, unknown>).extra = {
      description: 'x'.repeat(4000),
      inputSchema: { jsonSchema: {} },
    };
    expect(measureToolDefTokens(registry)).toBe(first);
    expect(measureToolDefTokens({ ...registry })).toBeGreaterThan(first);
  });
});

describe('measureToolCallTokens', () => {
  it('sums the arguments the model emitted across every step', () => {
    const steps = [
      { toolCalls: [{ input: { key: 'gkw_g36' } }, { input: { key: 'ak47' } }] },
      { toolCalls: [] },
    ];
    expect(measureToolCallTokens(steps)).toBe(
      estimateTokens('{"key":"gkw_g36"}') + estimateTokens('{"key":"ak47"}'),
    );
  });
});

describe('measureTurn', () => {
  /**
   * The loop re-sends the whole prompt on every step, so the fixed parts cost `steps` times over.
   * Step 0's `messages` is the RAG prompt plus history and nothing else — no tool call has happened
   * yet — so it *is* the per-step base, and everything above it is transcript.
   */
  it('multiplies the fixed slices by the step count and measures the transcript', () => {
    const basis = measureTurn(TOKENS, { replay: [100, 300, 250], toolCallTokens: 40 });

    expect(basis.steps).toBe(3);
    expect(basis.in.system).toBe(300);
    expect(basis.in.toolDefs).toBe(150);
    expect(basis.in.toolTranscript).toBe(0 + 200 + 150);
    expect(basis.out.toolCalls).toBe(40);
    expect(basis.lastStepTranscript).toBe(150);
  });

  it('never reports a negative transcript when a step shrank', () => {
    const basis = measureTurn(TOKENS, { replay: [500, 100], toolCallTokens: 0 });
    expect(basis.in.toolTranscript).toBe(0);
    expect(basis.lastStepTranscript).toBe(0);
  });

  it('falls back to the caller estimate with no tool loop', () => {
    const basis = measureTurn(TOKENS, { replay: [], toolCallTokens: 0 });
    expect(basis.steps).toBe(1);
    expect(basis.in.toolTranscript).toBe(0);
    expect(basis.baseIn).toBe(TOKENS.system + TOKENS.toolDefs + TOKENS.context + TOKENS.messages);
  });

  it('anchors baseIn on the measured step 0 when there was a loop', () => {
    const basis = measureTurn(TOKENS, { replay: [640, 900], toolCallTokens: 0 });
    expect(basis.baseIn).toBe(TOKENS.system + TOKENS.toolDefs + 640);
  });
});

const usage = (input: number, output: number): LanguageModelUsage =>
  ({ inputTokens: input, outputTokens: output }) as LanguageModelUsage;

describe('resolveUsage', () => {
  const basis = measureTurn(TOKENS, { replay: [500, 900], toolCallTokens: 20 });

  it('prefers the provider totals and is not flagged as estimated', () => {
    const r = resolveUsage(usage(9000, 400), usage(5000, 200), basis);
    expect(r.promptTokens).toBe(9000);
    expect(r.completionTokens).toBe(400);
    expect(r.estimated).toBe(false);
  });

  it('falls back to the char basis and flags it when the provider omits usage', () => {
    const r = resolveUsage(undefined, undefined, basis);
    expect(r.promptTokens).toBe(basis.inTotal);
    expect(r.completionTokens).toBe(basis.outTotal);
    expect(r.estimated).toBe(true);
  });

  it('treats NaN and zero from the provider as missing', () => {
    const r = resolveUsage(usage(NaN, 0), undefined, basis);
    expect(r.promptTokens).toBe(basis.inTotal);
    expect(r.estimated).toBe(true);
  });

  /**
   * `contextTokens` is occupancy, not spend. The tool transcript exists only inside one turn's step
   * loop and is never sent again, so it is subtracted from the provider's last-step input figure.
   * The client gates sending on this number — counting the transcript would eventually block the
   * conversation outright.
   */
  it('excludes the tool transcript from next-request occupancy', () => {
    const r = resolveUsage(usage(9000, 400), usage(5000, 200), basis);
    expect(basis.lastStepTranscript).toBe(400);
    expect(r.contextTokens).toBe(5000 - 400 + basis.out.answer);
    expect(r.contextTokens).toBeLessThan(r.promptTokens);
  });

  it('falls back to baseIn for occupancy when the last step reported nothing', () => {
    const r = resolveUsage(usage(9000, 400), undefined, basis);
    expect(r.contextTokens).toBe(basis.baseIn + basis.out.answer);
  });
});

describe('buildBreakdown', () => {
  const basis = measureTurn(TOKENS, { replay: [500, 900], toolCallTokens: 20 });

  it('distributes the reported totals over the char basis', () => {
    const resolved = resolveUsage(usage(9000, 400), usage(5000, 200), basis);
    const b = buildBreakdown(basis, resolved);

    const inputSlices = b.systemPrompt + b.toolDefs + b.context + b.messages + b.toolResults;
    // Scaled then rounded per slice, so allow one unit of rounding drift per slice.
    expect(Math.abs(inputSlices - resolved.promptTokens)).toBeLessThanOrEqual(5);
    expect(b.steps).toBe(2);
    expect(b.exact).toEqual([]);
  });

  it('uses provider-reported reasoning verbatim and marks it exact', () => {
    const resolved = {
      ...resolveUsage(usage(9000, 400), usage(5000, 200), basis),
      reasoningTokens: 111,
      cacheReadTokens: 2222,
    };
    const b = buildBreakdown(basis, resolved);

    expect(b.reasoning).toBe(111);
    expect(b.cacheRead).toBe(2222);
    expect(b.exact).toContain('reasoning');
    expect(b.exact).toContain('cacheRead');
  });

  it('does not divide by zero on an empty basis', () => {
    const empty = measureTurn(
      { system: 0, toolDefs: 0, context: 0, messages: 0, reasoning: 0, answer: 0 },
      { replay: [], toolCallTokens: 0 },
    );
    const b = buildBreakdown(empty, resolveUsage(undefined, undefined, empty));
    expect(Number.isFinite(b.systemPrompt)).toBe(true);
    expect(b.systemPrompt).toBe(0);
  });
});

describe('aggregateBestOfN', () => {
  const candidateBasis = measureTurn(TOKENS, { replay: [500, 900], toolCallTokens: 20 });
  const judgeBasis = measureTurn(
    { ...TOKENS, toolDefs: 0, answer: 300 },
    { replay: [], toolCallTokens: 0 },
  );

  const candidates = [
    { i: 0, basis: candidateBasis, totalUsage: usage(9000, 400), lastStepUsage: usage(5000, 200) },
    { i: 1, basis: candidateBasis, totalUsage: usage(7000, 300), lastStepUsage: usage(4000, 150) },
  ];
  const judge = {
    basis: judgeBasis,
    totalUsage: usage(2000, 500),
    lastStepUsage: usage(2000, 500),
  };

  it('sums spend across every candidate and the judge', () => {
    const agg = aggregateBestOfN(candidates, judge, 'fallback');
    expect(agg.promptTokens).toBe(9000 + 7000 + 2000);
    expect(agg.completionTokens).toBe(400 + 300 + 500);
    expect(agg.breakdown.candidates).toBe(2);
    expect(agg.breakdown.perCandidate).toHaveLength(2);
    expect(agg.breakdown.judge).toEqual({ promptTokens: 2000, completionTokens: 500 });
  });

  /**
   * Occupancy is NOT a sum. Only the final answer enters the conversation, so candidate-loop tokens
   * never occupy the next request — mirroring how the tool transcript is excluded on the normal
   * path. If the usage bar ever starts counting candidate context, this is the assertion that broke.
   */
  it('never sums candidate loops into next-request occupancy', () => {
    const agg = aggregateBestOfN(candidates, judge, 'fallback');
    expect(agg.contextTokens).toBe(candidateBasis.baseIn + judgeBasis.out.answer);
    expect(agg.contextTokens).toBeLessThan(agg.promptTokens);
  });

  // A judge can succeed but produce no text; the turn then falls back to a draft, and that draft
  // is what enters the conversation.
  it('measures the fallback answer when the judge produced nothing', () => {
    const silentJudge = {
      ...judge,
      basis: measureTurn({ ...TOKENS, toolDefs: 0, answer: 0 }, { replay: [], toolCallTokens: 0 }),
    };
    const agg = aggregateBestOfN(candidates, silentJudge, 'the fallback draft text');
    expect(agg.contextTokens).toBe(
      candidateBasis.baseIn + estimateTokens('the fallback draft text'),
    );
  });

  it('handles a turn with no judge at all', () => {
    const agg = aggregateBestOfN(candidates, undefined, 'draft');
    expect(agg.promptTokens).toBe(9000 + 7000);
    expect(agg.breakdown.judge).toBeUndefined();
  });

  it('is estimated when any single run was', () => {
    const agg = aggregateBestOfN([{ i: 0, basis: candidateBasis }, candidates[1]], judge, 'draft');
    expect(agg.estimated).toBe(true);
  });
});
