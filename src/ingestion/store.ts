import { getDb, getPool } from '../db/index.js';
import { rwrDocuments } from '../db/schema.js';
import { config } from '../config/index.js';
import type { RWRDocument } from '../types/index.js';

const tableName = config.databaseTable;

export async function storeDocuments(docs: RWRDocument[], embeddings: number[][]): Promise<void> {
  if (docs.length !== embeddings.length) {
    throw new Error('Documents and embeddings length mismatch');
  }
  const db = await getDb();
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
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM ${tableName} WHERE metadata->>'mod_name' = $1`, [modName]);
  } finally {
    client.release();
  }
}

export async function dropAndRecreateTable(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    console.log(`Dropping table ${tableName}...`);
    await client.query(`DROP TABLE IF EXISTS ${tableName}`);
    console.log(`Table dropped.`);
  } finally {
    client.release();
  }
}

export async function getExistingKeys(modName: string): Promise<Set<string>> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT type, key FROM ${tableName} WHERE metadata->>'mod_name' = $1`,
      [modName]
    );
    const keys = new Set<string>();
    for (const row of res.rows) {
      keys.add(`${row.type}:${row.key}`);
    }
    return keys;
  } finally {
    client.release();
  }
}
