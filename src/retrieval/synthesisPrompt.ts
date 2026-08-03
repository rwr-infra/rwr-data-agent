/**
 * Prompt for the best-of-N synthesis ("judge") call.
 *
 * The judge is a single-shot LLM call with NO tools: its input is the original question, the
 * shared retrieval context the candidates saw, and the N candidate answers. It merges them into
 * one final answer. The final answer must be self-contained — it is the only thing that enters
 * the conversation history — so the prompt says so explicitly instead of assuming the judge can
 * lean on anything that will not be replayed.
 *
 * Divergence handling is deliberately conservative: the judge prefers the version backed by
 * retrieved data and only names a disagreement when it is real (both sides actually supported).
 * The candidates all saw the same context and tools, so most disagreements are paths, not facts —
 * the prompt leaves room for the judge to say so in one line rather than forcing a false consensus.
 */
import type { SearchResult } from '../types/index.js';

const MAX_RESULT_CHARS = 600;

export function buildSynthesisPrompt(
  query: string,
  retrievedContext: SearchResult[],
  candidates: { i: number; answer: string }[],
): string {
  const context =
    retrievedContext.length > 0
      ? retrievedContext
          .map((r) => {
            const name = typeof r.metadata.name === 'string' ? r.metadata.name : '';
            const meta = [r.type, r.key, name, r.metadata.mod_name, r.metadata.file_path]
              .filter(Boolean)
              .join(' | ');
            const content =
              r.content.length > MAX_RESULT_CHARS
                ? r.content.slice(0, MAX_RESULT_CHARS) + '…'
                : r.content;
            return `[${meta}]\n${content}`;
          })
          .join('\n\n')
      : '（无检索上下文 — 候选答案可能来自工具调用，以工具结果为证）\n(no retrieved context — candidate answers may cite tool results; trust those)';

  const drafts = candidates.map((c) => `--- Candidate ${c.i + 1} ---\n${c.answer}`).join('\n\n');

  return `N independent agent runs produced N draft answers to one question. Synthesise a single final answer from them.

### Question
${query}

### Retrieved context (what the drafts were allowed to see)
${context}

### Draft answers
${drafts}

### Task
1. Produce ONE final answer that is accurate, complete and self-contained — the user sees only it.
2. Where drafts disagree, prefer the version backed by the retrieved context or cited tool results.
3. If a genuine factual disagreement survives that test, name it briefly (one or two lines) instead of papering over it; do not invent disagreements that do not matter.
4. Do not add facts beyond the drafts and the retrieved context.
5. Write in the same language as the question.
6. Output the final answer directly — no preamble, no task recap, no mention of "N drafts" or this prompt.`;
}
