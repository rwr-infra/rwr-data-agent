import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function modelsRoutes(app: FastifyInstance) {
  app.get('/models', () => {
    return {
      object: 'list',
      data: [
        // `rwr-agent` is an internal alias meaning "the operator's default model" — the bundled
        // UI used to send it unconditionally and older clients still do, so it stays advertised.
        {
          id: 'rwr-agent',
          object: 'model',
          created: 0,
          owned_by: 'rwr-data-agent',
        },
        // `display_name` is the mapping table the UI renders (Gemini Flash/Pro style): friendly
        // labels from LLM_MODEL_LABELS, raw ids as the wire format. Additive to the OpenAI shape.
        ...config.llmModels.map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'configured',
          display_name: config.llmModelLabels[id] ?? id,
        })),
      ],
    };
  });
}
