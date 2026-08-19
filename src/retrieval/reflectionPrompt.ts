/**
 * Prompt for the post-answer reflection call.
 *
 * Reflection is a single-shot LLM call with NO tools, run *after* the answer has already streamed to
 * the user. Its input is the question, the answer, the retrieval context the answer was written from
 * and a one-line-per-call summary of the tool transcript. It reports findings and — only when it
 * found something — rewrites the answer.
 *
 * The checks are deliberately the ones the system prompt already *asks* for and nothing else
 * (citations, keys, package scope, enumeration counts, claims with no evidence). Those instructions
 * have never been verified programmatically; a checker that also invented new style preferences would
 * rewrite answers that were fine, which costs tokens and confuses the reader for no gain.
 *
 * An empty answer is a valid input, not an error: a turn that exhausted its step budget streams
 * nothing, and rebuilding an answer from a transcript full of real tool results is the single most
 * valuable thing reflection can do. The prompt handles it as its own case rather than reporting a
 * pile of missing-citation findings about a string that does not exist.
 */
import { estimateTokens } from '../api/tokenAccounting.js';
import type { SearchResult } from '../types/index.js';
import type { QueryCategory } from './intent.js';

/** Per-document cap inside the context block, matching the judge prompt. */
const MAX_RESULT_CHARS = 600;
/** Total budget for the context block, mirroring the judge prompt's cap for the same reason: an
 *  enumeration turn can carry 150 hits, which reaches ~90K chars on its own. */
const MAX_CONTEXT_CHARS = 24000;
/** Rough token cost of this prompt's fixed scaffolding (headings + the numbered checklist). */
const TEMPLATE_TOKENS = 700;
/** However tight the budget, the answer is never cut below this — a stub answer cannot be checked. */
const MIN_ANSWER_TOKENS = 500;
/** Newest tool calls survive a transcript cut: the last calls are the ones the answer was built on. */
const MIN_TRANSCRIPT_LINES = 5;

/**
 * The system prompt for the reflection call — deliberately its own, not the agent's.
 *
 * Reusing `SYSTEM_PROMPT` was the obvious move and is wrong: it is ~7.5K characters of instructions
 * for *answering* (which tool to reach for, how many attempts before conceding absence), none of
 * which applies to a checker, and it would put the reflection call's own cost in the same order as
 * the turn it is checking.
 */
export const REFLECTION_SYSTEM_PROMPT = `You are a reviewer for a Running With Rifles (RWR) game data assistant.

You receive a question, the assistant's answer, the retrieved documents the answer was written from,
and a summary of the tool calls it made. Judge the answer against that evidence only. You have no
tools and cannot look anything up: if a claim's support is not in the material you were given, that
is itself the finding.

Report findings, and rewrite the answer only when you found at least one. A clean answer is the
normal outcome — do not manufacture findings to look diligent, and do not report matters of style,
tone, length or formatting preference. Never mention this review, the checklist, or yourself in a
rewritten answer: the reader sees it as the answer, not as a correction.`;

/** One tool call as the reflection prompt sees it — already summarised, never the raw payload. */
export interface ReflectionToolCallLine {
  toolName: string;
  /** `summarizeToolInput` output, e.g. `Inheritance: gkw_g36.weapon`. */
  input: string;
  /** `summarizeToolResult` output, e.g. `2 layer(s)` or the error message. */
  result: string;
  ok: boolean;
}

export interface ReflectionPromptOptions {
  query: string;
  /** The answer under review. Empty is valid — see the module comment. */
  answer: string;
  retrievedContext: SearchResult[];
  /** Empty in max mode: candidate tool steps never leave the orchestrator. */
  toolTranscript: ReflectionToolCallLine[];
  packageScope?: string;
  intent: QueryCategory;
  /** Risk signals that selected this turn, echoed into the prompt so the checker knows why. */
  triggers: string[];
  /** Token ceiling for the whole prompt. Omitted = no trimming (CLI / test callers). */
  budgetTokens?: number;
}

export function buildReflectionPrompt(options: ReflectionPromptOptions): string {
  const context = renderContext(options.retrievedContext);
  const { answer, transcript } = fitInput(options, context);

  const scopeCheck = options.packageScope
    ? `\n5. **Package scope** — the turn is scoped to package \`${options.packageScope}\`. Report \`scope-violation\` for any entity presented as belonging to a different package.`
    : '';
  const countCheck =
    options.intent === 'enumeration'
      ? `\n6. **Counts** — this is an enumeration answer. Report \`count-mismatch\` when a stated total disagrees with the number of entries actually listed, or with the number of matching items in the evidence.`
      : '';

  const answerBlock =
    answer.trim().length > 0
      ? `### The answer under review\n${answer}`
      : `### The answer under review\n(empty — the assistant ran out of tool steps before writing one)\n\nReport a single \`no-answer\` finding and write the answer yourself from the evidence below. If the evidence genuinely does not support an answer, say what was established and what is still missing — that is a better answer than none.`;

  return `Review the answer below against the evidence, then report findings.

### Question
${options.query}

${answerBlock}

### Retrieved context (what the assistant was given)
${context}

### Tool calls the assistant made
${transcript}

### Checklist
Reflection ran because: ${options.triggers.join(', ')}.
1. **Evidence** — every number, name, file path and relationship must be traceable to the retrieved context or a tool result above. Report \`unsupported-claim\` for anything else, quoting the claim in \`detail\`.
2. **Citations** — attribute values to the source file they came from. Report \`missing-citation\` when a value is stated with no file behind it.
3. **Keys** — every entity is shown as \`**Localized Name** (\\\`key\\\`)\`. Report \`missing-key\` when a name appears with no key beside it.
4. **Failed tools** — a tool call that failed is not evidence of absence. Report \`unsupported-claim\` if the answer concluded "not found" from failures alone.${scopeCheck}${countCheck}

### Output
Output ONLY a JSON object, no markdown fence, no prose around it:

\`{"verdict": "pass" | "fail", "issues": [{"code": "<one of the codes above>", "detail": "<the claim at fault>"}], "revisedAnswer": "<full rewritten answer>"}\`

- No findings: \`"verdict": "pass"\`, \`"issues": []\`, omit \`revisedAnswer\`.
- Any finding: \`"verdict": "fail"\`, one \`issues\` entry per finding, and a **complete** \`revisedAnswer\` — the reader sees it instead of the original, so it must stand alone, fix every finding, keep everything that was already right, and add no facts beyond the evidence above.
- Write the revised answer in the language of the question, as Markdown, in the same shape as the original (\`**Name** (\\\`key\\\`)\` plus source files). No process labels, no headings like "Thought" or "Observation", no note about it being a revision.`;
}

