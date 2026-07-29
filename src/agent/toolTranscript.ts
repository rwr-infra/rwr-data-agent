/**
 * Shapes the message list the agent loop replays on every step.
 *
 * Two jobs, deliberately separate:
 *
 * 1. **Provider compatibility** — always applied. Some OpenAI-compatible backends (Volcengine)
 *    reject assistant messages whose content is null/absent, and a tool result that resolved to
 *    `undefined` serializes to no content at all.
 *
 * 2. **Shedding** — applied only when a step's prompt would overflow the context window. Tool
 *    results are otherwise replayed *in full*: compressing them unconditionally costs answer
 *    quality on multi-step enumerations, where the older results are exactly what the final answer
 *    is built from. When shedding is unavoidable it drops whole array items and clips long strings
 *    rather than cutting mid-JSON, so the result stays valid JSON and carries a `_shed` note saying
 *    what went missing — a blind char cut leaves a fragment the model may try to complete.
 *
 * Oldest results are shed first: by the time the loop is deep enough to overflow, the recent ones
 * are what the model is actively working with.
 */
import { estimateTokens } from '../api/tokenAccounting.js';

/** Minimum room left for the tool transcript, however tight the rest of the prompt is. */
const MIN_BUDGET_TOKENS = 4096;
/** Strings shorter than this are not worth clipping. */
const MIN_CLIPPABLE_CHARS = 200;
/** Field carrying the human-readable note about what a shed result lost. */
const SHED_NOTE_KEY = '_shed';

type Message = Record<string, unknown>;
type ContentPart = Record<string, unknown>;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function jsonTokens(value: unknown): number {
  return estimateTokens(safeJson(value));
}

/** Clip a string to roughly `target` tokens, keeping a marker of what was dropped. The token
 *  estimate is script-aware, so derive the char budget from this string's own ratio. */
function clipString(text: string, target: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= target) return text;
  const charsPerToken = text.length / Math.max(tokens, 1);
  const keep = Math.max(Math.floor(target * charsPerToken) - 32, 0);
  return `${text.slice(0, keep)}… [${text.length - keep} chars dropped]`;
}

/** Longest prefix of `arr` that keeps `carrier` within `target` tokens. Mutates `carrier[key]` and
 *  returns how many items survived. */
function fitArrayPrefix(carrier: Message, key: string, arr: unknown[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    carrier[key] = arr.slice(0, mid);
    if (jsonTokens(carrier) <= target) lo = mid;
    else hi = mid - 1;
  }
  carrier[key] = arr.slice(0, lo);
  return lo;
}

/**
 * Shrink one tool result to roughly `target` tokens, structurally. Arrays lose their tail (largest
 * array first — `results`, `files`, `referencedBy`, `symbols`, …), then long strings get clipped
 * (`content` from readSource). Returns the value unchanged if it already fits.
 */
export function shrinkToolOutput(value: unknown, target: number): unknown {
  if (jsonTokens(value) <= target) return value;
  if (typeof value === 'string') return clipString(value, target);
  if (Array.isArray(value)) {
    const carrier: Message = { items: value };
    const kept = fitArrayPrefix(carrier, 'items', value, target);
    return kept < value.length ? carrier.items : value;
  }
  if (!value || typeof value !== 'object') return value;

  const obj: Message = { ...(value as Message) };
  const notes: string[] = [];

  const arrayKeys = Object.keys(obj)
    .filter((k) => Array.isArray(obj[k]))
    .sort((a, b) => jsonTokens(obj[b]) - jsonTokens(obj[a]));
  for (const key of arrayKeys) {
    if (jsonTokens(obj) <= target) break;
    const arr = obj[key] as unknown[];
    const kept = fitArrayPrefix(obj, key, arr, target);
    if (kept < arr.length) notes.push(`${key}: kept ${kept} of ${arr.length}`);
  }

  const stringKeys = Object.keys(obj)
    .filter((k) => typeof obj[k] === 'string' && obj[k].length > MIN_CLIPPABLE_CHARS)
    .sort((a, b) => (obj[b] as string).length - (obj[a] as string).length);
  for (const key of stringKeys) {
    if (jsonTokens(obj) <= target) break;
    const text = obj[key] as string;
    // Room left for this string once the rest of the object is accounted for.
    const room = Math.max(target - jsonTokens({ ...obj, [key]: '' }), 0);
    const clipped = clipString(text, room);
    if (clipped !== text) {
      obj[key] = clipped;
      notes.push(`${key}: clipped to ${clipped.length} of ${text.length} chars`);
    }
  }

  if (notes.length === 0) return value;
  obj[SHED_NOTE_KEY] = `partial — dropped to fit the context window (${notes.join('; ')})`;
  return obj;
}

