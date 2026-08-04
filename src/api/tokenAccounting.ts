/**
 * Token accounting for one chat turn.
 *
 * The agent tool loop turns a single user turn into N provider round-trips, so "how many tokens did
 * this cost" and "how much of the context window is occupied" stop being the same number, and the
 * tool machinery (definitions, call arguments, results) becomes a large share of the spend. These
 * pure helpers turn the AI SDK's per-step records into one aggregate breakdown per turn.
 *
 * Providers only report aggregates, so the per-slice figures are char-based estimates scaled to sum
 * to the reported totals. Figures the provider *does* report (reasoning tokens, cache reads) are
 * used verbatim and listed in `TokenBreakdown.exact` so the UI can drop the "~" marker on them.
 */
import { z } from 'zod';
import type { LanguageModelUsage, Tool } from 'ai';

/** Han / kana / hangul, which modern BPE tokenizers spend roughly one token per character on. */
const CJK_CHARS = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;
const CJK_CHARS_PER_TOKEN = 1.5;
const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Char-based token estimate, split by script. The request-size guard divides everything by 1.5,
 * which is right for this corpus' Chinese prose but overstates ASCII by ~2.6× — and the breakdown
 * mixes the two (Chinese system prompt and game data next to pure-ASCII tool schemas and tool-call
 * JSON), so a single divisor would misattribute whole slices. The guard stays conservative on
 * purpose; this is the attribution estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHARS)?.length ?? 0;
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + (text.length - cjk) / ASCII_CHARS_PER_TOKEN);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** One tool's input schema as the provider receives it. Built-in tools use zod; plugins may hand
 *  over a pre-built JSON Schema via the AI SDK `Schema` wrapper. */
function schemaText(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const wrapped = (schema as { jsonSchema?: unknown }).jsonSchema;
  if (wrapped) return safeStringify(wrapped);
  try {
    return safeStringify(z.toJSONSchema(schema as z.ZodType));
  } catch {
    // Neither zod nor a Schema wrapper — no reliable serialized form to measure.
    return '';
  }
}

/** Tool definitions are re-sent on *every* step of the agent loop, so their size is a first-class
 *  slice of input token spend. Cached against the registry object, which `getAgentTools()` keeps
 *  stable until a plugin hot-reloads. */
const toolDefTokenCache = new WeakMap<object, number>();

export function measureToolDefTokens(tools: Record<string, Tool> | null): number {
  if (!tools) return 0;
  const cached = toolDefTokenCache.get(tools);
  if (cached !== undefined) return cached;
  let tokens = 0;
  for (const [name, tool] of Object.entries(tools)) {
    const description = typeof tool.description === 'string' ? tool.description : '';
    tokens += estimateTokens(name + description + schemaText(tool.inputSchema));
  }
  toolDefTokenCache.set(tools, tokens);
  return tokens;
}

/** The parts of the SDK's `StepResult` this module needs. */
export interface StepLike {
  toolCalls: readonly { input?: unknown }[];
}

/** Tokens the model spent emitting tool-call arguments across the turn (output side). */
export function measureToolCallTokens(steps: readonly StepLike[]): number {
  return steps.reduce(
    (n, s) => n + s.toolCalls.reduce((m, c) => m + estimateTokens(safeStringify(c.input)), 0),
    0,
  );
}

/** Token basis for one turn, with the agent loop's prompt replay already expanded. */
export interface TurnBasis {
  in: {
    system: number;
    toolDefs: number;
    context: number;
    messages: number;
    toolTranscript: number;
  };
  out: { reasoning: number; toolCalls: number; answer: number };
  inTotal: number;
  outTotal: number;
  steps: number;
  /** The per-step base — system prompt, tool definitions, retrieved context and conversation, with
   *  no tool transcript. This is what a *next* request carries; the transcript never does. */
  baseIn: number;
  /** Tool transcript the final step carried, measured so it can be subtracted from the provider's
   *  last-step input figure. */
  lastStepTranscript: number;
}

/** Estimated tokens for the parts of a turn the caller can measure directly from its own strings. */
export interface TurnTokens {
  system: number;
  toolDefs: number;
  context: number;
  messages: number;
  reasoning: number;
  answer: number;
}

