import { getDb, getPool } from '../db/index.js';
import { rwrDocuments } from '../db/schema.js';
import { config } from '../config/index.js';
import type { RWRDocument } from '../types/index.js';

const tableName = config.databaseTable;
const NEON_INSERT_CHUNK = 2; // Neon serverless: insert 2 docs at a time to avoid payload limits
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function storeDocuments(docs: RWRDocument[], embeddings: number[][]): Promise<void> {
  if (docs.length !== embeddings.length) {
    throw new Error('Documents and embeddings length mismatch');
  }

  const db = await getDb();
  const chunkSize = config.databaseProvider === 'neon' ? NEON_INSERT_CHUNK : docs.length;

  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    const chunkEmbeddings = embeddings.slice(i, i + chunkSize);
    const values = chunk.map((doc, j) => ({
      type: doc.type,
      key: doc.key,
      content: doc.content,
      metadata: doc.metadata,
      embedding: chunkEmbeddings[j],
    }));

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await db.insert(rwrDocuments).values(values);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
        const msg = (err as Error).message ?? '';
        const isTransient = msg.includes('terminated') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('Connection');

        if (isTransient && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * 2 ** attempt;
          console.warn(`  [store] Insert chunk ${Math.floor(i / chunkSize) + 1} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg}. Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
    if (lastError) throw lastError;
  }
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
