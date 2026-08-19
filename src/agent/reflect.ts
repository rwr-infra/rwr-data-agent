/**
 * Reflection: one post-answer self-critique call, and the predicate that decides whether to pay for it.
 *
 * The answer has already streamed to the user by the time this runs — that is not a limitation to work
 * around, it is the design. Buffering the answer to check it before the user sees it would trade the
 * whole turn's time-to-first-token for a check that passes most of the time. So reflection appends: a
 * `reflection` event reporting what it found, plus a `revision` event carrying a rewritten answer when
 * it found anything. The original stays on screen; the revision is what enters the conversation.
 *
 * Two rules make this safe to leave switched on:
 *
 * - **It never throws.** Every failure — a provider that will not produce the object, a timeout, an
 *   abort — resolves to `undefined`, and the caller then emits nothing at all. A turn that already
 *   produced an answer must not be turned into a failure by its own optional check.
 * - **It never recurses.** A revision is not itself reflected on. One extra round trip per turn is a
 *   cost the operator opted into; an unbounded critique loop is not, and the second pass's marginal
 *   value is far below the first's.
 */
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { estimateTokens, measureTurn } from '../api/tokenAccounting.js';
import type { ReflectionAccounting } from '../api/tokenAccounting.js';
import type { SearchResult } from '../types/index.js';
import type { QueryCategory } from '../retrieval/intent.js';
import {
  REFLECTION_SYSTEM_PROMPT,
  buildReflectionPrompt,
  type ReflectionToolCallLine,
} from '../retrieval/reflectionPrompt.js';
import { buildReflectionProviderOptions } from '../llm/providerOptions.js';
import { summarizeToolInput, summarizeToolResult } from './synthesize.js';
import type { ChildObservation } from './synthesize.js';
import { isToolFailure } from './toolRuntime.js';

/**
 * Output cap for the reflection call, independent of the turn's own.
 *
 * The turn reserves up to `LLM_MAX_OUTPUT_TOKENS` (32768) because an enumeration answer can genuinely
 * need it. Reflection returns a verdict, a short findings list and — at most — a rewrite of an answer
 * that already fit, so handing it the turn's full reservation only buys a longer wait for something
 * the turn does not need.
 */
const MAX_REFLECTION_OUTPUT_TOKENS = 8192;

/**
 * Deadline for the whole reflection call.
 *
 * The user has their answer by now; what they are waiting on is the turn to close. An optional check
 * that keeps the stream open for minutes is worse than one that gives up — so this is deliberately
 * shorter than any tool deadline chain and pairs with `maxRetries: 1`, since three retries of a slow
 * call is three times the wait for something the turn does not need.
 */
const REFLECTION_TIMEOUT_MS = 60_000;

/** Finding categories. Open by contract — the event type documents that clients tolerate unknown
 *  values — but closed here, so a model cannot invent a category the UI has no wording for. */
export const REFLECTION_ISSUE_CODES = [
  'missing-citation',
  'missing-key',
  'scope-violation',
  'count-mismatch',
  'unsupported-claim',
  'no-answer',
  'other',
] as const;

/**
 * What the reflection call must return.
 *
 * A JSON object rather than markers in prose: a revised answer is arbitrary Markdown about game data,
 * so any delimiter chosen to separate it from the verdict is one the answer itself may contain.
 *
 * The schema validates a *parsed* object, it does not constrain generation. `generateObject` was tried
 * first and is wrong here — measured, the backend answers
 * `The feature "responseFormat" is not supported. JSON response format schema is only supported with
 * structuredOutputs`, so the schema never reaches the provider and the call fails on a real prompt with
 * `No object generated`. So this follows the session summarizer instead (`src/memory/summarizer.ts`),
 * which is the JSON path that already works in production here: ask for JSON in the prompt, parse it
 * leniently, validate after.
 */
export const ReflectionOutputSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z
    .array(
      z.object({
        code: z.enum(REFLECTION_ISSUE_CODES),
        detail: z.string().optional(),
      }),
    )
    .default([]),
  revisedAnswer: z.string().optional(),
});

export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;

