import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

export async function modelsRoutes(app: FastifyInstance) {
  app.get('/models', async () => {
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
