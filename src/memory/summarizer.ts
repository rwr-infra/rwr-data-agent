import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { createMemorySessionStore } from '@rwr/agent-core';
import { config } from '../config/index.js';
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt } from './prompt.js';
import { disabledThinkingOptions } from '../llm/providerOptions.js';
import type { ConversationSummary } from './types.js';

/**
 * How long a session's rolling summary is kept after its last update.
 *
 * Generous enough that a user who walks away from a chat and comes back the same afternoon still
 * has their memory — but bounded, because `x-session-id` is minted by the client and the server is
 * never told when a conversation is abandoned. The eviction itself lives in the core store.
 */
const SUMMARY_TTL_MS = 6 * 60 * 60_000;

const summaries = createMemorySessionStore<ConversationSummary>(SUMMARY_TTL_MS);

let provider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  if (!provider) {
    provider = createOpenAICompatible({
      name: 'llm',
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
  }
  return provider;
}

export function getSummary(sessionId: string): ConversationSummary | undefined {
  return summaries.get(sessionId);
}

export function setSummary(sessionId: string, summary: ConversationSummary): void {
  summaries.set(sessionId, summary);
}

/** Live summary count — for tests. */
export function summaryCount(): number {
  return summaries.size();
}

export function clearSummary(sessionId: string): void {
  summaries.delete(sessionId);
}

function parseSummaryJson(text: string): ConversationSummary | null {
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    // JSON.parse is typed `any`; keep the model's output at arm's length.
    const parsed: unknown = JSON.parse(cleaned);
    const obj =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const summary = obj['summary'];
    const entities = obj['entities'];
    const topic = obj['topic'];
    const turnCount = obj['turnCount'];
    if (typeof summary === 'string' && Array.isArray(entities)) {
      return {
        summary,
        mentionedEntities: (entities as unknown[]).filter(
          (e): e is string => typeof e === 'string',
        ),
        currentTopic: typeof topic === 'string' ? topic : 'general',
        turnCount: typeof turnCount === 'number' ? turnCount : 0,
        updatedAt: Date.now(),
      };
    }
  } catch {
    // Malformed model output — the caller treats a null summary as "no memory yet".
  }
  return null;
}

export async function generateSummary(
  sessionId: string,
  history: { role: string; content: string }[],
): Promise<ConversationSummary | null> {
  try {
    const result = await generateText({
      model: getProvider().chatModel(config.summaryModel),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: buildSummaryPrompt(history),
      maxOutputTokens: 512,
      // Summary is an auxiliary task — keep thinking off to save latency/tokens. Only sent
      // when the main model has thinking enabled (a DeepSeek hybrid model). B3.
      providerOptions: config.llmThinkingEnabled ? disabledThinkingOptions() : undefined,
    });

    const summary = parseSummaryJson(result.text);
    if (summary) {
      summary.turnCount = history.length;
      setSummary(sessionId, summary);
      return summary;
    }
    console.warn('[memory] Failed to parse summary JSON:', result.text.slice(0, 100));
    return null;
  } catch (err) {
    console.warn('[memory] Summary generation failed:', (err as Error).message);
    return null;
  }
}

export function shouldGenerateSummary(sessionId: string, turnCount: number): boolean {
  const existing = summaries.get(sessionId);
  if (!existing) return turnCount >= config.summaryIntervalTurns;
  return turnCount - existing.turnCount >= config.summaryIntervalTurns;
}
