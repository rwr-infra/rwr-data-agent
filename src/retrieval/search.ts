import { pool } from '../db/index.js';
import { createEmbedding } from '../ingestion/embeddings.js';
import type { SearchFilters, SearchResult } from '../types/index.js';

export async function search(
  query: string,
  filters: SearchFilters = {},
  topK = 5
): Promise<SearchResult[]> {
  const embedding = await createEmbedding(query);
  const vectorLiteral = `[${embedding.join(',')}]`;

  const conditions: string[] = [];
  const params: (string | number)[] = [vectorLiteral];
  let paramIdx = 2;

  if (filters.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(filters.type);
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT doc_id, type, key, content, metadata,
           embedding <=> $1::vector AS distance
    FROM rwr_documents
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $${paramIdx}
  `;
  params.push(topK);

  const client = await pool.connect();
  try {
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
