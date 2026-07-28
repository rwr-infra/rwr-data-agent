import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function modelsRoutes(app: FastifyInstance) {
  app.get('/models', () => {
    return {
      object: 'list',
      data: [
        {
          id: 'rwr-agent',
          object: 'model',
          created: 0,
          owned_by: 'rwr-data-agent',
        },
        {
          id: config.llmModel,
          object: 'model',
          created: 0,
          owned_by: 'siliconflow',
        },
      ],
    };
  });
}
