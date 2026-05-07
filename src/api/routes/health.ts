import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/index.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    try {
      const pool = await getPool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      return { status: 'ok', database: 'connected' };
    } catch {
      return { status: 'error', database: 'disconnected' };
    }
  });
}