/**
 * Trim the answer and the transcript so the prompt fits `budgetTokens`.
 *
 * The question and the context are never trimmed here: they are the evidence the check is made
 * against, and the context already carries its own char cap. The answer is cut before the transcript
 * because a truncated answer still supports most checks, while a transcript missing its newest calls
 * loses exactly the evidence the answer's last claims rest on. Both cuts announce themselves inline,
 * so the checker never reads a truncation as the assistant stopping mid-sentence and reports it as a
 * finding.
 */
function fitInput(
  options: ReflectionPromptOptions,
  context: string,
): { answer: string; transcript: string } {
  const lines = options.toolTranscript.map(renderCall);
  const full = { answer: options.answer, transcript: renderTranscript(lines) };
  const budget = options.budgetTokens;
  if (budget === undefined || !Number.isFinite(budget)) return full;

  const fixed = estimateTokens(context) + estimateTokens(options.query) + TEMPLATE_TOKENS;
  let available = budget - fixed;
  if (available <= 0) available = MIN_ANSWER_TOKENS;

  let answer = options.answer;
  const answerTokens = estimateTokens(answer);
  const transcriptTokens = estimateTokens(full.transcript);
  if (answerTokens + transcriptTokens <= available) return full;

  // Give the answer everything left after the transcript's own floor, then let the transcript take
  // what the answer did not need.
  const answerBudget = Math.max(available - MIN_ANSWER_TOKENS, MIN_ANSWER_TOKENS);
  if (answerTokens > answerBudget) {
    // estimateTokens is linear in length, so scaling by the token ratio lands on the budget without
    // a search loop.
    const keep = Math.max(Math.floor(answer.length * (answerBudget / answerTokens)), 1);
    answer = answer.slice(0, keep) + '\n…[answer truncated to fit the review input budget]';
  }
  let kept = lines;
  const transcriptBudget = Math.max(available - estimateTokens(answer), 0);
  while (
    kept.length > MIN_TRANSCRIPT_LINES &&
    estimateTokens(renderTranscript(kept)) > transcriptBudget
  ) {
    kept = kept.slice(1);
  }
  const dropped = lines.length - kept.length;
  const transcript =
    dropped > 0
      ? `…(${dropped} earlier call(s) omitted to fit the review input budget)\n` +
        renderTranscript(kept)
      : renderTranscript(kept);
  return { answer, transcript };
}

function renderCall(c: ReflectionToolCallLine): string {
  return `- ${c.toolName}(${c.input}) → ${c.ok ? c.result : `FAILED: ${c.result}`}`;
}

function renderTranscript(lines: string[]): string {
  if (lines.length === 0) {
    return '(none recorded — check the answer against the retrieved context alone, and do not treat a claim as unsupported merely because no tool call is listed here)';
  }
  return lines.join('\n');
}

/** Render the retrieved context under a total char budget: full documents until the budget is spent,
 *  then identity-only one-liners, so the checker still sees every hit that existed. Mirrors
 *  `buildUserPrompt` and the judge prompt. */
function renderContext(retrievedContext: SearchResult[]): string {
  if (retrievedContext.length === 0) {
    return '(no retrieved context — this turn was answered from tool results; judge the answer against the tool calls below)';
  }
  const full: string[] = [];
  const omitted: SearchResult[] = [];
  let used = 0;
  for (const r of retrievedContext) {
    const block = renderFull(r);
    if (used + block.length <= MAX_CONTEXT_CHARS) {
      full.push(block);
      used += block.length;
    } else {
      omitted.push(r);
    }
  }
  const parts = [full.join('\n\n')];
  if (omitted.length > 0) {
    parts.push(
      `…(${omitted.length} more, identity only)\n` + omitted.map((r) => oneLiner(r)).join('\n'),
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

function renderFull(r: SearchResult): string {
  const name = typeof r.metadata.name === 'string' ? r.metadata.name : '';
  const meta = [r.type, r.key, name, r.metadata.mod_name, r.metadata.file_path]
    .filter(Boolean)
    .join(' | ');
  const content =
    r.content.length > MAX_RESULT_CHARS ? r.content.slice(0, MAX_RESULT_CHARS) + '…' : r.content;
  return `[${meta}]\n${content}`;
}

function oneLiner(r: SearchResult): string {
  const name = typeof r.metadata.name === 'string' ? r.metadata.name : '';
  return [r.key, r.type, name, r.metadata.mod_name, r.metadata.file_path]
    .filter(Boolean)
    .join(' | ');
}
