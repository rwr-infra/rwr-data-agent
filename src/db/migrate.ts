import { getPool } from './index.js';
import { config } from '../config/index.js';

const tableName = config.databaseTable;

const initSql = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: If you change EMBEDDING_DIMENSION after data exists,
-- you must drop the table first (data will be lost):
-- DROP TABLE IF EXISTS ${tableName};

CREATE TABLE IF NOT EXISTS ${tableName} (
  doc_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(${config.embeddingDimension}),
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(type, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(key, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED
);

-- Add fts column to existing tables that were created before this column existed.
-- The IF NOT EXISTS check is handled by checking column existence first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = '${tableName}' AND column_name = 'fts'
  ) THEN
    ALTER TABLE ${tableName}
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(type, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(key, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(content, '')), 'B')
      ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_${tableName}_embedding
  ON ${tableName} USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_${tableName}_metadata
  ON ${tableName} USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_${tableName}_fts
  ON ${tableName} USING gin (fts);

-- Trigram indexes so the retrieval fast-paths' "key/content ILIKE '%x%'" lookups
-- use an index instead of a sequential scan (pg_trgm is supported on Neon too).
CREATE INDEX IF NOT EXISTS idx_${tableName}_key_trgm
  ON ${tableName} USING gin (key gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_${tableName}_content_trgm
  ON ${tableName} USING gin (content gin_trgm_ops);
`;

export async function runMigrate(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    console.log('Running database initialization...');
    await client.query(initSql);
    console.log('Database initialized successfully.');

    // pgvector >= 0.8 supports hnsw.iterative_scan, which preserves recall when ANN
    // results are post-filtered by WHERE (type=...). Log the version so operators know
    // whether the iterative scan engages or whether search falls back to a larger ef_search.
    try {
      const { rows } = await client.query(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      );
      const v = rows[0]?.extversion as string | undefined;
      if (v) {
        const [maj, min] = v.split('.').map((n: string) => parseInt(n, 10));
        const supportsIterative = maj > 0 || (maj === 0 && min >= 8);
        console.log(
          supportsIterative
            ? `pgvector ${v}: hnsw.iterative_scan supported (filtered vector recall enabled).`
            : `pgvector ${v}: hnsw.iterative_scan NOT supported — upgrade to >=0.8 for better filtered recall; search falls back to a larger ef_search.`,
        );
      }
    } catch {
      /* version probe is best-effort */
    }
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await runMigrate();
  } catch (err) {
    process.exit(1);
  } finally {
    const pool = await getPool();
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith('db/migrate.ts') || process.argv[1]?.endsWith('db/migrate.js');
if (isDirectRun) {
  main();
}