/** Codes the model gets wrong in a predictable way, mapped rather than discarded. */
const CODE_ALIASES: Record<string, (typeof REFLECTION_ISSUE_CODES)[number]> = {
  'missing-source': 'missing-citation',
  'missing-file': 'missing-citation',
  'no-citation': 'missing-citation',
  'missing-keys': 'missing-key',
  'wrong-count': 'count-mismatch',
  'count-error': 'count-mismatch',
  unsupported: 'unsupported-claim',
  'unsupported-fact': 'unsupported-claim',
  'out-of-scope': 'scope-violation',
  'empty-answer': 'no-answer',
};

/**
 * Normalise one finding code onto the closed set.
 *
 * The model writes `missing_citation` for `missing-citation` about as often as not — measured — and a
 * finding dropped over a separator is a finding the user never sees. Punctuation is folded first, then
 * a small alias table, then anything still unrecognised becomes `other` with the original preserved in
 * `detail` so the signal is not lost.
 */
function normaliseCode(raw: string): {
  code: (typeof REFLECTION_ISSUE_CODES)[number];
  unknown?: string;
} {
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if ((REFLECTION_ISSUE_CODES as readonly string[]).includes(folded)) {
    return { code: folded as (typeof REFLECTION_ISSUE_CODES)[number] };
  }
  const aliased = CODE_ALIASES[folded];
  if (aliased) return { code: aliased };
  return { code: 'other', unknown: raw.trim() };
}

/**
 * Parse the reflection call's text into a validated output, or null when it is not usable.
 *
 * Lenient in exactly the ways models are sloppy — a ```json fence, prose either side of the object,
 * a snake_case code — and strict about the shape that reaches the caller. Returns null rather than
 * throwing: the caller's contract is that a reflection which cannot be read simply did not happen.
 */
export function parseReflectionOutput(text: string): ReflectionOutput | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  // Models like to introduce the object ("Here is the review: {...}"), so fall back to the outermost
  // braces rather than failing the whole parse over a preamble.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  if (verdict !== 'pass' && verdict !== 'fail') return null;

  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues = rawIssues.flatMap((entry) => {
    if (typeof entry === 'string') {
      const { code, unknown } = normaliseCode(entry);
      return [unknown ? { code, detail: unknown } : { code }];
    }
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.code !== 'string') return [];
    const { code, unknown } = normaliseCode(e.code);
    const detail = typeof e.detail === 'string' && e.detail.trim() ? e.detail.trim() : undefined;
    // An unrecognised code carries itself into `detail`, so folding it to `other` never loses which
    // check the model thought it was reporting.
    const merged = unknown
      ? [detail, `(reported as "${unknown}")`].filter(Boolean).join(' ')
      : detail;
    return [merged ? { code, detail: merged } : { code }];
  });

  const revisedAnswer =
    typeof obj.revisedAnswer === 'string' && obj.revisedAnswer.trim()
      ? obj.revisedAnswer
      : undefined;

  const validated = ReflectionOutputSchema.safeParse({ verdict, issues, revisedAnswer });
  return validated.success ? validated.data : null;
}

export interface ReflectionTriggerInput {
  /** `REFLECTION_ENABLED`. */
  enabled: boolean;
  toolFailureCount: number;
  /** The turn's own stop reason, already computed by the route. */
  stopReason: 'completed' | 'step-limit' | 'output-limit' | 'stopped';
  intent: QueryCategory;
  hasAnswer: boolean;
  stoppedByUser: boolean;
  clientGone: boolean;
}

/**
 * Decide whether a turn earns a reflection call, and report which signals selected it.
 *
 * Conditional rather than always-on because reflection re-sends the answer and the context once more:
 * measured turns on this corpus range from ~889K to ~2.5M input tokens, so a check on every turn is a
 * cost comparable to the turn itself. The signals are the states where the answer is most likely to be
 * wrong in a way the evidence can prove — a failed tool call (the model may have concluded absence from
 * it), an exhausted step budget (no answer at all), and the two intents whose output format the system
 * prompt constrains most heavily and least verifiably.
 *
 * `output-limit` is deliberately not a signal: the answer was truncated by the output cap, and a
 * rewrite would hit the same cap.
 *
 * Returns the matched signals, or null when reflection must not run.
 */
