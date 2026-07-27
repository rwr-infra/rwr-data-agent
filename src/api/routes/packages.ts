import type { FastifyInstance } from 'fastify';
import { getIndexMeta, readIndexMeta } from '../../retrieval/localSearch.js';
import { config } from '../../config/index.js';

export async function packagesRoutes(app: FastifyInstance) {
  app.get('/packages', async () => {
    // Served from the loaded index when the bootstrap warmed it; otherwise read the header.
    const meta = getIndexMeta() ?? (await readIndexMeta(config.searchIndexPath));
    return {
      data_dir: meta?.data_dir ?? config.dataDir,
      built_at: meta?.built_at ?? null,
      packages: meta?.packages ?? [],
    };
  });
}
