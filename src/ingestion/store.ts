import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { rwrDocuments } from '../db/schema.js';
import type { RWRDocument } from '../types/index.js';

export async function storeDocuments(docs: RWRDocument[], embeddings: number[][]): Promise<void> {
  if (docs.length !== embeddings.length) {
    throw new Error('Documents and embeddings length mismatch');
  }
  const values = docs.map((doc, i) => ({
    type: doc.type,
    key: doc.key,
    content: doc.content,
    metadata: doc.metadata,
    embedding: embeddings[i],
  }));

  await db.insert(rwrDocuments).values(values);
}

export async function clearModDocuments(modName: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM rwr_documents WHERE metadata->>'mod_name' = $1", [modName]);
  } finally {
    client.release();
  }
}
