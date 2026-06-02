import { getPool } from '../db/index.js';
import { createEmbedding } from '../ingestion/embeddings.js';
import { rerankCandidates } from './rerank.js';
import { config } from '../config/index.js';
import { expandQuery } from './queryRewrite.js';
import {
  normalizeQuery,
  matchAlias,
  extractEntityMentions,
  normalizeKey,
  generateNormalizedVariants,
  setDynamicAliases,
} from './normalize.js';
import { FTS_CONFIG } from '../db/schema.js';
import { getCachedSearch, setCachedSearch, generateCacheKey } from '../cache/index.js';
import { getTracer } from '../observability/langfuse.js';
import type { DocumentType, SearchFilters, SearchResult } from '../types/index.js';

interface QueryIntent {
  inferredType?: string;
  contentPattern?: string;
  exactKey?: string;
  isEnumeration: boolean;
  isExactKeyQuery: boolean;
  isComparison: boolean;
  aliasMatches: { canonical: string; confidence: number }[];
  entityMentions: string[];
}

export function extractQueryIntent(query: string): QueryIntent {
  const intent: QueryIntent = {
    isEnumeration: false,
    isExactKeyQuery: false,
    isComparison: false,
    aliasMatches: [],
    entityMentions: [],
  };

  if (/有哪些|列出|所有|全部|是什么|what are|list all|enumerate|show all/i.test(query)) {
    intent.isEnumeration = true;
  }

  if (/对比|比较|vs|versus|哪个|哪把|和.*比|compared|better|difference|which is|区别/i.test(query)) {
    intent.isComparison = true;
  }

  const exactKeyMatch = query.match(/key\s*[=:]\s*["']?([^"'\s]+)["']?/i) ||
                         query.match(/key\s*(?:为|是)\s*["']?([^"'\s]+)["']?/i);
  if (exactKeyMatch) {
    intent.exactKey = exactKeyMatch[1];
    intent.isExactKeyQuery = true;
  }

  const normalized = normalizeQuery(query);
  intent.aliasMatches = matchAlias(normalized);
  intent.entityMentions = extractEntityMentions(query);

  if (/武器|weapon|枪械|枪/i.test(query) && !intent.isEnumeration) {
    intent.inferredType = 'weapon';
  } else if (/士兵|soldier|兵种/i.test(query)) {
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
  } else if (intent.inferredType && !intent.isEnumeration) {
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

interface WeightedRRFOptions {
  k: number;
  weights: number[];
}

function weightedReciprocalRankFusion(
  rankLists: SearchResult[][],
  options: WeightedRRFOptions,
): SearchResult[] {
  const { k, weights } = options;
  const scoreMap = new Map<string, { score: number; doc: SearchResult; sources: string[] }>();

  const sourceNames = ['vector', 'fts', 'ilike', 'keyPattern', 'alias', 'enumeration'];

  for (let listIdx = 0; listIdx < rankLists.length; listIdx++) {
    const list = rankLists[listIdx];
    const weight = weights[listIdx] ?? 1.0;
    const sourceName = sourceNames[listIdx] ?? `route_${listIdx}`;

    for (let rank = 0; rank < list.length; rank++) {
      const doc = list[rank];
      const id = doc.doc_id;
      const rrfScore = weight / (k + rank + 1);
      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.push(sourceName);
      } else {
        scoreMap.set(id, { score: rrfScore, doc, sources: [sourceName] });
      }
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.doc,
      distance: -entry.score,
      source: [...new Set(entry.sources)].join('+'),
    }));
}

// pgvector >= 0.8 capability probe for hnsw.iterative_scan (cached after first call).
let hnswIterativeSupported: boolean | null = null;
async function supportsHnswIterativeScan(pool: Awaited<ReturnType<typeof getPool>>): Promise<boolean> {
  if (hnswIterativeSupported !== null) return hnswIterativeSupported;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const v = (rows[0] as { extversion?: string } | undefined)?.extversion;
    const [maj, min] = (v ?? '0.0').split('.').map((n) => parseInt(n, 10));
    hnswIterativeSupported = !!v && (maj > 0 || (maj === 0 && min >= 8));
  } catch {
    hnswIterativeSupported = false;
  } finally {
    client.release();
  }
  return hnswIterativeSupported;
}

