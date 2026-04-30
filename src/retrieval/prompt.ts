import type { SearchResult } from '../types/index.js';

const SYSTEM_PROMPT = `You are an AI assistant specialized in Running With Rifles (RWR) game data.
Answer the user's question based ONLY on the provided context documents.
If the context does not contain enough information, say so honestly.
Be concise and accurate. Use the same language as the user's question.`;

export function buildPrompt(query: string, results: SearchResult[]): string {
  const contextParts = results.map((r, i) => {
    return `[Document ${i + 1}] Type: ${r.type}, Key: ${r.key}\n${r.content}`;
  });

  const context = contextParts.join('\n\n---\n\n');

  return `${SYSTEM_PROMPT}\n\nContext:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;
}
