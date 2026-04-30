import { pgTable, uuid, text, jsonb, vector, index } from 'drizzle-orm/pg-core';
import { config } from '../config/index.js';

export const rwrDocuments = pgTable(
  'rwr_documents',
  {
    docId: uuid('doc_id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    key: text('key').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    embedding: vector('embedding', { dimensions: config.embeddingDimension }),
  },
  (table) => [
    index('idx_rwr_documents_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('idx_rwr_documents_metadata').using('gin', table.metadata),
  ]
);
