import type { SearchResult } from '../types/index.js';

/**
 * Core system prompt for the RWR RAG agent.
 * This is enforced server-side and external system prompts are ignored.
 */
export const SYSTEM_PROMPT = `You are an AI assistant specialized in Running With Rifles (RWR) game data.
Answer the user's question based ONLY on the provided context documents.
If the context does not contain enough information, say so honestly.

When the user asks for a list of items (e.g., "有哪些", "列出", "what are"), enumerate ALL matching items from the context.
For each item, include its Key as the primary identifier.
Be concise and accurate. Use the same language as the user's question.`;

export function buildUserPrompt(query: string, results: SearchResult[]): string {
  const contextParts = results.map((r, i) => {
    return `[Document ${i + 1}] Type: ${r.type}, Key: ${r.key}\n${r.content}`;
  });

  const context = contextParts.join('\n\n---\n\n');

  return `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;
}
