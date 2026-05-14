import { getPool } from '../db/index.js';
import { createEmbedding } from '../ingestion/embeddings.js';
import { rerankCandidates } from './rerank.js';
import { config } from '../config/index.js';
import { expandQuery } from './queryRewrite.js';
import { FTS_CONFIG } from '../db/schema.js';
import { getCachedSearch, setCachedSearch, generateCacheKey } from '../cache/index.js';
import { getTracer } from '../observability/langfuse.js';
import { SpanStatusCode } from '@opentelemetry/api';
import type { DocumentType, SearchFilters, SearchResult } from '../types/index.js';

interface QueryIntent {
  inferredType?: string;
  contentPattern?: string;
  exactKey?: string;
  isEnumeration: boolean;
  isExactKeyQuery: boolean;
}

export function extractQueryIntent(query: string): QueryIntent {
  const intent: QueryIntent = { isEnumeration: false, isExactKeyQuery: false };

  if (/有哪些|列出|所有|全部|是什么|what are|list all/i.test(query)) {
    intent.isEnumeration = true;
  }

  const exactKeyMatch = query.match(/key\s*[=:]\s*["']?([^"'\s]+)["']?/i) ||
                         query.match(/key\s*(?:为|是)\s*["']?([^"'\s]+)["']?/i);
  if (exactKeyMatch) {
    intent.exactKey = exactKeyMatch[1];
    intent.isExactKeyQuery = true;
  }

  if (/武器|weapon|枪械|枪/i.test(query)) {
    intent.inferredType = 'weapon';
  } else if (/士兵|soldier|兵种|人/i.test(query)) {
    intent.inferredType = 'soldier';
  } else if (/载具|vehicle|车|坦克|飞机/i.test(query)) {
    intent.inferredType = 'vehicle';
  } else if (/投掷物|projectile|手雷|爆炸物/i.test(query)) {
    intent.inferredType = 'projectile';
  } else if (/派系|faction|阵营/i.test(query)) {
    intent.inferredType = 'faction';
  } else if (/呼叫|call|支援|空袭/i.test(query)) {
    intent.inferredType = 'call';
  } else if (/角色|character/i.test(query)) {
    intent.inferredType = 'character';
  } else if (/装备|物品|道具|carry.?item|防弹|护甲|背心|外骨骼|服|芯片|gear|vest|exosuit|exo|armor/i.test(query)) {
    intent.inferredType = 'carry_item';
  }

  const classMatch = query.match(/class\s*[=:]\s*["']?(\d+)["']?/i);
  if (classMatch) {
    intent.contentPattern = `%class: ${classMatch[1]}%`;
  }

  return intent;
}

function buildWhereClause(
  filters: SearchFilters,
  intent: QueryIntent,
  startIdx: number,
): { where: string; params: (string | number)[]; idx: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = startIdx;

  if (filters.type) {
    conditions.push(`type = $${idx++}`);
    params.push(filters.type);
  } else if (intent.inferredType) {
    conditions.push(`type = $${idx++}`);
    params.push(intent.inferredType);
  }

  if (filters.faction) {
    conditions.push(`metadata->>'faction' = $${idx++}`);
    params.push(filters.faction);
  }
  if (filters.mod_name) {
    conditions.push(`metadata->>'mod_name' = $${idx++}`);
    params.push(filters.mod_name);
  }
  if (filters.weapon_class) {
    conditions.push(`metadata->>'weapon_class' = $${idx++}`);
    params.push(filters.weapon_class);
  }

  if (intent.contentPattern) {
    conditions.push(`content ILIKE $${idx++}`);
    params.push(intent.contentPattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, idx };
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists by score = Σ 1/(k + rank).
 * k=60 is the standard RRF constant from the original paper.
 */
function reciprocalRankFusion(
  rankLists: SearchResult[][],
  k = 60,
): SearchResult[] {
  const scoreMap = new Map<string, { score: number; doc: SearchResult }>();

  for (const list of rankLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const doc = list[rank];
      const id = doc.doc_id;
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(id, { score: rrfScore, doc });
      }
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.doc, distance: -entry.score }));
}

export async function search(
  query: string,
  filters: SearchFilters = {},
  topK = 60,
  tableName?: string,
  searchQuery?: string,
  offset = 0,
): Promise<SearchResult[]> {
  return getTracer().startActiveSpan('search', async (searchSpan) => {
    searchSpan.setAttribute('query', query);
    searchSpan.setAttribute('topK', topK);

    const table = tableName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName) ? tableName : config.databaseTable;
    const cacheKey = generateCacheKey(query, table, JSON.stringify(filters), String(topK));
    const cached = await getCachedSearch(cacheKey);
    if (cached) {
      searchSpan.setAttribute('cacheHit', true);
      searchSpan.setAttribute('resultCount', cached.length);
      searchSpan.end();
      return cached;
    }

    searchSpan.setAttribute('cacheHit', false);

    const pool = await getPool();
    const intent = extractQueryIntent(query);
    const baseQuery = searchQuery ?? query;
    const expandedQuery = expandQuery(query);
    const embeddingQuery = expandedQuery !== query ? `${baseQuery} ${expandedQuery.replace(query, '').trim()}` : baseQuery;

    searchSpan.setAttribute('intent.isEnumeration', intent.isEnumeration);
    searchSpan.setAttribute('intent.isExactKey', intent.isExactKeyQuery);
    if (intent.inferredType) searchSpan.setAttribute('intent.inferredType', intent.inferredType);

    // -----------------------------------------------------------------------
    // Fast path: exact key lookup — bypass embedding entirely
    // -----------------------------------------------------------------------
    if (intent.isExactKeyQuery && intent.exactKey) {
      const client = await pool.connect();
      try {
        const conditions: string[] = [`key = $1`];
        const params: (string | number)[] = [intent.exactKey];
        let paramIdx = 2;

        if (filters.type) {
          conditions.push(`type = $${paramIdx++}`);
          params.push(filters.type);
        } else if (intent.inferredType) {
          conditions.push(`type = $${paramIdx++}`);
          params.push(intent.inferredType);
        }
        if (filters.mod_name) {
          conditions.push(`metadata->>'mod_name' = $${paramIdx++}`);
          params.push(filters.mod_name);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const exactSql = `
          SELECT doc_id, type, key, content, metadata, 0.0 AS distance
          FROM ${table}
          ${whereClause}
          LIMIT $${paramIdx}
        `;
        params.push(topK);

        const res = await client.query(exactSql, params);
        if (res.rows.length > 0) {
          const results = res.rows.map((row) => ({
            doc_id: row.doc_id,
            type: row.type,
            key: row.key,
            content: row.content,
            metadata: row.metadata,
            distance: parseFloat(row.distance),
          }));
          searchSpan.setAttribute('path', 'exact-key');
          searchSpan.setAttribute('resultCount', results.length);
          searchSpan.end();
          return results;
        }

        const likeConditions: string[] = [`key ILIKE $1`];
        const likeParams: (string | number)[] = [`%${intent.exactKey}%`];
        let likeParamIdx = 2;

        if (filters.type) {
          likeConditions.push(`type = $${likeParamIdx++}`);
          likeParams.push(filters.type);
        } else if (intent.inferredType) {
          likeConditions.push(`type = $${likeParamIdx++}`);
          likeParams.push(intent.inferredType);
        }
        if (filters.mod_name) {
          likeConditions.push(`metadata->>'mod_name' = $${likeParamIdx++}`);
          likeParams.push(filters.mod_name);
        }

        const likeWhere = `WHERE ${likeConditions.join(' AND ')}`;
        const likeSql = `
          SELECT doc_id, type, key, content, metadata, 0.0 AS distance
          FROM ${table}
          ${likeWhere}
          LIMIT $${likeParamIdx}
        `;
        likeParams.push(topK);

        const likeRes = await client.query(likeSql, likeParams);
        const results = likeRes.rows.map((row) => ({
          doc_id: row.doc_id,
          type: row.type,
          key: row.key,
          content: row.content,
          metadata: row.metadata,
          distance: parseFloat(row.distance),
        }));
        searchSpan.setAttribute('path', 'exact-key-like');
        searchSpan.setAttribute('resultCount', results.length);
        searchSpan.end();
        return results;
      } finally {
        client.release();
      }
    }

    const effectiveTopK = Math.max(topK + offset, 60);

    const candidatePool = intent.isEnumeration
      ? Math.max(topK * 8, 300)
      : Math.max(topK * 4, 120);
    const vectorPool = Math.ceil(candidatePool * 0.5);
    const ftsPool = Math.ceil(candidatePool * 0.35);
    const ilikePool = Math.ceil(candidatePool * 0.15);

    const { where: whereClause, params: whereParams, idx: paramIdx } = buildWhereClause(filters, intent, 1);

    // --- Stage A: Vector search ---
    const embedding = await createEmbedding(embeddingQuery);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const vectorSql = `
      SELECT doc_id, type, key, content, metadata,
             embedding <=> $${paramIdx}::vector AS distance
      FROM ${table}
      ${whereClause}
      ORDER BY embedding <=> $${paramIdx}::vector
      LIMIT $${paramIdx + 1}
    `;
    const vectorParams = [...whereParams, vectorLiteral, vectorPool];

    // --- Stage B: Full-text search (tsvector with ranking) ---
    const ftsWherePrefix = whereClause ? `${whereClause} AND` : 'WHERE';
    const ftsTsquery = `plainto_tsquery('${FTS_CONFIG}', $${paramIdx})`;
    const ftsSql = `
      SELECT doc_id, type, key, content, metadata,
             ts_rank_cd(fts, ${ftsTsquery}) AS fts_rank
      FROM ${table}
      ${ftsWherePrefix} fts @@ ${ftsTsquery}
      ORDER BY ts_rank_cd(fts, ${ftsTsquery}) DESC
      LIMIT $${paramIdx + 1}
    `;
    const ftsParams = [...whereParams.slice(0, paramIdx - 1), expandedQuery, ftsPool];

    // --- Stage C: ILIKE fallback ---
    const terms = extractSearchTerms(expandedQuery);
    let ilikeResults: SearchResult[] = [];
    if (terms.length > 0) {
      const ilikeConditions: string[] = [];
      const ilikeParams: (string | number)[] = [];
      let ilikeIdx = 1;

      if (filters.type) {
        ilikeConditions.push(`type = $${ilikeIdx++}`);
        ilikeParams.push(filters.type);
      } else if (intent.inferredType) {
        ilikeConditions.push(`type = $${ilikeIdx++}`);
        ilikeParams.push(intent.inferredType);
      }
      if (filters.mod_name) {
        ilikeConditions.push(`metadata->>'mod_name' = $${ilikeIdx++}`);
        ilikeParams.push(filters.mod_name);
      }

      const termOrParts: string[] = [];
      for (const t of terms) {
        ilikeParams.push(`%${t}%`);
        const p1 = ilikeIdx++;
        ilikeParams.push(`%${t}%`);
        const p2 = ilikeIdx++;
        termOrParts.push(`(key ILIKE $${p1} OR content ILIKE $${p2})`);
      }
      if (termOrParts.length > 0) {
        ilikeConditions.push(`(${termOrParts.join(' OR ')})`);
      }

      const ilikeWhere = ilikeConditions.length > 0 ? `WHERE ${ilikeConditions.join(' AND ')}` : '';
      const ilikeSql = `
        SELECT doc_id, type, key, content, metadata, 0.0 AS distance
        FROM ${table}
        ${ilikeWhere}
        LIMIT $${ilikeIdx}
      `;
      ilikeParams.push(ilikePool);

      const ilikeClient = await pool.connect();
      try {
        const ilikeRes = await ilikeClient.query(ilikeSql, ilikeParams);
        ilikeResults = ilikeRes.rows.map((row) => ({
          doc_id: row.doc_id,
          type: row.type,
          key: row.key,
          content: row.content,
          metadata: row.metadata,
          distance: parseFloat(row.distance),
        }));
      } finally {
        ilikeClient.release();
      }
    }

    // --- Stage D: Key-pattern enumeration ---
    let keyPatternResults: SearchResult[] = [];
    if (intent.isEnumeration) {
      const keyPatterns = extractKeyPatterns(query);
      if (keyPatterns.length > 0) {
        const kpConditions: string[] = [];
        const kpParams: (string | number)[] = [];
        let kpIdx = 1;

        if (filters.type) {
          kpConditions.push(`type = $${kpIdx++}`);
          kpParams.push(filters.type);
        } else if (intent.inferredType) {
          kpConditions.push(`type = $${kpIdx++}`);
          kpParams.push(intent.inferredType);
        }
        if (filters.mod_name) {
          kpConditions.push(`metadata->>'mod_name' = $${kpIdx++}`);
          kpParams.push(filters.mod_name);
        }

        const kpOrParts = keyPatterns.map((p) => {
          kpParams.push(`%${p}%`);
          return `key ILIKE $${kpIdx++}`;
        });
        if (kpOrParts.length === 1) {
          kpConditions.push(kpOrParts[0]);
        } else {
          kpConditions.push(`(${kpOrParts.join(' OR ')})`);
        }

        const kpWhere = kpConditions.length > 0 ? `WHERE ${kpConditions.join(' AND ')}` : '';
        const kpSql = `
          SELECT doc_id, type, key, content, metadata, 0.0 AS distance
          FROM ${table}
          ${kpWhere}
          LIMIT 200
        `;

        const kpClient = await pool.connect();
        try {
          const kpRes = await kpClient.query(kpSql, kpParams);
          keyPatternResults = kpRes.rows.map((row) => ({
            doc_id: row.doc_id,
            type: row.type,
            key: row.key,
            content: row.content,
            metadata: row.metadata,
            distance: parseFloat(row.distance),
          }));
        } finally {
          kpClient.release();
        }
      }
    }

    // Execute vector and FTS queries in parallel
    const vectorClient = await pool.connect();
    const ftsClient = await pool.connect();

    let vectorResults: SearchResult[] = [];
    let ftsResults: SearchResult[] = [];

    try {
      const [vRes, fRes] = await Promise.all([
        vectorClient.query(vectorSql, vectorParams),
        ftsClient.query(ftsSql, ftsParams).catch(() => ({ rows: [] })),
      ]);

      vectorResults = vRes.rows.map((row) => ({
        doc_id: row.doc_id,
        type: row.type,
        key: row.key,
        content: row.content,
        metadata: row.metadata,
        distance: parseFloat(row.distance),
      }));

      ftsResults = (fRes as { rows: { doc_id: string; type: string; key: string; content: string; metadata: Record<string, unknown>; fts_rank: number }[] }).rows.map((row) => ({
        doc_id: row.doc_id,
        type: row.type as DocumentType,
        key: row.key,
        content: row.content,
        metadata: row.metadata as SearchResult['metadata'],
        distance: -row.fts_rank,
      }));
    } finally {
      vectorClient.release();
      ftsClient.release();
    }

    searchSpan.setAttribute('vectorResults', vectorResults.length);
    searchSpan.setAttribute('ftsResults', ftsResults.length);
    searchSpan.setAttribute('ilikeResults', ilikeResults.length);
    searchSpan.setAttribute('keyPatternResults', keyPatternResults.length);

    // RRF fusion
    const rankedLists = [vectorResults, ftsResults, ilikeResults, keyPatternResults].filter((l) => l.length > 0);
    let candidates: SearchResult[];

    if (rankedLists.length <= 1) {
      candidates = rankedLists[0] ?? vectorResults;
    } else {
      candidates = reciprocalRankFusion(rankedLists);
    }

    // Deduplicate
    const seen = new Set<string>();
    candidates = candidates.filter((c) => {
      if (seen.has(c.doc_id)) return false;
      seen.add(c.doc_id);
      return true;
    });

    // Stage 2: rerank
    const rerankInput = candidates.slice(0, Math.min(candidates.length, candidatePool));
    const reranked = await rerankCandidates(query, rerankInput, effectiveTopK, searchQuery);

    searchSpan.setAttribute('candidateCount', candidates.length);
    searchSpan.setAttribute('resultCount', reranked.length);
    searchSpan.setAttribute('path', 'hybrid');
    searchSpan.setAttribute('offset', offset);
    setCachedSearch(cacheKey, query, reranked).catch(() => {});

    searchSpan.end();
    const paginated = reranked.slice(offset, offset + topK);
    return paginated;
  });
}

const CJK_REGEX = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function splitCJKBoundary(text: string): string[] {
  const results: string[] = [];
  let current = '';
  let prevIsCJK = false;

  for (const ch of text) {
    const isCJK = CJK_REGEX.test(ch);
    if (current && isCJK !== prevIsCJK) {
      results.push(current);
      current = ch;
    } else {
      current += ch;
    }
    prevIsCJK = isCJK;
  }
  if (current) results.push(current);
  return results;
}

function tokenizeQuery(query: string): string[] {
  return query
    .split(/[\s,，。！？、；：""''（）\[\]{}\/\\|@#$%^&*+=~`<>]+/)
    .flatMap((t) => splitCJKBoundary(t))
    .flatMap((t) => generateCJKBigrams(t))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function generateCJKBigrams(text: string): string[] {
  if (!CJK_REGEX.test(text)) return [text];
  const bigrams: string[] = [text];
  for (let i = 0; i < text.length - 1; i++) {
    if (CJK_REGEX.test(text[i]) && CJK_REGEX.test(text[i + 1])) {
      bigrams.push(text.slice(i, i + 2));
    }
  }
  return bigrams;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  '的', '了', '是', '在', '有', '和', '与', '个', '这', '那',
  '什么', '怎么', '如何', '哪', '哪些', '多少', '是否', '能',
]);

function extractSearchTerms(query: string): string[] {
  return tokenizeQuery(query)
    .filter((t) => {
      if (t.length < 2 && !CJK_REGEX.test(t)) return false;
      return !STOP_WORDS.has(t);
    });
}

function extractKeyPatterns(query: string): string[] {
  const patterns: string[] = [];
  for (const token of tokenizeQuery(query)) {
    if (/[a-z]+\d+/.test(token) || /\d+[a-z]+/.test(token)) {
      patterns.push(token);
    }
  }
  return patterns;
}