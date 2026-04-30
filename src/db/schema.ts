import { pgTable, uuid, text, jsonb, vector, index } from 'drizzle-orm/pg-core';
import { config } from '../config/index.js';

const tableName = config.databaseTable;

export const rwrDocuments = pgTable(
  tableName,
  {
    docId: uuid('doc_id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    key: text('key').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    embedding: vector('embedding', { dimensions: config.embeddingDimension }),
  },
  (table) => [
    index(`idx_${tableName}_embedding`).using('hnsw', table.embedding.op('vector_cosine_ops')),
    index(`idx_${tableName}_metadata`).using('gin', table.metadata),
  ]
);