export interface TurnActivity {
  /** Token size of the `messages` array actually sent on each step, in step order — recorded by the
   *  tool-transcript shaper, which is the only place that sees the final outgoing prompt. Empty when
   *  there is no tool loop. */
  replay: number[];
  /** Tokens the model spent emitting tool-call arguments. */
  toolCallTokens: number;
}

/**
 * Expand one turn's token counts into a basis for attribution. The agent loop re-sends the whole
 * prompt on every step, so the fixed parts (system prompt, tool definitions, RAG context,
 * conversation) cost `steps` times over. The tool transcript is whatever each step's `messages`
 * carried beyond that fixed base — measured, not modelled, so it stays correct regardless of whether
 * the shaper had to shed anything.
 */
export function measureTurn(tokens: TurnTokens, activity: TurnActivity): TurnBasis {
  const stepCount = Math.max(activity.replay.length, 1);
  // Step 0's `messages` is the RAG prompt plus conversation history and nothing else — no tool call
  // has happened yet — so it *is* the per-step base. Taking it from the same measurement as the rest
  // of the replay keeps the two self-consistent; deriving it from `tokens.context + tokens.messages`
  // instead would mix two estimates and silently clamp the transcript to zero when they disagree.
  const perStepBase = activity.replay[0] ?? 0;
  const transcript = activity.replay.reduce((n, sent) => n + Math.max(sent - perStepBase, 0), 0);

  const inSlices = {
    system: tokens.system * stepCount,
    toolDefs: tokens.toolDefs * stepCount,
    context: tokens.context * stepCount,
    messages: tokens.messages * stepCount,
    toolTranscript: transcript,
  };
  const outSlices = {
    reasoning: tokens.reasoning,
    toolCalls: activity.toolCallTokens,
    answer: tokens.answer,
  };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const lastReplay = activity.replay.at(-1) ?? perStepBase;
  return {
    in: inSlices,
    out: outSlices,
    inTotal: sum(inSlices),
    outTotal: sum(outSlices),
    steps: stepCount,
    // With no tool loop there is no replay log, so fall back to the caller's own base estimate.
    baseIn:
      tokens.system +
      tokens.toolDefs +
      (activity.replay.length > 0 ? perStepBase : tokens.context + tokens.messages),
    lastStepTranscript: Math.max(lastReplay - perStepBase, 0),
  };
}

export interface ResolvedUsage {
  /** Turn totals, summed across every step of the agent loop. */
  promptTokens: number;
  completionTokens: number;
  /** Input tokens the *next* request will carry, for the usage bar and the client-side send gate. */
  contextTokens: number;
  /** Provider-reported detail, when the backend supplies it. */
  reasoningTokens?: number;
  cacheReadTokens?: number;
  estimated: boolean;
}

/** Resolve token usage for the finish event. `totalUsage` sums every step of the agent loop while
 *  `usage` covers only the last one — with a 100-step tool loop those differ by an order of
 *  magnitude, so turn totals must come from `totalUsage`.
 *  Many OpenAI-compatible backends omit (or return NaN/0) usage on streamed responses; in that case
 *  fall back to the char basis and flag the result as estimated so the UI can mark it with "~". */
export function resolveUsage(
  total: LanguageModelUsage | undefined,
  lastStep: LanguageModelUsage | undefined,
  basis: TurnBasis,
): ResolvedUsage {
  const num = (n: number | undefined): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  const inReal = num(total?.inputTokens);
  const outReal = num(total?.outputTokens);
  const promptTokens = inReal ?? basis.inTotal;
  const completionTokens = outReal ?? basis.outTotal;

  // What the next request will carry. The tool transcript is deliberately excluded: it exists only
  // inside one turn's step loop and is never sent again — only the answer joins the conversation.
  // Counting it would overstate the window, and since the client gates sending on this number, an
  // overstatement eventually blocks the conversation outright. Anchor on the provider's last-step
  // input figure and subtract the transcript the shaper measured on that step.
  const lastIn = num(lastStep?.inputTokens);
  const carriedOver =
    lastIn !== undefined ? Math.max(lastIn - basis.lastStepTranscript, 0) : basis.baseIn;

  return {
    promptTokens,
    completionTokens,
    contextTokens: carriedOver + basis.out.answer,
    reasoningTokens: num(total?.outputTokenDetails?.reasoningTokens),
    cacheReadTokens: num(total?.inputTokenDetails?.cacheReadTokens),
    estimated: inReal === undefined || outReal === undefined,
  };
}

