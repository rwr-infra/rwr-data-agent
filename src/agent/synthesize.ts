/**
 * Best-of-N synthesis ("max mode") orchestrator.
 *
 * One request becomes N parallel candidate agent loops — each with its own temperature, seed,
 * transcript shaper and step cap — followed by one tool-less synthesis ("judge") call that merges
 * the drafts into the final answer. The candidate loops stream their *tool steps* as progress
 * (`candidate-step` events); the judge's text/reasoning deltas are the final answer and stream
 * like a normal turn.
 *
 * Failure policy (the plan's rule): fewer than 2 successful drafts, or a judge that fails or
 * produces nothing, degrades to the "best" single draft — the one with the most steps whose
 * finishReason is not an error — emitted as a one-shot `text-delta`. When every candidate fails,
 * the answer is whatever partial text the longest one produced and the stop reason stays
 * `completed` rather than surfacing an error.
 *
 * Cost guardrail: each candidate runs under `stopWhen: stepCountIs(maxSteps)` (default 6). The
 * normal single path keeps its 100-step runaway backstop; best-of-N multiplies spend by N, so the
 * cap has to be tight here.
 */
import { streamText, stepCountIs } from 'ai';
import type { LanguageModel, Tool } from 'ai';
import { config } from '../config/index.js';
import { estimateTokens, measureToolCallTokens, measureTurn } from '../api/tokenAccounting.js';
import type {
  BestOfNCandidateAccounting,
  BestOfNJudgeAccounting,
  TurnBasis,
} from '../api/tokenAccounting.js';
import type { SearchResult } from '../types/index.js';
import { buildSynthesisPrompt } from '../retrieval/synthesisPrompt.js';
import { buildLlmProviderOptions, buildCandidateProviderOptions } from '../llm/providerOptions.js';
import { createToolTranscriptShaper } from './toolTranscript.js';
import { selectActiveTools } from './toolSelection.js';
import type { ToolDisclosureMeta } from './toolSelection.js';
import { isToolFailure, repairToolCall } from './toolRuntime.js';

/** Minimal Langfuse-style child observation; the route wires it to `chainObs.startObservation`. */
export interface ChildObservation {
  update(patch: Record<string, unknown>): void;
  end(): void;
}

export interface BestOfNOptions {
  /** Shared provider model for every candidate (providerOptions carry the per-candidate knobs). */
  model: LanguageModel;
  /** Model for the synthesis call — `JUDGE_MODEL`, or the main model by default. */
  judgeModel: LanguageModel;
  systemPrompt: string;
  /** History + the shared RAG user prompt. Identical for every candidate. */
  llmMessages: { role: 'user' | 'assistant'; content: string }[];
  query: string;
  /** The search results the RAG prompt was built from, re-shown to the judge. */
  retrievedContext: SearchResult[];
  tools: Record<string, Tool> | null;
  candidateCount: number;
  /** Candidate temperatures, cycled when there are fewer entries than candidates. */
  temperatures: number[];
  /** Seed of candidate 0; candidate i gets `seedBase + i`. */
  seedBase: number;
  /** Per-candidate agent step cap (`stopWhen`). */
  maxSteps: number;
  maxOutputTokens: number;
  /** Shared per-step token estimates (system / RAG context / conversation), identical for all. */
  inputTokens: { system: number; context: number; messages: number };
  toolDefTokens: number;
  /** Message-array token budget for each candidate's transcript shaper. */
  shaperBudgetTokens: number;
  disclosureMeta: ToolDisclosureMeta | undefined;
  disclosureThreshold: number;
  /** Write one NDJSON event line (plus flush). Shared by all candidates and the judge. */
  onEvent: (event: Record<string, unknown>) => void;
  /**
   * Aborts every candidate loop and the judge at once — wired to the HTTP request, so a client that
   * disconnects stops N parallel agent loops instead of paying for answers nobody reads.
   */
  abortSignal?: AbortSignal;
  /** Optional Langfuse child observation factory; each candidate and the judge get their own. */
  startObservation?: (name: string, input?: unknown) => ChildObservation;
}

export interface BestOfNCandidateResult extends BestOfNCandidateAccounting {
  ok: boolean;
  steps: number;
  answer: string;
  reasoning: string;
  temperature: number;
  seed: number;
  finishReason: string | undefined;
}

export interface BestOfNJudgeResult extends BestOfNJudgeAccounting {
  answer: string;
  reasoning: string;
  finishReason: string | undefined;
}

