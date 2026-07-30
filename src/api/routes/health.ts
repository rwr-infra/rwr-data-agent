import type { FastifyInstance } from 'fastify';
import { getIndexStatus } from '../../indexing/bootstrap.js';
import { getIndexMeta } from '../../retrieval/localSearch.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', () => {
    const status = getIndexStatus();
    const meta = getIndexMeta() ?? status.meta;

    return {
      status: status.ready ? 'ok' : status.building ? 'building' : 'degraded',
      index: {
        ready: status.ready,
        building: status.building,
        documents: meta?.count ?? 0,
        packages: meta?.packages.map((p) => p.name) ?? [],
        builtAt: meta?.built_at ?? null,
        ...(status.reason ? { reason: status.reason } : {}),
      },
    };
  });
}
