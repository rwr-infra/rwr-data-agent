export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Build a search-optimized query by enriching the current query with
 * conversation context. Resolves coreference (e.g., "它的伤害" → "M4A1的伤害")
 * by incorporating entities from recent conversation turns.
 *
 * Embedding models produce better vectors when the text contains the
 * referenced entity names directly, so we concatenate:
 *   - recent user queries (topic continuity)
 *   - last assistant response prefix (entity names)
 *   - the current query (original intent)
 */
export function buildSearchQuery(currentQuery: string, history: HistoryMessage[]): string {
  if (history.length === 0) return currentQuery;

  const parts: string[] = [];

  const recentUserQueries = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content.trim());

  for (const q of recentUserQueries) {
    if (q.length <= 100) {
      parts.push(q);
    } else {
      parts.push(q.slice(0, 80));
    }
  }

  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  if (lastAssistant) {
    parts.push(lastAssistant.content.trim().slice(0, 200));
  }

  parts.push(currentQuery);

  const seen = new Set<string>();
  return parts.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(' ');
}