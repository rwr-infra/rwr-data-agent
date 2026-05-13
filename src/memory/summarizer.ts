import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { config } from '../config/index.js';
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt } from './prompt.js';
import type { ConversationSummary } from './types.js';

const summaries = new Map<string, ConversationSummary>();

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

export function clearSummary(sessionId: string): void {
  summaries.delete(sessionId);
}

function parseSummaryJson(text: string): ConversationSummary | null {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.summary === 'string' && Array.isArray(parsed.entities)) {
      return {
        summary: parsed.summary,
        mentionedEntities: parsed.entities.map(String),
        currentTopic: String(parsed.topic ?? 'general'),
        turnCount: parsed.turnCount ?? 0,
        updatedAt: Date.now(),
      };
    }
  } catch {}
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
