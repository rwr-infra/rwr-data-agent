import type { FastifyInstance } from 'fastify';
import { getIndexStatus } from '../../indexing/bootstrap.js';
import { getIndexMeta } from '../../retrieval/localSearch.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const status = getIndexStatus();
    const meta = getIndexMeta() ?? status.meta;

    return {
      status: status.ready ? 'ok' : 'degraded',
      index: {
        ready: status.ready,
        documents: meta?.count ?? 0,
        packages: meta?.packages.map((p) => p.name) ?? [],
        builtAt: meta?.built_at ?? null,
        ...(status.reason ? { reason: status.reason } : {}),
      },
    };
  });
}
