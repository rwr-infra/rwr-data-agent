import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

/**
 * The server-side ceilings a client has to respect, published so the UI can show them *before* the
 * first turn rather than discovering them from a 400. `maxContextTokens` also rides on every
 * `finish` event; the round cap has no such carrier — a fresh conversation has sent nothing yet —
 * which is why this endpoint exists.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function limitsRoutes(app: FastifyInstance) {
  app.get('/limits', () => {
    return {
      /** Rounds one conversation may carry; `0` means unlimited. */
      max_conversation_rounds: config.maxConversationRounds,
      max_context_tokens: config.maxContextTokens,
    };
  });
}
