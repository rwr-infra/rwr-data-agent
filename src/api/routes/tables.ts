import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/index.js';
import { config } from '../../config/index.js';

export async function tablesRoutes(app: FastifyInstance) {
  app.get('/tables', async () => {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT table_name FROM information_schema.columns WHERE column_name = 'doc_id' AND table_schema = 'public' GROUP BY table_name ORDER BY table_name`
      );
      const tables = res.rows.map((r) => r.table_name as string);
      return { default: config.databaseTable, tables };
    } finally {
      client.release();
    }
  });
}
