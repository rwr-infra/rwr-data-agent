import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/index.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      return { status: 'ok', database: 'connected' };
    } catch {
      return { status: 'error', database: 'disconnected' };
    }
  });
}
