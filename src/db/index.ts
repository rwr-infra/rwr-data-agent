import { config, validateConfig } from '../config/index.js';
import * as schema from './schema.js';

type PgPool = import('pg').Pool;
type DrizzleInstance = ReturnType<typeof import('drizzle-orm/node-postgres').drizzle>;

let poolPromise: Promise<PgPool> | null = null;
let dbPromise: Promise<DrizzleInstance> | null = null;

async function initPool(): Promise<PgPool> {
  validateConfig();
  if (config.databaseProvider === 'neon') {
    const { Pool: NeonPool } = await import('@neondatabase/serverless');
    const neonPool = new NeonPool({
      connectionString: config.databaseUrl,
      ssl: true,
      max: config.databasePoolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    neonPool.on('error', (err) => {
      console.error('[db] Neon pool idle client error:', err.message);
    });
    return neonPool as unknown as PgPool;
  }
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => {
    console.error('[db] Pool idle client error:', err.message);
  });
  return pool;
}

async function initDb(): Promise<DrizzleInstance> {
  const p = await getPool();
  if (config.databaseProvider === 'neon') {
    const { Pool: NeonPool } = await import('@neondatabase/serverless');
    const { drizzle: neonDrizzle } = await import('drizzle-orm/neon-serverless');
    const neonPool = p as unknown as InstanceType<typeof NeonPool>;
    return neonDrizzle(neonPool, { schema }) as unknown as DrizzleInstance;
  }
  const { drizzle } = await import('drizzle-orm/node-postgres');
  return drizzle(p, { schema });
}

export async function getPool(): Promise<PgPool> {
  if (!poolPromise) poolPromise = initPool();
  return poolPromise;
}

export async function getDb(): Promise<DrizzleInstance> {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

export function resetPool(): void {
  poolPromise = null;
  dbPromise = null;
}