import { config } from '../config/index.js';
import * as schema from './schema.js';

export let pool: import('pg').Pool;
export let db: ReturnType<typeof import('drizzle-orm/node-postgres').drizzle>;

if (config.databaseProvider === 'neon') {
  const { Pool: NeonPool } = await import('@neondatabase/serverless');
  const { drizzle: neonDrizzle } = await import('drizzle-orm/neon-serverless');

  const neonPool = new NeonPool({ connectionString: config.databaseUrl, ssl: true });
  pool = neonPool as unknown as import('pg').Pool;
  db = neonDrizzle(neonPool, { schema }) as unknown as typeof db;
} else {
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  db = drizzle(pool, { schema });
}