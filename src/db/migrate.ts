import { pool } from './index.js';
import { config } from '../config/index.js';

const initSql = `
CREATE EXTENSION IF NOT EXISTS vector;

-- NOTE: If you change EMBEDDING_DIMENSION after data exists,
-- you must drop the table first (data will be lost):
-- DROP TABLE IF EXISTS rwr_documents;

CREATE TABLE IF NOT EXISTS rwr_documents (
  doc_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(${config.embeddingDimension})
);

CREATE INDEX IF NOT EXISTS idx_rwr_documents_embedding
  ON rwr_documents USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_rwr_documents_metadata
  ON rwr_documents USING gin (metadata);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running database initialization...');
    await client.query(initSql);
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