export interface TokenBreakdown {
  /** Input slices; sum to the reported input total. */
  systemPrompt: number;
  toolDefs: number;
  context: number;
  messages: number;
  toolResults: number;
  /** Cached input tokens read — a *subset* of the input total, not another slice of it. 0 when the
   *  provider reports no cache detail. */
  cacheRead: number;
  /** Output slices; sum to the reported output total. */
  reasoning: number;
  toolCalls: number;
  answer: number;
  /** LLM round-trips in this turn: 1 without tools, N with an agent tool loop. */
  steps: number;
  /** Fields carrying a provider-reported exact count rather than a scaled char estimate. */
  exact: string[];
}

/**
 * Best-of-N ("max mode") accounting inputs. Every candidate is its own agent loop, so each has
 * its own `TurnBasis` (measured from its own transcript shaper) and its own provider usage pair.
 */
export interface BestOfNCandidateAccounting {
  i: number;
  basis: TurnBasis;
  totalUsage?: LanguageModelUsage;
  lastStepUsage?: LanguageModelUsage;
}

/** The synthesis ("judge") call: a single tool-less LLM call. */
export interface BestOfNJudgeAccounting {
  basis: TurnBasis;
  totalUsage?: LanguageModelUsage;
  lastStepUsage?: LanguageModelUsage;
}

/** TokenBreakdown plus the best-of-N fields. Existing fields keep their meanings — they sum the
 *  whole turn (all candidates + the judge). The extra fields are additive, per the stream contract. */
export interface BestOfNBreakdown extends TokenBreakdown {
  /** Number of candidate runs in this best-of-N turn. */
  candidates?: number;
  /** Per-candidate spend, in candidate order. */
  perCandidate?: { i: number; steps: number; promptTokens: number; completionTokens: number }[];
  /** The synthesis call's own spend. Absent when the turn fell back to a single candidate. */
  judge?: { promptTokens: number; completionTokens: number };
}

/**
 * Aggregate a best-of-N turn: N parallel candidate agent loops plus (usually) one judge call.
 *
 * The totals are plain sums — prompt/completion spend accumulates across every LLM round trip.
 * `contextTokens` is NOT a sum: only the final answer (the judge's, or the fallback candidate's)
 * enters the conversation, so next-request occupancy is the shared base prompt plus that answer,
 * with every candidate-loop token excluded — same semantics as the single-path turn.
 */