export function shouldReflect(input: ReflectionTriggerInput): string[] | null {
  // Nobody is waiting for it, or the user explicitly asked the turn to stop costing money.
  if (!input.enabled || input.stoppedByUser || input.clientGone || input.stopReason === 'stopped') {
    return null;
  }
  // An empty answer is only worth reviewing when the step budget explains it — reflection can rebuild
  // one from the transcript. Empty for any other reason means the stream itself went wrong, and there
  // is nothing to check or salvage.
  if (!input.hasAnswer && input.stopReason !== 'step-limit') return null;

  const triggers: string[] = [];
  if (input.toolFailureCount > 0) triggers.push('tool-failure');
  if (input.stopReason === 'step-limit') triggers.push('step-limit');
  if (input.intent === 'inheritance') triggers.push('intent-inheritance');
  if (input.intent === 'enumeration') triggers.push('intent-enumeration');
  // Debug-only: forces reflection on any otherwise eligible turn, for wiring up the client.
  if (triggers.length === 0 && process.env.DEBUG_REFLECTION === 'force') triggers.push('forced');
  return triggers.length > 0 ? triggers : null;
}

/** The parts of the SDK's `StepResult` the transcript needs. */
export interface ReflectionStepLike {
  toolCalls: readonly { toolCallId?: string; toolName?: string; input?: unknown }[];
  toolResults?: readonly { toolCallId?: string; toolName?: string; output?: unknown }[];
}

/**
 * Condense the SDK's step records into one line per tool call.
 *
 * Reuses the same summarisers the UI trace uses, so the checker sees exactly the calls the user saw,
 * and — more importantly — a bounded string per call. Replaying raw tool outputs here would put a
 * second copy of the whole transcript into a prompt that already carries the retrieval context.
 */
export function buildReflectionTranscript(
  steps: readonly ReflectionStepLike[],
): ReflectionToolCallLine[] {
  const lines: ReflectionToolCallLine[] = [];
  for (const step of steps) {
    const results = new Map((step.toolResults ?? []).map((r) => [r.toolCallId ?? '', r] as const));
    for (const call of step.toolCalls) {
      const result = results.get(call.toolCallId ?? '');
      const failed = result ? isToolFailure(result.output) : true;
      lines.push({
        toolName: call.toolName ?? '?',
        input: summarizeToolInput(call.toolName, call.input),
        // A call with no matching result never returned within the turn; saying so is more useful to
        // the checker than an empty string it would have to interpret.
        result: result
          ? summarizeToolResult(result.toolName ?? call.toolName, result.output)
          : 'no result',
        ok: !failed,
      });
    }
  }
  return lines;
}

export interface ReflectionOptions {
  model: LanguageModel;
  query: string;
  /** The streamed answer. Empty is valid on a `step-limit` turn. */
  answer: string;
  retrievedContext: SearchResult[];
  toolTranscript: ReflectionToolCallLine[];
  packageScope?: string;
  intent: QueryCategory;
  triggers: string[];
  maxOutputTokens: number;
  /** Prompt token ceiling — the same budget the turn's transcript shaper worked against. */
  budgetTokens?: number;
  abortSignal?: AbortSignal;
  startObservation?: (name: string, input?: unknown) => ChildObservation;
}

export interface ReflectionRunResult {
  /** `revised` iff a rewritten answer is present; the wire verdict, not the model's raw one. */
  verdict: 'pass' | 'revised';
  issues: { code: string; detail?: string }[];
  /** Present iff `verdict === 'revised'`. */
  revisedAnswer?: string;
  accounting: ReflectionAccounting;
}

/**
 * Run the reflection call. Never throws; returns undefined when nothing usable came back, in which
 * case the caller emits no reflection events at all and the turn finishes exactly as it would have.
 */
