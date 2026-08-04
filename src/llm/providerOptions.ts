import type { JSONValue } from 'ai';
import { config } from '../config/index.js';

/**
 * Provider-specific options forwarded to the OpenAI-compatible backend for the MAIN chat
 * model. The top-level key must match the provider `name` ('llm'); fields under it are sent
 * verbatim (snake_case) in the request body, so DeepSeek's `reasoning_effort` and
 * `thinking: { type }` controls apply transparently. Returns undefined when nothing is set,
 * so callers can pass it through without forcing empty options. B2.
 *
 * Scope: main chat model only. Auxiliary calls (e.g. summary) pass their own options.
 */
export function buildLlmProviderOptions(): Record<string, Record<string, JSONValue>> | undefined {
  const llm: Record<string, JSONValue> = {};

  if (config.llmReasoningEffort) {
    llm.reasoning_effort = config.llmReasoningEffort;
  }
  if (config.llmThinkingEnabled !== undefined) {
    llm.thinking = { type: config.llmThinkingEnabled ? 'enabled' : 'disabled' };
  }
  if (config.llmTemperature !== undefined) {
    llm.temperature = config.llmTemperature;
  }

  return Object.keys(llm).length > 0 ? { llm } : undefined;
}

/**
 * Force thinking off, for auxiliary calls (e.g. session summary) where reasoning wastes
 * latency/tokens. Gate on config.llmThinkingEnabled at the call site so it is only sent to
 * hybrid-reasoning models that understand the field. B3.
 */
export function disabledThinkingOptions(): Record<string, Record<string, JSONValue>> {
  return { llm: { thinking: { type: 'disabled' } } };
}

/**
 * Per-candidate options for best-of-N runs: the main options as a base, overridden with the
 * candidate's own temperature and seed. Both live under the same `llm` key as the base fields,
 * so they are forwarded verbatim (snake_case) next to reasoning_effort / thinking.
 */
export function buildCandidateProviderOptions(
  temperature: number,
  seed: number,
): Record<string, Record<string, JSONValue>> {
  const base = buildLlmProviderOptions() ?? {};
  const llm: Record<string, JSONValue> = { ...(base.llm ?? {}) };
  llm.temperature = temperature;
  llm.seed = seed;
  return { llm };
}
