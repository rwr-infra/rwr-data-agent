import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatRoutes } from './api/routes/chat.js';
import { modelsRoutes } from './api/routes/models.js';
import { healthRoutes } from './api/routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: true });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(healthRoutes);

  try {
    const staticModule = await import('@fastify/static');
    await app.register(staticModule.default, {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((_, reply) => {
      return reply.sendFile('index.html');
    });
  } catch {
    console.log('@fastify/static not available, skipping static file serving');
  }

  app.setErrorHandler((error: Error, request, reply) => {
    console.error('Request error:', error.message);
    reply.status(500).send({
      error: { message: error.message, type: 'internal_error' },
    });
  });

  return app;
}