export async function runReflection(
  options: ReflectionOptions,
): Promise<ReflectionRunResult | undefined> {
  const prompt = buildReflectionPrompt({
    query: options.query,
    answer: options.answer,
    retrievedContext: options.retrievedContext,
    toolTranscript: options.toolTranscript,
    packageScope: options.packageScope,
    intent: options.intent,
    triggers: options.triggers,
    budgetTokens: options.budgetTokens,
  });
  const obs = options.startObservation?.('reflection', {
    input: { triggers: options.triggers, prompt },
  });

  let text = '';
  try {
    // The turn's abort (client gone, user stop) still wins; the deadline is an additional ceiling, so
    // whichever fires first ends the call.
    const deadline = AbortSignal.timeout(REFLECTION_TIMEOUT_MS);
    // Streamed, then accumulated — nothing goes to the client, so this is not about latency.
    // Measured: the same call as `generateText` fails with "Response Timeout by Origin Server" on a
    // real prompt. A non-streamed request sends no bytes until the model has finished, and the gateway
    // in front of this backend cuts it off first; the tool loop and the best-of-N judge stream for the
    // same reason. The one non-streamed call in this repo (the session summarizer) survives only
    // because its prompt is a few hundred characters.
    const result = streamText({
      model: options.model,
      system: REFLECTION_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: Math.min(options.maxOutputTokens, MAX_REFLECTION_OUTPUT_TOKENS),
      abortSignal: options.abortSignal
        ? AbortSignal.any([options.abortSignal, deadline])
        : deadline,
      maxRetries: 1,
      providerOptions: buildReflectionProviderOptions(),
    });

    // `fullStream`, not `textStream`: a stream-level error part has to throw into the catch below
    // rather than end the iteration quietly and leave a half-read verdict to parse.
    for await (const part of result.fullStream) {
      const p = part as {
        type: string;
        text?: string;
        textDelta?: string;
        delta?: string;
        error?: unknown;
      };
      if (p.type === 'text-delta' || p.type === 'text') {
        text += p.text ?? p.textDelta ?? p.delta ?? '';
      } else if (p.type === 'error') {
        throw p.error;
      }
    }
    const usage = await result.totalUsage;

    const output = parseReflectionOutput(text);
    if (!output) {
      console.warn(
        `[reflection] unparseable output, skipped: ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      );
      obs?.update({ level: 'WARNING', statusMessage: 'Reflection output unparseable' });
      return undefined;
    }
    const revised = output.revisedAnswer?.trim() ?? '';
    // A verdict of `fail` with no rewrite leaves nothing to show the user but a complaint about an
    // answer they cannot act on, so it degrades to a pass. The warning is the signal that the model
    // is not holding up its half of the contract.
    let verdict: 'pass' | 'revised' = 'pass';
    if (output.verdict === 'fail') {
      if (revised.length > 0) {
        verdict = 'revised';
      } else {
        console.warn(
          '[reflection] verdict=fail with no revisedAnswer — treating the turn as passed',
        );
      }
    }
    const issues = verdict === 'revised' ? output.issues : [];

    const basis = measureTurn(
      {
        system: estimateTokens(REFLECTION_SYSTEM_PROMPT),
        toolDefs: 0,
        context: estimateTokens(prompt),
        messages: 0,
        reasoning: 0,
        answer: estimateTokens(revised),
      },
      { replay: [], toolCallTokens: 0 },
    );

    console.log(
      `[reflection] verdict=${verdict} | triggers=${options.triggers.join(',')} | issues=${issues.map((i) => i.code).join(',') || 'none'}`,
    );
    obs?.update({
      output: { verdict, issues, revisedAnswer: revised.slice(0, 500) },
      usageDetails: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      },
    });

    return {
      verdict,
      issues,
      ...(verdict === 'revised' ? { revisedAnswer: revised } : {}),
      accounting: { basis, totalUsage: usage, lastStepUsage: usage },
    };
  } catch (err) {
    // A reflection that could not run is a reflection that did not happen, not a turn that failed.
    // Never surfaced as an `error` event — that one means the stream itself broke.
    //
    // Read defensively: the `error` stream part above rethrows whatever the provider put there, which
    // is not necessarily an Error. `(err as Error).message` on a null would throw a TypeError out of
    // this catch and break the never-throws contract on a turn that already has its answer.
    console.warn(`[reflection] skipped: ${err instanceof Error ? err.message : String(err)}`);
    obs?.update({ level: 'ERROR', statusMessage: 'Reflection failed' });
    return undefined;
  } finally {
    obs?.end();
  }
}