export function aggregateBestOfN(
  candidates: BestOfNCandidateAccounting[],
  judge: BestOfNJudgeAccounting | undefined,
  fallbackAnswer: string,
): {
  breakdown: BestOfNBreakdown;
  promptTokens: number;
  completionTokens: number;
  contextTokens: number;
  estimated: boolean;
} {
  const resolvedCandidates = candidates.map((c) =>
    resolveUsage(c.totalUsage, c.lastStepUsage, c.basis),
  );
  const resolvedJudge = judge
    ? resolveUsage(judge.totalUsage, judge.lastStepUsage, judge.basis)
    : undefined;

  const bases = [...candidates.map((c) => c.basis), ...(judge ? [judge.basis] : [])];
  const merged: TurnBasis = {
    in: {
      system: sum(bases.map((b) => b.in.system)),
      toolDefs: sum(bases.map((b) => b.in.toolDefs)),
      context: sum(bases.map((b) => b.in.context)),
      messages: sum(bases.map((b) => b.in.messages)),
      toolTranscript: sum(bases.map((b) => b.in.toolTranscript)),
    },
    out: {
      reasoning: sum(bases.map((b) => b.out.reasoning)),
      toolCalls: sum(bases.map((b) => b.out.toolCalls)),
      answer: sum(bases.map((b) => b.out.answer)),
    },
    inTotal: sum(bases.map((b) => b.inTotal)),
    outTotal: sum(bases.map((b) => b.outTotal)),
    steps: sum(bases.map((b) => b.steps)),
    baseIn: candidates[0]?.basis.baseIn ?? 0,
    lastStepTranscript: 0,
  };

  const promptTokens =
    sum(resolvedCandidates.map((r) => r.promptTokens)) + (resolvedJudge?.promptTokens ?? 0);
  const completionTokens =
    sum(resolvedCandidates.map((r) => r.completionTokens)) + (resolvedJudge?.completionTokens ?? 0);
  // A judge can succeed but produce no text — the turn then falls back to a draft, and that draft
  // (not the empty judge answer) is what enters the conversation, so measure it.
  const answerTokens = judge?.basis.out.answer
    ? judge.basis.out.answer
    : estimateTokens(fallbackAnswer);
  const reasoningTokens = [
    ...resolvedCandidates.map((r) => r.reasoningTokens),
    resolvedJudge?.reasoningTokens,
  ].filter((n): n is number => n !== undefined);
  const cacheReadTokens = [
    ...resolvedCandidates.map((r) => r.cacheReadTokens),
    resolvedJudge?.cacheReadTokens,
  ].filter((n): n is number => n !== undefined);

  const resolved: ResolvedUsage = {
    promptTokens,
    completionTokens,
    contextTokens: merged.baseIn + answerTokens,
    ...(reasoningTokens.length > 0 ? { reasoningTokens: sum(reasoningTokens) } : {}),
    ...(cacheReadTokens.length > 0 ? { cacheReadTokens: sum(cacheReadTokens) } : {}),
    estimated: resolvedCandidates.some((r) => r.estimated) || (resolvedJudge?.estimated ?? false),
  };

  const breakdown: BestOfNBreakdown = buildBreakdown(merged, resolved);
  breakdown.candidates = candidates.length;
  breakdown.perCandidate = resolvedCandidates.map((r, idx) => ({
    i: candidates[idx].i,
    steps: candidates[idx].basis.steps,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
  }));
  if (resolvedJudge) {
    breakdown.judge = {
      promptTokens: resolvedJudge.promptTokens,
      completionTokens: resolvedJudge.completionTokens,
    };
  }

  return {
    breakdown,
    promptTokens,
    completionTokens,
    contextTokens: resolved.contextTokens,
    estimated: resolved.estimated,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Distribute the reported input/output totals over the turn's char basis so the UI can show
 *  "where the tokens went" even when the provider only reports aggregates. Provider-reported detail
 *  (reasoning tokens, cache reads) is used verbatim and kept out of the scaling. */
export function buildBreakdown(basis: TurnBasis, usage: ResolvedUsage): TokenBreakdown {
  const exact: string[] = [];
  const scaler = (basisTotal: number, target: number) => {
    const s = basisTotal > 0 ? target / basisTotal : 0;
    return (n: number) => Math.round(n * s);
  };

  const inScale = scaler(basis.inTotal, usage.promptTokens);

  // Reasoning is billed as its own output slice by most providers, so prefer the reported figure
  // and scale only the remainder over the answer/tool-call basis.
  let reasoning: number;
  if (usage.reasoningTokens !== undefined) {
    reasoning = usage.reasoningTokens;
    exact.push('reasoning');
  } else {
    reasoning = scaler(basis.outTotal, usage.completionTokens)(basis.out.reasoning);
  }
  const outScale = scaler(
    basis.outTotal - basis.out.reasoning,
    Math.max(usage.completionTokens - reasoning, 0),
  );

  if (usage.cacheReadTokens !== undefined) exact.push('cacheRead');

  return {
    systemPrompt: inScale(basis.in.system),
    toolDefs: inScale(basis.in.toolDefs),
    context: inScale(basis.in.context),
    messages: inScale(basis.in.messages),
    toolResults: inScale(basis.in.toolTranscript),
    cacheRead: usage.cacheReadTokens ?? 0,
    reasoning,
    toolCalls: outScale(basis.out.toolCalls),
    answer: outScale(basis.out.answer),
    steps: basis.steps,
    exact,
  };
}
