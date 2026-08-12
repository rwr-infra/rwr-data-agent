import type { FastifyInstance } from 'fastify';
import { getAgentTools, getToolInventory } from '../../agent/toolDefs.js';
import { getSkills, getSkillInventory } from '../../agent/skills.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function toolsRoutes(app: FastifyInstance) {
  /**
   * The extension inventory: built-in tools, plugin tools, and skills — each with its per-file
   * error when it failed to load. Both directories are hot-reloadable, and a hot reload nobody can
   * inspect is undebuggable, which is the whole reason this endpoint exists.
   */
  app.get('/tools', async () => {
    // Force a load so a first call right after boot reports the real inventory, and a
    // pending hot reload is applied before we report it.
    try {
      await getAgentTools();
    } catch (err) {
      return { error: (err as Error).message, ...getToolInventory(), ...getSkillInventory() };
    }
    // A broken skills directory must not hide the tool inventory — that is the half a caller is
    // usually here for.
    try {
      await getSkills();
    } catch (err) {
      console.warn(`[skill] inventory load failed: ${(err as Error).message}`);
    }
    return { ...getToolInventory(), ...getSkillInventory() };
  });
}
