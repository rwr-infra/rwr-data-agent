import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config/index.js';
import { chatRoutes } from './routes/chat.js';
import { modelsRoutes } from './routes/models.js';
import { healthRoutes } from './routes/health.js';

const app = Fastify({
  logger: false,
});

async function start() {
  await app.register(cors, { origin: true });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(healthRoutes);

  app.setErrorHandler((error: Error, request, reply) => {
    console.error('Request error:', error.message);
    reply.status(500).send({
      error: { message: error.message, type: 'internal_error' },
    });
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`Server listening on port ${config.port}`);
  } catch (err) {
    console.error('Server failed to start:', err);
    process.exit(1);
  }
}

start();
