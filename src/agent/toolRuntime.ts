/**
 * Execution envelope wrapped around every agent tool — built-ins and `tools.d` plugins alike.
 *
 * A tool that throws, hangs, or gets called with the same arguments twice must not become the
 * model's problem to guess at, nor the HTTP stream's problem to die from. Every failure leaves here
 * as a `{ error, hint }` value, which reaches the model as an ordinary tool result it can route
 * around. Nothing thrown by a tool escapes this wrapper.
 *
 * Consequence for callers: a failed call arrives on the stream as `tool-result`, not `tool-error`,
 * so success has to be read off the *output shape* — see `isToolFailure`.
 */
import type { Tool, ToolCallOptions, ToolCallRepairFunction, ToolSet } from 'ai';
import { config } from '../config/index.js';

/** Shape every failure leaves this module in. */
export interface ToolFailure {
  error: string;
  hint: string;
}

/** True when a tool result carries a failure produced by this envelope. */
export function isToolFailure(output: unknown): boolean {
  return !!output && typeof output === 'object' && 'error' in output;
}

/**
 * Deterministic serialization for comparing tool inputs: object keys are sorted, so the model
 * emitting `{query, limit}` and `{limit, query}` counts as the same call.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * How many times this exact call has already been made in this request.
 *
 * `ToolCallOptions.messages` holds what was sent to the model for this step: the assistant
 * `tool-call` parts and `tool` result messages from *earlier* steps, and explicitly not the
 * assistant message carrying the call being executed right now. So this needs no shared state and
 * cannot race — it is per-request by construction, which is also why the AI SDK's warning about
 * mutating `experimental_context` inside tools does not apply here.
 *
 * Blind spot: calls issued in parallel *within one step* are absent from `messages`, so they cannot
 * see each other. Harmless — these tools are idempotent reads — and the runaway case this guards
 * against is repetition across steps.
 */
function priorCallCount(
  messages: ToolCallOptions['messages'],
  toolName: string,
  input: unknown,
): number {
  const fingerprint = stableStringify(input);
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === 'tool-call' &&
        part.toolName === toolName &&
        stableStringify(part.input) === fingerprint
      ) {
        count++;
      }
    }
  }
  return count;
}

/** A bare error message teaches the model nothing; each of these names the way out. */
function hintFor(toolName: string, error: string): string {
  if (error.includes('Path traversal blocked')) {
    return `${toolName} only reads inside the game data root. Pass a path relative to it, e.g. "weapons/m4a1.weapon".`;
  }
  if (error.includes('File not found')) {
    return 'Resolve the key first with getNode or listFiles, then readSource the file path they report.';
  }
  if (error.startsWith('Timed out')) {
    return 'Narrow the request: a line range for readSource, a smaller limit for searchDocs, a more specific glob for listFiles.';
  }
  return 'Check the argument values, or reach for a different tool.';
}

/**
 * Reject rather than replay: handing back the cached result teaches nothing and the model repeats.
 *
 * The wording escalates with the repeat count. A model that ignores the first rejection and asks
 * again is usually stuck in a loop it will not leave on a politely-worded suggestion, so the second
 * rejection stops offering alternatives and tells it to answer with what it has.
 */
function duplicateFailure(priorCalls: number): ToolFailure {
  if (priorCalls >= 2) {
    return {
      error: 'duplicate_call',
      hint:
        `You have now called this tool with these exact arguments ${priorCalls} times and been refused each time. ` +
        'Stop calling it. Answer the user with the evidence already gathered in this conversation, and say plainly ' +
        'which parts you could not determine and what you tried.',
    };
  }
  return {
    error: 'duplicate_call',
    hint:
      'You already called this tool with these exact arguments — its result is above, re-read it. ' +
      'If it did not answer the question, change the arguments (a different query, a broader glob, the other language) or switch tools. ' +
      'Repeating the call verbatim will keep failing.',
  };
}