export interface BestOfNRunResult {
  /** The final answer: the judge's synthesis, or the fallback best draft. */
  answer: string;
  kind: 'synthesis' | 'fallback';
  perCandidate: BestOfNCandidateResult[];
  judge: BestOfNJudgeResult | undefined;
  stopReason: 'completed' | 'step-limit' | 'output-limit';
}

// ---------------------------------------------------------------------------
// Tool-input summarisers (shared with the single-path loop in chat.ts)
// ---------------------------------------------------------------------------

/** Read one field of a tool input as a display string. Tool inputs are model-produced JSON, so
 *  every field is `unknown` — anything non-scalar has no useful label form. */
function inputField(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Build a short human-readable summary of a tool call's input, shown to the UI. */
export function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  if (!toolName || !input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  const key = inputField(inp, 'key') || '?';
  const file = inputField(inp, 'file') || '?';
  switch (toolName) {
    case 'searchDocs': {
      const type = inputField(inp, 'type');
      return `Search: ${inputField(inp, 'query') || '?'}${type ? ` [${type}]` : ''}`;
    }
    case 'getInheritanceChain':
      return `Inheritance: ${key}`;
    case 'findReferences':
      return `References: ${key}`;
    case 'getTransformChain':
      return `Transform chain: ${key}`;
    case 'readSource': {
      const startLine = inputField(inp, 'startLine');
      return `Read: ${file}${startLine ? ` (L${startLine}-${inputField(inp, 'endLine')})` : ''}`;
    }
    case 'listFiles': {
      const type = inputField(inp, 'type');
      return `List: ${inputField(inp, 'pattern') || '?'}${type ? ` [${type}]` : ''}`;
    }
    case 'getScriptSymbols':
      return `Script symbols: ${file}`;
    case 'getNode':
      return `Lookup: ${key}`;
    case 'lookupUpgrade':
      return `Upgrade lookup: ${inputField(inp, 'query') || '?'}`;
    case 'lookupWeaponSkill':
      return `Skill lookup: ${inputField(inp, 'query') || '?'}`;
    default:
      return toolName;
  }
}

/** Build a short summary of a tool result for the UI. */
export function summarizeToolResult(_toolName: string | undefined, output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const out = output as Record<string, unknown>;
  // Failures come back through the runtime envelope as ordinary results, so check them first —
  // otherwise a `{error, hint}` payload would fall through and report "done".
  if (typeof out.error === 'string') return out.error;
  if (typeof out.total === 'number') return `${out.total} result(s)`;
  if (Array.isArray(out.chain)) return `${out.chain.length} layer(s)`;
  if (Array.isArray(out.parents)) return `${out.parents.length} parent(s)`;
  if (Array.isArray(out.referencedBy)) return `${out.referencedBy.length} ref(s)`;
  if (Array.isArray(out.symbols)) return `${out.symbols.length} symbol(s)`;
  if (typeof out.totalLines === 'number') return `${out.totalLines} line(s)`;
  return 'done';
}

// ---------------------------------------------------------------------------
// Candidate & judge runs
// ---------------------------------------------------------------------------

/** Execution time per tool call, filled by `experimental_onToolCallFinish`. */
function durationOf(
  toolDurations: Map<string, number>,
  id: string | undefined,
): number | undefined {
  if (!id) return undefined;
  const ms = toolDurations.get(id);
  toolDurations.delete(id);
  return ms;
}

/** Shared slice of a candidate basis — the fixed prompt parts, same for every candidate. */
function candidateBasis(
  options: BestOfNOptions,
  reasoningTokens: number,
  answerTokens: number,
  activity: { replay: number[]; toolCallTokens: number },
): TurnBasis {
  return measureTurn(
    {
      system: options.inputTokens.system,
      toolDefs: options.toolDefTokens,
      context: options.inputTokens.context,
      messages: options.inputTokens.messages,
      reasoning: reasoningTokens,
      answer: answerTokens,
    },
    activity,
  );
}

async function runCandidate(
  options: BestOfNOptions,
  i: number,
  temperature: number,
  seed: number,
): Promise<BestOfNCandidateResult> {
  // Each candidate gets its own shaper: it holds mutable replay state, and sharing one across
  // concurrent loops would interleave step measurements.
  const shaper = createToolTranscriptShaper({
    budgetTokens: options.shaperBudgetTokens,
    shedTargetTokens: config.toolShedResultTokens,
  });
  const toolDurations = new Map<string, number>();
  const obs = options.startObservation?.(`best-of-n-candidate-${i}`, {
    input: { temperature, seed },
  });

  let reasoningText = '';
  let answerText = '';
  let toolFailureCount = 0;

  try {
    options.onEvent({ type: 'candidate-open', candidate: i, total: options.candidateCount });

    const result = streamText({
      model: options.model,
      system: options.systemPrompt,
      messages: options.llmMessages,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      ...(options.tools
        ? {
            tools: options.tools,
            stopWhen: stepCountIs(options.maxSteps),
            prepareStep: ({
              messages,
              stepNumber,
            }: {
              messages: Record<string, unknown>[];
              stepNumber: number;
            }) => {
              const shaped = shaper.prepare(messages);
              const active = selectActiveTools(
                options.disclosureMeta,
                options.query,
                stepNumber,
                options.disclosureThreshold,
              );
              if (active) return { ...shaped, activeTools: active } as never;
              return shaped as never;
            },
            experimental_onToolCallFinish: ({ toolCall, durationMs }) => {
              toolDurations.set(toolCall.toolCallId, Math.round(durationMs));
            },
            experimental_repairToolCall: repairToolCall,
          }
        : {}),
      providerOptions: buildCandidateProviderOptions(temperature, seed),
      onFinish: ({ text, totalUsage }) => {
        obs?.update({
          output: text.slice(0, 500),
          usageDetails: {
            inputTokens: totalUsage?.inputTokens ?? 0,
            outputTokens: totalUsage?.outputTokens ?? 0,
            totalTokens: (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0),
            ...(totalUsage?.outputTokenDetails?.reasoningTokens
              ? { reasoningTokens: totalUsage.outputTokenDetails.reasoningTokens }
              : {}),
            ...(totalUsage?.inputTokenDetails?.cacheReadTokens
              ? { cacheReadInputTokens: totalUsage.inputTokenDetails.cacheReadTokens }
              : {}),
          },
        });
      },
    });

    for await (const part of result.fullStream) {
      const p = part as {
        type: string;
        text?: string;
        textDelta?: string;
        delta?: string;
        error?: unknown;
        toolName?: string;
        toolCallId?: string;
        input?: unknown;
        output?: unknown;
      };
      if (p.type === 'reasoning-delta' || p.type === 'reasoning') {
        const delta = p.text ?? p.textDelta ?? p.delta ?? '';
        if (delta) reasoningText += delta;
      } else if (p.type === 'text-delta' || p.type === 'text') {
        const delta = p.text ?? p.textDelta ?? p.delta ?? '';
        if (delta) answerText += delta;
      } else if (p.type === 'tool-call') {
        options.onEvent({
          type: 'candidate-step',
          candidate: i,
          toolName: p.toolName,
          summary: summarizeToolInput(p.toolName, p.input),
        });
      } else if (p.type === 'tool-result') {
        const failed = isToolFailure(p.output);
        if (failed) toolFailureCount++;
        options.onEvent({
          type: 'candidate-step',
          candidate: i,
          toolName: p.toolName,
          done: true,
          ok: !failed,
          durationMs: durationOf(toolDurations, p.toolCallId),
          summary: summarizeToolResult(p.toolName, p.output),
        });
      } else if (p.type === 'tool-error') {
        toolFailureCount++;
        const message = p.error instanceof Error ? p.error.message : String(p.error);
        console.warn(`[best-of-n] candidate ${i} tool-error ${p.toolName ?? '?'} — ${message}`);
        options.onEvent({
          type: 'candidate-step',
          candidate: i,
          toolName: p.toolName,
          done: true,
          ok: false,
          durationMs: durationOf(toolDurations, p.toolCallId),
          summary: message.split('. Available tools:')[0],
        });
      } else if (p.type === 'error') {
        throw p.error;
      }
    }

    const finishReason = await result.finishReason;
    const [totalUsage, lastStepUsage, stepResults] = await Promise.all([
      result.totalUsage,
      result.usage,
      result.steps,
    ]);
    const basis = candidateBasis(
      options,
      estimateTokens(reasoningText),
      estimateTokens(answerText),
      { replay: shaper.replay, toolCallTokens: measureToolCallTokens(stepResults) },
    );
    options.onEvent({ type: 'candidate-close', candidate: i, ok: true, steps: basis.steps });
    if (toolFailureCount > 0) {
      console.warn(
        `[best-of-n] candidate ${i} had ${toolFailureCount} failed tool call(s) | finishReason=${finishReason} | answerLen=${answerText.length}`,
      );
    }
    return {
      i,
      ok: true,
      steps: basis.steps,
      answer: answerText,
      reasoning: reasoningText,
      basis,
      totalUsage,
      lastStepUsage,
      temperature,
      seed,
      finishReason: finishReason ?? undefined,
    };
  } catch (err) {
    console.warn(`[best-of-n] candidate ${i} failed: ${(err as Error).message}`);
    obs?.update({ level: 'ERROR', statusMessage: `Candidate ${i} failed` });
    // Partial accounting: whatever the shaper recorded before the stream broke is real spend.
    const basis = candidateBasis(
      options,
      estimateTokens(reasoningText),
      estimateTokens(answerText),
      {
        replay: shaper.replay,
        toolCallTokens: 0,
      },
    );
    options.onEvent({ type: 'candidate-close', candidate: i, ok: false, steps: basis.steps });
    return {
      i,
      ok: false,
      steps: basis.steps,
      answer: answerText,
      reasoning: reasoningText,
      basis,
      totalUsage: undefined,
      lastStepUsage: undefined,
      temperature,
      seed,
      finishReason: 'error',
    };
  } finally {
    obs?.end();
  }
}

async function runJudge(
  options: BestOfNOptions,
  drafts: BestOfNCandidateResult[],
): Promise<BestOfNJudgeResult | undefined> {
  const prompt = buildSynthesisPrompt(
    options.query,
    options.retrievedContext,
    drafts.map((d) => ({ i: d.i, answer: d.answer })),
    // Same budget the candidates' transcript shaper works against: window × ratio, minus the system
    // prompt, tool definitions and the output reservation. The judge carries no tools, so counting
    // their definitions here only makes it more conservative.
    options.shaperBudgetTokens,
  );
  const obs = options.startObservation?.('best-of-n-judge', { input: { prompt } });
  let reasoningText = '';
  let answerText = '';

  try {
    // The judge is a single-shot synthesis call: no tools, no transcript shaper, no step loop.
    const result = streamText({
      model: options.judgeModel,
      system: options.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      providerOptions: buildLlmProviderOptions(),
      onFinish: ({ text, totalUsage }) => {
        obs?.update({
          output: text.slice(0, 500),
          usageDetails: {
            inputTokens: totalUsage?.inputTokens ?? 0,
            outputTokens: totalUsage?.outputTokens ?? 0,
            totalTokens: (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0),
            ...(totalUsage?.outputTokenDetails?.reasoningTokens
              ? { reasoningTokens: totalUsage.outputTokenDetails.reasoningTokens }
              : {}),
          },
        });
      },
    });

    for await (const part of result.fullStream) {
      const p = part as {
        type: string;
        text?: string;
        textDelta?: string;
        delta?: string;
        error?: unknown;
      };
      if (p.type === 'reasoning-delta' || p.type === 'reasoning') {
        const delta = p.text ?? p.textDelta ?? p.delta ?? '';
        if (delta) {
          reasoningText += delta;
          options.onEvent({ type: 'reasoning-delta', textDelta: delta });
        }
      } else if (p.type === 'text-delta' || p.type === 'text') {
        const delta = p.text ?? p.textDelta ?? p.delta ?? '';
        if (delta) {
          answerText += delta;
          options.onEvent({ type: 'text-delta', textDelta: delta });
        }
      } else if (p.type === 'error') {
        throw p.error;
      }
    }

    const finishReason = await result.finishReason;
    const [totalUsage, lastStepUsage] = await Promise.all([result.totalUsage, result.usage]);
    const basis = measureTurn(
      {
        system: estimateTokens(options.systemPrompt),
        toolDefs: 0,
        context: estimateTokens(prompt),
        messages: 0,
        reasoning: estimateTokens(reasoningText),
        answer: estimateTokens(answerText),
      },
      { replay: [], toolCallTokens: 0 },
    );
    return {
      answer: answerText,
      reasoning: reasoningText,
      basis,
      totalUsage,
      lastStepUsage,
      finishReason: finishReason ?? undefined,
    };
  } catch (err) {
    console.warn(`[best-of-n] judge failed: ${(err as Error).message}`);
    obs?.update({ level: 'ERROR', statusMessage: 'Judge failed' });
    // If text already streamed to the client, keep it as the answer rather than discarding it —
    // otherwise runBestOfN would treat this as a judge failure and emit a fallback draft on top of
    // the partial output the client already received (duplicated / garbled message).
    if (answerText.length > 0) {
      const basis = measureTurn(
        {
          system: estimateTokens(options.systemPrompt),
          toolDefs: 0,
          context: estimateTokens(prompt),
          messages: 0,
          reasoning: estimateTokens(reasoningText),
          answer: estimateTokens(answerText),
        },
        { replay: [], toolCallTokens: 0 },
      );
      return {
        answer: answerText,
        reasoning: reasoningText,
        basis,
        totalUsage: undefined,
        lastStepUsage: undefined,
        finishReason: 'error',
      };
    }
    return undefined;
  } finally {
    obs?.end();
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** "Best" draft = prefer one that actually produced text, then the most steps whose finishReason
 *  is not an error. A longer run that ended with no answer is useless, so a text-bearing draft
 *  always wins over a textless one. When none have text, fall back to the longest partial run. */
function bestCandidate(perCandidate: BestOfNCandidateResult[]): BestOfNCandidateResult | undefined {
  const withText = perCandidate.filter((c) => c.answer.trim().length > 0);
  const nonError = withText.filter((c) => c.finishReason !== 'error');
  const pool = nonError.length > 0 ? nonError : withText.length > 0 ? withText : perCandidate;
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => b.steps - a.steps)[0];
}

function reasonOf(c: BestOfNCandidateResult): 'completed' | 'step-limit' | 'output-limit' {
  if (c.finishReason === 'length') return 'output-limit';
  if (c.finishReason === 'tool-calls' && c.answer.trim().length === 0) return 'step-limit';
  return 'completed';
}

/** Degenerate result for a run whose own catch could not contain the failure. */
function failedCandidate(options: BestOfNOptions, i: number): BestOfNCandidateResult {
  const basis = candidateBasis(options, 0, 0, { replay: [], toolCallTokens: 0 });
  return {
    i,
    ok: false,
    steps: basis.steps,
    answer: '',
    reasoning: '',
    basis,
    totalUsage: undefined,
    lastStepUsage: undefined,
    temperature: 0,
    seed: 0,
    finishReason: 'error',
  };
}

/**
 * Run the whole best-of-N turn: candidates in parallel, then the judge (or the fallback), emitting
 * NDJSON events through `onEvent` as they happen. Never throws — every failure inside resolves to a
 * fallback answer so the route can always write a normal `finish`.
 */
export async function runBestOfN(options: BestOfNOptions): Promise<BestOfNRunResult> {
  const temperatures = options.temperatures.length > 0 ? options.temperatures : [0.3, 0.6, 0.9];

  const settled = await Promise.allSettled(
    Array.from({ length: options.candidateCount }, (_, i) =>
      runCandidate(options, i, temperatures[i % temperatures.length], options.seedBase + i),
    ),
  );
  const perCandidate = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : failedCandidate(options, i),
  );

  // A draft counts as successful when its loop finished without throwing AND it produced text.
  const okCandidates = perCandidate.filter((c) => c.ok && c.answer.trim().length > 0);

  let answer: string;
  let kind: 'synthesis' | 'fallback';
  let judge: BestOfNJudgeResult | undefined;
  let stopReason: 'completed' | 'step-limit' | 'output-limit' = 'completed';

  if (okCandidates.length >= 2) {
    judge = await runJudge(options, okCandidates);
    if (judge && judge.answer.trim().length > 0) {
      kind = 'synthesis';
      answer = judge.answer;
      // The judge is tool-less, so the only early stop it can hit is the output cap.
      if (judge.finishReason === 'length') stopReason = 'output-limit';
    } else {
      kind = 'fallback';
      const best = bestCandidate(perCandidate);
      answer = best?.answer ?? '';
      if (best) stopReason = reasonOf(best);
    }
  } else {
    // Fewer than 2 successful drafts — degrade to the best single one. All-failed keeps
    // `completed` with whatever partial text exists, per the plan's fallback rule.
    kind = 'fallback';
    const best = bestCandidate(perCandidate);
    answer = best?.answer ?? '';
    if (best) stopReason = reasonOf(best);
    else stopReason = 'completed';
  }

  if (kind === 'fallback' && answer) {
    options.onEvent({ type: 'text-delta', textDelta: answer });
  }
  options.onEvent({
    type: 'candidates',
    kind,
    list: perCandidate.map((c) => ({ i: c.i, steps: c.steps, ok: c.ok, answer: c.answer })),
  });

  return { answer, kind, perCandidate, judge, stopReason };
}