/** Provider-compatibility rewrites. Always applied, independent of any budget. */
function normalise(msg: Message): { msg: Message; changed: boolean } {
  // A tool result that resolved to `undefined` would serialize to no content at all. `output` is a
  // tagged union — {type:'json'|'text'|…, value} — and the provider's converter switches on that
  // tag, so the tag has to survive.
  if (msg.role === 'tool' && Array.isArray(msg.content)) {
    let changed = false;
    const content = (msg.content as ContentPart[]).map((part) => {
      if (part.type !== 'tool-result') return part;
      const output = part.output as { type?: string; value?: unknown } | string | undefined;
      const value = output !== null && typeof output === 'object' && 'value' in output ? output.value : output;
      if (value === undefined || safeJson(value) === '') {
        changed = true;
        return { ...part, output: { type: 'text', value: 'null' } };
      }
      return part;
    });
    return changed ? { msg: { ...msg, content }, changed: true } : { msg, changed: false };
  }

  // Assistant messages carrying only tool calls have no text part; Volcengine rejects `content: null`.
  if (
    msg.role === 'assistant' &&
    Array.isArray(msg.content) &&
    (msg.content as ContentPart[]).length > 0 &&
    !(msg.content as ContentPart[]).some((p) => p.type === 'text')
  ) {
    return { msg: { ...msg, content: [{ type: 'text', text: ' ' }, ...(msg.content as ContentPart[])] }, changed: true };
  }

  return { msg, changed: false };
}

/** Shrink one tool message's results to `target` tokens each. */
function shedMessage(msg: Message, target: number): Message | null {
  if (msg.role !== 'tool' || !Array.isArray(msg.content)) return null;
  let changed = false;
  const content = (msg.content as ContentPart[]).map((part) => {
    if (part.type !== 'tool-result') return part;
    const output = part.output as { type?: string; value?: unknown } | undefined;
    if (!output || typeof output !== 'object' || !('value' in output)) return part;
    const shrunk = shrinkToolOutput(output.value, target);
    if (shrunk === output.value) return part;
    changed = true;
    // Structural shrinking keeps the value valid, so the union tag stays as it was.
    return { ...part, output: { ...output, value: shrunk } };
  });
  return changed ? { ...msg, content } : null;
}

export interface ToolTranscriptShaper {
  /** Body of the `prepareStep` hook. Returns `{}` when nothing had to change. */
  prepare(messages: Message[]): { messages?: Message[] };
  /** Token size of the `messages` array actually sent, one entry per step in step order. Lets the
   *  token accounting report what was really replayed instead of re-deriving it. */
  readonly replay: number[];
  /** Steps on which shedding kicked in — normally empty. */
  readonly shedSteps: number[];
}

export interface ShaperOptions {
  /** Tokens the `messages` array may occupy. System prompt, tool definitions and the output
   *  reservation are outside it and must already be subtracted. */
  budgetTokens: number;
  /** Size an old tool result is shrunk to when shedding is unavoidable. */
  shedTargetTokens: number;
}

export function createToolTranscriptShaper({ budgetTokens, shedTargetTokens }: ShaperOptions): ToolTranscriptShaper {
  const budget = Math.max(budgetTokens, MIN_BUDGET_TOKENS);
  const replay: number[] = [];
  const shedSteps: number[] = [];

  return {
    replay,
    shedSteps,
    prepare(messages) {
      let changed = false;
      const out = messages.map((msg) => {
        const result = normalise(msg);
        if (result.changed) changed = true;
        return result.msg;
      });

      const sizes = out.map((m) => jsonTokens(m));
      let total = sizes.reduce((a, b) => a + b, 0);

      if (total > budget) {
        const step = replay.length;
        // The newest tool result is what the model asked for on this very step, so it is never shed —
        // gutting it is the worst possible loss. Everything older goes oldest-first, stopping as soon
        // as the prompt fits.
        const newestToolIdx = out.reduce((last, m, i) => (m.role === 'tool' ? i : last), -1);
        for (let i = 0; i < out.length && total > budget; i++) {
          if (out[i].role !== 'tool' || i === newestToolIdx) continue;
          const shrunk = shedMessage(out[i], shedTargetTokens);
          if (!shrunk) continue;
          out[i] = shrunk;
          total += jsonTokens(shrunk) - sizes[i];
          changed = true;
        }
        shedSteps.push(step);
        console.warn(
          total > budget
            ? `[agent] Step ${step} prompt is ${total} tokens, still over the ${budget} token transcript budget after shedding every older tool result — raise MAX_CONTEXT_TOKENS or TOOL_CONTEXT_BUDGET_RATIO`
            : `[agent] Step ${step} prompt exceeded the ${budget} token transcript budget; shed older tool results down to ${total}`,
        );
      }

      replay.push(total);
      return changed ? { messages: out } : {};
    },
  };
}