// Lazily build the dynamic alias index from the DB (keys + localized names) on first search,
// so alias matching covers all entities instead of only the ~13 curated weapons. Cached
// process-wide; keyed by the first table seen (dynamic aliases are an enhancement). A10.
let aliasLoadPromise: Promise<void> | null = null;
function ensureDynamicAliases(pool: Awaited<ReturnType<typeof getPool>>, table: string): Promise<void> {
  if (aliasLoadPromise) return aliasLoadPromise;
  aliasLoadPromise = (async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT key, metadata FROM ${table} LIMIT 10000`);
      const map: Record<string, string[]> = {};
      for (const row of rows as { key: string; metadata: Record<string, unknown> | null }[]) {
        const canonical = normalizeKey(row.key);
        if (canonical.length < 2) continue;
        const aliases = new Set<string>(generateNormalizedVariants(row.key));
        const md = row.metadata ?? {};
        for (const field of ['name', 'name_cn', 'label', 'localized_name']) {
          const v = md[field];
          if (typeof v === 'string' && v.trim().length >= 2 && v.length <= 40) {
            aliases.add(v.toLowerCase());
          }
        }
        map[canonical] = [...aliases];
      }
      setDynamicAliases(map);
      console.log(`[search] Loaded ${Object.keys(map).length} dynamic aliases from ${table}.`);
    } catch (e) {
      console.warn('[search] Dynamic alias load failed (using curated aliases only):', (e as Error).message);
    } finally {
      client.release();
    }
  })();
  return aliasLoadPromise;
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
    const pool = await getPool();
    // Load dynamic aliases before intent extraction so the cache key (built from matched
    // entities) is stable across the first and subsequent queries. A10.
    await ensureDynamicAliases(pool, table);
    const intent = extractQueryIntent(query);

    // Entity-aware cache key: use extracted entities so semantically equivalent
    // queries (e.g. "对比 M4A1 和 G36" vs "对比 M4A1 和 G36 的武器数据") share cache
    const entityKeys = [
      ...intent.aliasMatches.map((a) => a.canonical),
      ...intent.entityMentions,
    ].sort();
    // Include intent dimensions so semantically different queries over the same
    // entities (e.g. class=2 vs class=3, enumerate vs detail) don't collide on cache.
    const intentSig = `e${intent.isEnumeration ? 1 : 0}c${intent.isComparison ? 1 : 0}|ek:${intent.exactKey ?? ''}|cp:${intent.contentPattern ?? ''}`;
    const cacheKeyBase = entityKeys.length > 0
      ? `ents:${entityKeys.join(',')}|type:${intent.inferredType ?? ''}|${intentSig}`
      : `${query}|${intentSig}`;
    const cacheKey = generateCacheKey(cacheKeyBase, table, JSON.stringify(filters), String(topK), String(offset));
    const cached = await getCachedSearch(cacheKey);
    if (cached) {
      searchSpan.setAttribute('cacheHit', true);
      searchSpan.setAttribute('resultCount', cached.length);
      searchSpan.end();
      return cached;
    }

    searchSpan.setAttribute('cacheHit', false);

    const baseQuery = searchQuery ?? query;
    const expandedQuery = expandQuery(query);
    const embeddingQuery = expandedQuery !== query ? `${baseQuery} ${expandedQuery.replace(query, '').trim()}` : baseQuery;

    if (searchQuery && searchQuery !== query) {
      const enrichedMentions = extractEntityMentions(searchQuery);
      for (const m of enrichedMentions) {
        if (!intent.entityMentions.includes(m)) {
          intent.entityMentions.push(m);
        }
      }
      const enrichedAliases = matchAlias(normalizeQuery(searchQuery));
      for (const a of enrichedAliases) {
        if (!intent.aliasMatches.some((existing) => existing.canonical === a.canonical)) {
          intent.aliasMatches.push(a);
        }
      }
      intent.aliasMatches.sort((a, b) => b.confidence - a.confidence);
    }

    const entityKeyPattern = /\b([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))\b/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = entityKeyPattern.exec(baseQuery)) !== null) {
      const key = keyMatch[1];
      if (!intent.entityMentions.includes(key)) {
        intent.entityMentions.push(key);
      }
    }

    searchSpan.setAttribute('intent.isEnumeration', intent.isEnumeration);
    searchSpan.setAttribute('intent.isExactKey', intent.isExactKeyQuery);
    searchSpan.setAttribute('intent.isComparison', intent.isComparison);
    if (intent.inferredType) searchSpan.setAttribute('intent.inferredType', intent.inferredType);
    if (intent.aliasMatches.length > 0) searchSpan.setAttribute('intent.aliasMatches', intent.aliasMatches.map((a) => a.canonical).join(','));
    if (intent.entityMentions.length > 0) searchSpan.setAttribute('intent.entityMentions', intent.entityMentions.join(','));

    // -----------------------------------------------------------------------
    // Fast path 1 & 2: Pin exact-key and alias results, then continue to
    // hybrid search. For comparison/enumeration queries this ensures missing
    // entities get a second chance via vector/FTS/ILIKE. For single-entity
    // queries the pinned results are promoted to the top after rerank.
    // -----------------------------------------------------------------------
    const pinnedResults: SearchResult[] = [];
    const pinnedIds = new Set<string>();
    let pinnedBy: string | undefined;

    function pinResults(results: SearchResult[], source?: string) {
      for (const r of results) {
        if (!pinnedIds.has(r.doc_id)) {
          pinnedIds.add(r.doc_id);
          pinnedResults.push(source ? { ...r, source: r.source ?? source } : r);
        }
      }
    }

    // Fast paths run concurrently (no inter-dependency); results are pinned afterwards in
    // priority order (exact-key > alias > mention) to keep ordering deterministic (A8).
    const aliasCanonicals =
      intent.aliasMatches.length > 0 && intent.aliasMatches[0].confidence >= 0.8
        ? (intent.isComparison || intent.isEnumeration
            ? intent.aliasMatches.filter((a) => a.confidence >= 0.8)
            : [intent.aliasMatches[0]]
          ).map((a) => a.canonical)
        : [];

    const [exactKeyResults, aliasResultsList, mentionResults] = await Promise.all([
      intent.isExactKeyQuery && intent.exactKey
        ? exactKeySearch(pool, table, intent.exactKey, intent, filters, topK)
        : Promise.resolve([] as SearchResult[]),
      Promise.all(
        aliasCanonicals.map((c) => aliasExactSearch(pool, table, c, intent, filters, topK)),
      ).then((lists) => lists.flat()),
      intent.entityMentions.length > 0
        ? entityMentionSearch(pool, table, intent.entityMentions, intent, filters, topK)
        : Promise.resolve([] as SearchResult[]),
    ]);

    if (exactKeyResults.length > 0) {
      pinResults(exactKeyResults, 'exact-key');
      pinnedBy = 'exact-key';
    }
    if (aliasResultsList.length > 0) {
      pinResults(aliasResultsList, 'alias');
      if (!pinnedBy) pinnedBy = 'alias';
    }
    if (mentionResults.length > 0) {
      pinResults(mentionResults, 'mention');
    }

    const effectiveTopK = Math.max(topK + offset, 60);

    // Enumeration uses a dedicated path: return the full type-filtered set in key order,
    // WITHOUT reranking (rerank would reorder/truncate and break list completeness). A4.
    if (intent.isEnumeration) {
      const enumLimit = Math.max(topK + offset, 300);
      const enumResults = await enumerationSqlSearch(pool, table, intent, filters, enumLimit);
      const merged: SearchResult[] = [];
      const seenEnum = new Set<string>();
      for (const r of [...pinnedResults, ...enumResults]) {
        if (seenEnum.has(r.doc_id)) continue;
        seenEnum.add(r.doc_id);
        merged.push({ ...r, source: r.source ?? 'enumeration' });
      }
      searchSpan.setAttribute('path', 'enumeration');
      searchSpan.setAttribute('resultCount', merged.length);
      searchSpan.setAttribute('pinnedResults', pinnedResults.length);
      setCachedSearch(cacheKey, query, merged).catch(() => {});
      searchSpan.end();
      return merged.slice(offset, offset + topK);
    }

    const candidatePool = Math.max(topK * 4, 120);
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

    // --- Stage C: Scored ILIKE ---
    const terms = extractSearchTerms(expandedQuery);
    let ilikeResults: SearchResult[] = [];
    if (terms.length > 0) {
      ilikeResults = await scoredIlikeSearch(pool, table, terms, intent, filters, ilikePool);
    }

    // (Enumeration is handled earlier via a dedicated path; non-enumeration falls through
    //  to the hybrid vector + FTS + ILIKE fusion below.)

    // Execute vector and FTS queries in parallel
    const vectorClient = await pool.connect();
    const ftsClient = await pool.connect();

    let vectorResults: SearchResult[] = [];
    let ftsResults: SearchResult[] = [];

    // ef_search controls HNSW recall breadth; the default (40) is far below our LIMIT,
    // so without raising it the tail of the candidate list degrades. iterative_scan keeps
    // recall high when results are post-filtered by type (pgvector >= 0.8).
    const efSearch = config.hnswEfSearch > 0
      ? config.hnswEfSearch
      : Math.min(Math.max(vectorPool * 2, 100), 500);
    const useIterativeScan =
      (intent.inferredType !== undefined || filters.type !== undefined) &&
      (await supportsHnswIterativeScan(pool));

    try {
      const runVector = async () => {
        // SET LOCAL only applies inside a transaction.
        await vectorClient.query('BEGIN');
        try {
          await vectorClient.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
          if (useIterativeScan) {
            await vectorClient.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
          }
          const r = await vectorClient.query(vectorSql, vectorParams);
          await vectorClient.query('COMMIT');
          return r;
        } catch (e) {
          await vectorClient.query('ROLLBACK').catch(() => {});
          throw e;
        }
      };

      const [vRes, fRes] = await Promise.all([
        runVector(),
        ftsClient.query(ftsSql, ftsParams).catch(() => ({ rows: [] })),
      ]);

      vectorResults = vRes.rows.map((row) => ({
        doc_id: row.doc_id,
        type: row.type,
        key: row.key,
        content: row.content,
        metadata: row.metadata,
        distance: parseFloat(row.distance),
        source: 'vector',
      }));

      ftsResults = (fRes as { rows: { doc_id: string; type: string; key: string; content: string; metadata: Record<string, unknown>; fts_rank: number }[] }).rows.map((row) => ({
        doc_id: row.doc_id,
        type: row.type as DocumentType,
        key: row.key,
        content: row.content,
        metadata: row.metadata as SearchResult['metadata'],
        distance: -row.fts_rank,
        source: 'fts',
      }));
    } finally {
      vectorClient.release();
      ftsClient.release();
    }

    searchSpan.setAttribute('vectorResults', vectorResults.length);
    searchSpan.setAttribute('ftsResults', ftsResults.length);
    searchSpan.setAttribute('ilikeResults', ilikeResults.length);
    searchSpan.setAttribute('pinnedResults', pinnedResults.length);

    // --- Weighted RRF fusion ---
    // FTS uses to_tsvector('simple'), which does not segment CJK; for (near-)pure-CJK
    // queries its results are unreliable, so down-weight that route (A6②).
    const cjkCount = (query.match(/[㐀-鿿豈-﫿]/g) || []).length;
    const isCjkHeavy = cjkCount / Math.max(query.replace(/\s/g, '').length, 1) > 0.5;
    const ftsWeight = isCjkHeavy ? config.rrfWeightFts * config.rrfFtsCjkScale : config.rrfWeightFts;

    const allLists = [vectorResults, ftsResults, ilikeResults];
    const allWeights = [config.rrfWeightVector, ftsWeight, config.rrfWeightIlike];

    const activeLists = allLists.filter((l) => l.length > 0);
    const activeWeights = allLists
      .map((l, i) => (l.length > 0 ? allWeights[i] : -1))
      .filter((w) => w >= 0);

    let candidates: SearchResult[];

    if (activeLists.length <= 1) {
      candidates = activeLists[0] ?? vectorResults;
    } else {
      candidates = weightedReciprocalRankFusion(activeLists, {
        k: config.rrfK,
        weights: activeWeights,
      });
    }

    // Deduplicate
    const seen = new Set<string>();
    candidates = candidates.filter((c) => {
      if (seen.has(c.doc_id)) return false;
      seen.add(c.doc_id);
      return true;
    });

    // --- Missing entity second search (comparison queries) ---
    if (intent.isComparison && intent.aliasMatches.length > 0) {
      const foundCanonicals = new Set<string>();
      for (const p of pinnedResults) {
        const k = p.key.toLowerCase().replace(/^gkw_/, '').replace(/\.(weapon|vehicle|projectile|call|carry_item|xml|character)$/, '');
        foundCanonicals.add(k);
      }
      for (const c of candidates) {
        const k = c.key.toLowerCase().replace(/^gkw_/, '').replace(/\.(weapon|vehicle|projectile|call|carry_item|xml|character)$/, '');
        foundCanonicals.add(k);
      }

      const missingAliases = intent.aliasMatches.filter(
        (a) => a.confidence >= 0.8 && !foundCanonicals.has(a.canonical),
      );

      if (missingAliases.length > 0) {
        // Direct alias lookup instead of a recursive full search() (which would re-run
        // embedding + rerank + caching for each comparison). A9.
        const missingLists = await Promise.all(
          missingAliases.map((a) =>
            aliasExactSearch(pool, table, a.canonical, intent, filters, Math.min(topK, 5)),
          ),
        );
        const missingResults = missingLists.flat();
        pinResults(missingResults, 'alias');
        for (const r of missingResults) {
          candidates = candidates.filter((c) => c.doc_id !== r.doc_id);
        }
        searchSpan.setAttribute('missingEntities', missingAliases.map((a) => a.canonical).join(','));
      }
    }

    // --- Protect pinned (exact/alias) results: prepend before rerank ---
    const unpinnedCandidates = candidates.filter((c) => !pinnedIds.has(c.doc_id));
    const pinnedFirst = [...pinnedResults, ...unpinnedCandidates];

    // Stage 2: rerank
    const rerankInput = pinnedFirst.slice(0, Math.min(pinnedFirst.length, candidatePool));
    const reranked = await rerankCandidates(query, rerankInput, effectiveTopK, searchQuery);

    // Re-ensure pinned results stay in top positions if they were reranked out
    let finalResults = reranked;
    if (pinnedResults.length > 0 && config.rerankPinnedPrefix) {
      const rerankedIds = new Set(reranked.slice(0, topK).map((r) => r.doc_id));
      const missingPinned = pinnedResults.filter((p) => !rerankedIds.has(p.doc_id));
      if (missingPinned.length > 0) {
        finalResults = [...missingPinned, ...reranked.filter((r) => !pinnedIds.has(r.doc_id))];
      }
    }

    searchSpan.setAttribute('candidateCount', candidates.length);
    searchSpan.setAttribute('resultCount', finalResults.length);
    searchSpan.setAttribute('path', pinnedResults.length > 0 ? 'pinned+hybrid' : 'hybrid');
    if (pinnedBy) searchSpan.setAttribute('pinnedBy', pinnedBy);
    searchSpan.setAttribute('offset', offset);
    setCachedSearch(cacheKey, query, finalResults).catch(() => {});

    searchSpan.end();
    const paginated = finalResults.slice(offset, offset + topK);
    return paginated;
  });
}

// ---------------------------------------------------------------------------
// Exact key search (fast path for key=... queries)
// ---------------------------------------------------------------------------
async function exactKeySearch(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: string,
  exactKey: string,
  intent: QueryIntent,
  filters: SearchFilters,
  topK: number,
): Promise<SearchResult[]> {
  const client = await pool.connect();
  try {
    const conditions: string[] = [`key = $1`];
    const params: (string | number)[] = [exactKey];
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

    const exactSql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance
      FROM ${table}
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIdx}
    `;
    params.push(topK);

    const res = await client.query(exactSql, params);
    if (res.rows.length > 0) {
      return res.rows.map((row) => ({
        doc_id: row.doc_id,
        type: row.type,
        key: row.key,
        content: row.content,
        metadata: row.metadata,
        distance: parseFloat(row.distance),
      }));
    }

    // Fallback to ILIKE on key
    const likeConditions: string[] = [`key ILIKE $1`];
    const likeParams: (string | number)[] = [`%${exactKey}%`];
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

    const likeSql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance
      FROM ${table}
      WHERE ${likeConditions.join(' AND ')}
      LIMIT $${likeParamIdx}
    `;
    likeParams.push(topK);

    const likeRes = await client.query(likeSql, likeParams);
    return likeRes.rows.map((row) => ({
      doc_id: row.doc_id,
      type: row.type,
      key: row.key,
      content: row.content,
      metadata: row.metadata,
      distance: parseFloat(row.distance),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Alias exact search (natural entity name → direct key lookup)
// ---------------------------------------------------------------------------
async function aliasExactSearch(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: string,
  canonical: string,
  intent: QueryIntent,
  filters: SearchFilters,
  topK: number,
): Promise<SearchResult[]> {
  const client = await pool.connect();
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    conditions.push(`(key = $${paramIdx} OR key ILIKE $${paramIdx + 1} OR content ILIKE $${paramIdx + 2})`);
    params.push(canonical, `%${canonical}%`, `%${canonical.replace(/^gkw_/, '').replace(/[._]/g, '%')}%`);
    paramIdx += 3;

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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance,
             CASE WHEN key = $1 THEN 0 ELSE 1 END AS key_exact_rank
      FROM ${table}
      ${where}
      ORDER BY key_exact_rank ASC, length(key) ASC
      LIMIT $${paramIdx}
    `;
    params.push(topK);

    const res = await client.query(sql, params);
    return res.rows.map((row) => ({
      doc_id: row.doc_id,
      type: row.type,
      key: row.key,
      content: row.content,
      metadata: row.metadata,
      distance: parseFloat(row.distance),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Entity mention search (extracted entity names → key ILIKE lookup)
// ---------------------------------------------------------------------------
async function entityMentionSearch(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: string,
  mentions: string[],
  intent: QueryIntent,
  filters: SearchFilters,
  topK: number,
): Promise<SearchResult[]> {
  if (mentions.length === 0) return [];

  const client = await pool.connect();
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    const orParts: string[] = [];
    const exactCases: string[] = [];
    for (let i = 0; i < mentions.length; i++) {
      // Match both the raw mention and a separator-stripped form: mentions arrive in
      // mixed normalization (e.g. 'desert_eagle' vs 'deserteagle') while stored keys
      // keep separators ('gkw_desert_eagle.weapon'). The first ILIKE uses the trgm index.
      const stripped = mentions[i].toLowerCase().replace(/[_-]/g, '');
      orParts.push(`(key ILIKE $${paramIdx} OR replace(replace(lower(key), '_', ''), '-', '') ILIKE $${paramIdx + 1})`);
      params.push(`%${mentions[i]}%`, `%${stripped}%`);
      exactCases.push(`CASE WHEN key ILIKE $${paramIdx} THEN 1 ELSE 0 END`);
      paramIdx += 2;
    }
    conditions.push(`(${orParts.join(' OR ')})`);

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

    const matchScore = exactCases.length > 0 ? `(${exactCases.join(' + ')})` : '0';
    const sql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance,
             ${matchScore} AS mention_match_score
      FROM ${table}
      WHERE ${conditions.join(' AND ')}
      ORDER BY mention_match_score DESC, length(key) ASC
      LIMIT $${paramIdx}
    `;
    params.push(topK);

    const res = await client.query(sql, params);
    return res.rows.map((row) => ({
      doc_id: row.doc_id,
      type: row.type,
      key: row.key,
      content: row.content,
      metadata: row.metadata,
      distance: parseFloat(row.distance),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Scored ILIKE: key hit > content hit, with ranking
// ---------------------------------------------------------------------------
async function scoredIlikeSearch(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: string,
  terms: string[],
  intent: QueryIntent,
  filters: SearchFilters,
  limit: number,
): Promise<SearchResult[]> {
  const client = await pool.connect();
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

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

    const termOrParts: string[] = [];
    const keyHitCases: string[] = [];
    for (const t of terms) {
      const p1 = paramIdx++;
      const p2 = paramIdx++;
      params.push(`%${t}%`, `%${t}%`);
      termOrParts.push(`(key ILIKE $${p1} OR content ILIKE $${p2})`);
      keyHitCases.push(`CASE WHEN key ILIKE $${p1} THEN 1 ELSE 0 END`);
    }
    if (termOrParts.length > 0) {
      conditions.push(`(${termOrParts.join(' OR ')})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const keyScoreExpr = keyHitCases.length > 0
      ? `(${keyHitCases.join(' + ')})`
      : '0';

    const sql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance,
             ${keyScoreExpr} AS key_hit_score
      FROM ${table}
      ${where}
      ORDER BY key_hit_score DESC, length(key) ASC
      LIMIT $${paramIdx}
    `;
    params.push(limit);

    const res = await client.query(sql, params);
    return res.rows.map((row) => ({
      doc_id: row.doc_id,
      type: row.type,
      key: row.key,
      content: row.content,
      metadata: row.metadata,
      distance: parseFloat(row.distance),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Enumeration SQL route: direct type-based SQL for enumeration queries
// ---------------------------------------------------------------------------
async function enumerationSqlSearch(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: string,
  intent: QueryIntent,
  filters: SearchFilters,
  limit: number,
): Promise<SearchResult[]> {
  const client = await pool.connect();
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

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
    if (filters.faction) {
      conditions.push(`metadata->>'faction' = $${paramIdx++}`);
      params.push(filters.faction);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT doc_id, type, key, content, metadata, 0.0 AS distance
      FROM ${table}
      ${where}
      ORDER BY key ASC
      LIMIT $${paramIdx}
    `;
    params.push(limit);

    const res = await client.query(sql, params);
    return res.rows.map((row) => ({
      doc_id: row.doc_id,
      type: row.type,
      key: row.key,
      content: row.content,
      metadata: row.metadata,
      distance: parseFloat(row.distance),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Text processing utilities
// ---------------------------------------------------------------------------
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
