import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatRoutes } from './api/routes/chat.js';
import { modelsRoutes } from './api/routes/models.js';
import { healthRoutes } from './api/routes/health.js';
import { tablesRoutes } from './api/routes/tables.js';
import { shutdownLangfuse } from './observability/langfuse.js';
import { config } from './config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isVercel = !!process.env.VERCEL;

let indexHtml: string | null = null;

export async function buildApp() {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: true });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(tablesRoutes, { prefix: '/v1' });
  await app.register(healthRoutes);

  if (!isVercel) {
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
  } else {
    app.get('/', async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      if (!indexHtml) {
        try {
          const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
          indexHtml = fs.readFileSync(htmlPath, 'utf-8');
        } catch {
          indexHtml = '<html><body><h1>RWR Data Agent</h1><p>Frontend unavailable.</p></body></html>';
        }
      }
      reply.send(indexHtml);
    });
  }

  app.setErrorHandler((error: Error, request, reply) => {
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