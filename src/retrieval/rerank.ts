import { config } from '../config/index.js';
import { getTracer } from '../observability/langfuse.js';
import { SpanStatusCode } from '@opentelemetry/api';
import type { SearchResult } from '../types/index.js';

const RERANK_BATCH_SIZE = 50; // max docs per rerank call to stay within token budget
const RERANK_DOC_TRUNCATE = 800; // chars per doc for reranking

interface RerankResultItem {
  index: number;
  relevance_score: number;
}

interface RerankResponse {
  results: RerankResultItem[];
}

function truncateForRerank(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * Rerank search candidates using SiliconFlow/Cohere-compatible rerank API.
 * Falls back to original order on any error.
 */
export async function rerankCandidates(
  query: string,
  candidates: SearchResult[],
  topN: number,
  searchQuery?: string
): Promise<SearchResult[]> {
  if (candidates.length <= 3) return candidates.slice(0, topN);

  return getTracer().startActiveSpan('rerank', async (span) => {
    span.setAttribute('candidateCount', candidates.length);
    span.setAttribute('topN', topN);
    span.setAttribute('model', config.rerankModel);

    const documents = candidates.map((c) => truncateForRerank(c.content, RERANK_DOC_TRUNCATE));

    try {
      const allScores: { index: number; score: number }[] = [];

      for (let i = 0; i < documents.length; i += RERANK_BATCH_SIZE) {
        const batchDocs = documents.slice(i, i + RERANK_BATCH_SIZE);
        const batchOffset = i;

        const res = await fetch(`${config.siliconFlowBaseUrl}/rerank`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.siliconFlowApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.rerankModel,
            query: searchQuery ?? query,
            documents: batchDocs,
            top_n: batchDocs.length,
            return_documents: false,
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Rerank API error ${res.status}: ${errText}`);
        }

        const data = (await res.json()) as RerankResponse;
        for (const r of data.results) {
          allScores.push({ index: batchOffset + r.index, score: r.relevance_score });
        }
      }

      allScores.sort((a, b) => b.score - a.score);
      const results = allScores.slice(0, topN).map((s) => candidates[s.index]);
      span.setAttribute('resultCount', results.length);
      span.end();
      return results;
    } catch (err) {
      console.warn('Rerank failed, falling back to vector distance ordering:', (err as Error).message);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.end();
      return candidates.slice(0, topN);
    }
  });
}
