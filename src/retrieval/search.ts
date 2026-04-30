import { pool } from '../db/index.js';
import { createEmbedding } from '../ingestion/embeddings.js';
import { rerankCandidates } from './rerank.js';
import { config } from '../config/index.js';
import type { SearchFilters, SearchResult } from '../types/index.js';

interface QueryIntent {
  inferredType?: string;
  contentPattern?: string;
  isEnumeration: boolean;
}

function extractQueryIntent(query: string): QueryIntent {
  const intent: QueryIntent = { isEnumeration: false };

  // Enumeration query detection (Chinese & English patterns)
  if (/有哪些|列出|所有|全部|是什么|what are|list all/i.test(query)) {
    intent.isEnumeration = true;
  }

  // Document type inference from query text
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
  }

  // Extract class="N" or class=N or class: N patterns
  const classMatch = query.match(/class\s*[=:]\s*["']?(\d+)["']?/i);
  if (classMatch) {
    intent.contentPattern = `%class: ${classMatch[1]}%`;
  }

  // Extract specification references
  if (/specification|规格|属性/i.test(query) && !intent.contentPattern) {
    // If user mentions specification but no class value, still boost text search relevance
    intent.contentPattern = '%specification:%';
  }

  return intent;
}

export async function search(
  query: string,
  filters: SearchFilters = {},
  topK = 5
): Promise<SearchResult[]> {
  const intent = extractQueryIntent(query);

  // Stage 1: retrieve a larger candidate pool for reranking
  const candidatePool = intent.isEnumeration ? 200 : Math.max(topK * 8, 40);

  const embedding = await createEmbedding(query);
  const vectorLiteral = `[${embedding.join(',')}]`;

  const conditions: string[] = [];
  const params: (string | number)[] = [vectorLiteral];
  let paramIdx = 2;

  // Apply explicit filters
  if (filters.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(filters.type);
  } else if (intent.inferredType) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(intent.inferredType);
  }

  if (filters.faction) {
    conditions.push(`metadata->>'faction' = $${paramIdx++}`);
    params.push(filters.faction);
  }
  if (filters.mod_name) {
    conditions.push(`metadata->>'mod_name' = $${paramIdx++}`);
    params.push(filters.mod_name);
  }
  if (filters.weapon_class) {
    conditions.push(`metadata->>'weapon_class' = $${paramIdx++}`);
    params.push(filters.weapon_class);
  }

  // Apply content text filter extracted from query (e.g., class="3")
  if (intent.contentPattern) {
    conditions.push(`content ILIKE $${paramIdx++}`);
    params.push(intent.contentPattern);
  }

  const tableName = config.databaseTable;
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT doc_id, type, key, content, metadata,
           embedding <=> $1::vector AS distance
    FROM ${tableName}
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $${paramIdx}
  `;
  params.push(candidatePool);

  const client = await pool.connect();
  let candidates: SearchResult[];
  try {
    const res = await client.query(sql, params);
    candidates = res.rows.map((row) => ({
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

  // Stage 2: rerank candidates for better precision
  const reranked = await rerankCandidates(query, candidates, topK);
  return reranked;
}
