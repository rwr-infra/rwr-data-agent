import { getPool } from './index.js';
import { config } from '../config/index.js';

const tableName = config.databaseTable;

const initSql = `
CREATE EXTENSION IF NOT EXISTS vector;

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
`;

export async function runMigrate(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    console.log('Running database initialization...');
    await client.query(initSql);
    console.log('Database initialized successfully.');
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