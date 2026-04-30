import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config/index.js';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
});

export const db = drizzle(pool, { schema });

export { pool };