/** Resolve `work` or fail at `timeoutMs`, whichever comes first. Also fails if the request aborts. */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        if (signal) {
          if (signal.aborted) reject(new Error('Request aborted'));
          onAbort = () => reject(new Error('Request aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Coding-agent tool names models reach for out of habit, mapped to the graph tool that actually does
 * the job. Only aliases whose intent is unambiguous belong here — `grep` is plainly a full-text
 * search, `cat` is plainly a file read. Anything else falls through to `NoSuchToolError`, whose
 * message already lists the real tools, and the model self-corrects on the next step.
 *
 * `argKeys` are the argument names the alias might have used, tried in order, mapped onto the real
 * tool's single required field.
 */
const TOOL_ALIASES: Record<string, { toolName: string; field: string; argKeys: string[] }> = {
  grep: {
    toolName: 'searchDocs',
    field: 'query',
    argKeys: ['pattern', 'query', 'regex', 'q', 'search'],
  },
  search: { toolName: 'searchDocs', field: 'query', argKeys: ['query', 'pattern', 'q'] },
  search_files: { toolName: 'searchDocs', field: 'query', argKeys: ['query', 'pattern', 'q'] },
  ripgrep: { toolName: 'searchDocs', field: 'query', argKeys: ['pattern', 'query', 'regex'] },
  cat: { toolName: 'readSource', field: 'file', argKeys: ['path', 'file', 'filename'] },
  read: { toolName: 'readSource', field: 'file', argKeys: ['path', 'file', 'filename'] },
  read_file: { toolName: 'readSource', field: 'file', argKeys: ['path', 'file', 'filename'] },
  ls: { toolName: 'listFiles', field: 'pattern', argKeys: ['pattern', 'glob', 'path', 'dir'] },
  find: { toolName: 'listFiles', field: 'pattern', argKeys: ['pattern', 'glob', 'name', 'path'] },
  glob: { toolName: 'listFiles', field: 'pattern', argKeys: ['pattern', 'glob', 'path'] },
  list_files: { toolName: 'listFiles', field: 'pattern', argKeys: ['pattern', 'glob', 'path'] },
};

/**
 * Rewrite a hallucinated tool call onto the real tool when the intent is obvious.
 *
 * Models carry coding-agent priors and will invent `grep`, `cat`, `ls`. Without this the call costs a
 * whole step: the SDK returns `NoSuchToolError`, the model reads the available-tools list and retries.
 * Remapping turns that wasted round trip into a useful one. Returning `null` keeps the original
 * error, so an unrecognised name still degrades exactly as before.
 */
export const repairToolCall: ToolCallRepairFunction<ToolSet> = ({ toolCall, tools }) => {
  const alias = TOOL_ALIASES[toolCall.toolName.toLowerCase()];
  if (!alias || !(alias.toolName in tools)) return Promise.resolve(null);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(toolCall.input || '{}') as Record<string, unknown>;
  } catch {
    return Promise.resolve(null);
  }

  const value = alias.argKeys
    .map((k) => parsed[k])
    .find((v) => typeof v === 'string' && v.length > 0);
  if (typeof value !== 'string') return Promise.resolve(null);

  console.warn(
    `[tool] repaired hallucinated call: ${toolCall.toolName} → ${alias.toolName}(${alias.field}="${value}")`,
  );
  return Promise.resolve({
    ...toolCall,
    toolName: alias.toolName,
    input: JSON.stringify({ [alias.field]: value }),
  });
};

/**
 * Wrap every tool's `execute` with the duplicate guard, a deadline, and the failure envelope.
 *
 * Call once per registry build, not per request — the returned object is a new reference, which the
 * `measureToolDefTokens` cache in api/tokenAccounting.ts keys on.
 */
export function instrumentTools(tools: Record<string, Tool>): Record<string, Tool> {
  const timeoutMs = config.toolTimeoutMs;

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const base = tool.execute?.bind(tool);
      if (!base) return [name, tool];

      const execute = async (input: unknown, options: ToolCallOptions): Promise<unknown> => {
        const priorCalls = priorCallCount(options.messages, name, input);
        if (priorCalls > 0) {
          console.warn(`[tool] ${name} duplicate call rejected (attempt ${priorCalls + 1})`);
          return duplicateFailure(priorCalls);
        }

        const startedAt = Date.now();
        try {
          // `Tool.execute` is typed per-tool; at registry level everything is `unknown` in and out.
          const work = Promise.resolve<unknown>(base(input, options));
          const output = await withDeadline(work, timeoutMs, options.abortSignal);
          console.log(`[tool] ${name} ok ${Date.now() - startedAt}ms`);
          return output;
        } catch (err) {
          const error = (err as Error).message;
          console.warn(`[tool] ${name} failed ${Date.now() - startedAt}ms — ${error}`);
          return { error, hint: hintFor(name, error) } satisfies ToolFailure;
        }
      };

      return [name, { ...tool, execute }];
    }),
  );
}
