import { createHash } from 'node:crypto';
import { getPool } from '../db/index.js';
import type { SearchResult } from '../types/index.js';

const TABLE_NAME = 'rwr_search_cache';

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  cache_key VARCHAR(64) PRIMARY KEY,
  query TEXT NOT NULL,
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_created_at ON ${TABLE_NAME} (created_at);
`;

let bootstrapped = false;

async function ensureTable(): Promise<void> {
  if (bootstrapped) return;
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query(BOOTSTRAP_SQL);
    bootstrapped = true;
  } finally {
    client.release();
  }
}

export function generateCacheKey(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export class PostgresCache {
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<SearchResult[] | null> {
    await ensureTable();
    const pool = await getPool();
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT results, created_at, hit_count FROM ${TABLE_NAME} WHERE cache_key = $1`,
        [key],
      );
      if (res.rows.length === 0) return null;

      const row = res.rows[0];
      const age = Date.now() - new Date(row.created_at).getTime();
      if (age > this.ttlMs) {
        await client.query(`DELETE FROM ${TABLE_NAME} WHERE cache_key = $1`, [key]);
        return null;
      }

      await client.query(
        `UPDATE ${TABLE_NAME} SET hit_count = hit_count + 1 WHERE cache_key = $1`,
        [key],
      );
      return row.results as SearchResult[];
    } finally {
      client.release();
    }
  }

  async set(key: string, query: string, results: SearchResult[]): Promise<void> {
    await ensureTable();
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO ${TABLE_NAME} (cache_key, query, results) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (cache_key) DO UPDATE SET results = $3::jsonb, created_at = now(), hit_count = 0`,
        [key, query, JSON.stringify(results)],
      );
    } finally {
      client.release();
    }
  }

  async cleanup(): Promise<number> {
    await ensureTable();
    const pool = await getPool();
    const client = await pool.connect();
    try {
      const res = await client.query(
        `DELETE FROM ${TABLE_NAME} WHERE created_at < now() - interval '${Math.ceil(this.ttlMs / 1000)} seconds'`,
      );
      return res.rowCount ?? 0;
    } finally {
      client.release();
    }
  }
}
