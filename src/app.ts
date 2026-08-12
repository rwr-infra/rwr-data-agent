import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import { chatRoutes } from './api/routes/chat.js';
import { steerRoutes } from './api/routes/steer.js';
import { modelsRoutes } from './api/routes/models.js';
import { healthRoutes } from './api/routes/health.js';
import { packagesRoutes } from './api/routes/packages.js';
import { limitsRoutes } from './api/routes/limits.js';
import { toolsRoutes } from './api/routes/tools.js';
import { shutdownLangfuse } from './observability/langfuse.js';
import { getIndexStatus, startIndexes } from './indexing/bootstrap.js';
import { config } from './config/index.js';

export async function buildApp() {
  // Kick off the index build/load *without* waiting for it. A cold rebuild is minutes of CPU
  // on a small host, and awaiting it here kept the port closed for that whole time — health
  // probes failed and the process looked hung. `/health` reports `building` until it is warm.
  // Never throws — a failure leaves the server up and is reported through /health.
  void startIndexes();

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  // `origin: true` reflects whatever Origin the caller sends — the historical default, kept so an
  // existing LAN deployment does not break on upgrade. Set CORS_ORIGINS to lock it down.
  await app.register(cors, { origin: config.corsOrigins.length > 0 ? config.corsOrigins : true });
  if (config.corsOrigins.length > 0) {
    console.log(`[server] CORS restricted to: ${config.corsOrigins.join(', ')}`);
  }

  // Optional bearer auth on the API surface. `/health` stays open for probes and the static UI stays
  // open so the page can load and then present its own token.
  if (config.apiToken) {
    console.log('[server] API_TOKEN set — /v1/* requires Authorization: Bearer or x-api-key');
    app.addHook('onRequest', (request, reply, done) => {
      if (!request.url.startsWith('/v1/')) return done();
      const header = request.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const presented = bearer ?? (request.headers['x-api-key'] as string | undefined);
      if (presented === config.apiToken) return done();
      reply.status(401).send({ error: { message: 'Unauthorized', type: 'authentication_error' } });
      return;
    });
  }

  // Retrieval is the only surface that needs the index. Answering from an empty index would
  // look like "the game has no such weapon", so say plainly that it is not ready yet.
  app.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/v1/chat')) return done();
    const index = getIndexStatus();
    if (index.ready) return done();
    reply
      .status(503)
      .header('retry-after', '30')
      .send({
        error: {
          message: index.building
            ? 'Index is still building — retry in a moment.'
            : (index.reason ?? 'Index not ready'),
          type: 'index_unavailable',
        },
      });
    return;
  });

  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(steerRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(packagesRoutes, { prefix: '/v1' });
  await app.register(toolsRoutes, { prefix: '/v1' });
  await app.register(limitsRoutes, { prefix: '/v1' });
  await app.register(healthRoutes);

  try {
    const staticModule = await import('@fastify/static');
    const publicDir = path.join(process.cwd(), 'public');
    await app.register(staticModule.default, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((_, reply) => {
      return reply.sendFile('index.html');
    });
  } catch {
    console.log('@fastify/static not available, skipping static file serving');
  }

  app.setErrorHandler((error: Error, _request, reply) => {
    console.error('Request error:', error.message);
    reply.status(500).send({
      error: { message: error.message, type: 'internal_error' },
    });
  });

  app.addHook('onClose', async () => {
    if (config.langfuseEnabled) {
      await shutdownLangfuse();
    }
  });

  return app;
}
