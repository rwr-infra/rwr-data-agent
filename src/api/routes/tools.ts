import type { FastifyInstance } from 'fastify';
import { getAgentTools, getToolInventory } from '../../agent/toolDefs.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function toolsRoutes(app: FastifyInstance) {
  app.get('/tools', async () => {
    // Force a load so a first call right after boot reports the real inventory, and a
    // pending hot reload is applied before we report it.
    try {
      await getAgentTools();
    } catch (err) {
      return { error: (err as Error).message, ...getToolInventory() };
    }
    return getToolInventory();
  });
}
