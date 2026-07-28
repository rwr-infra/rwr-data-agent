import * as fsSync from 'fs';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  configureGraph,
  getInheritanceChain,
  findReferences,
  getTransformChain,
  readSource,
  listFiles,
  getScriptSymbols,
  getNode,
} from './tools.js';
import { createToolHost, loadToolPlugins, type PluginEntry } from './plugins.js';

let configured = false;

export function initGraphTools(): void {
  if (configured) return;
  configureGraph(config.dataDir, config.graphPath);
  configured = true;
}

export function buildBuiltinTools() {
  initGraphTools();

  return {
    getInheritanceChain: tool({
      description:
        'Trace the full inheritance chain of an entity (weapon, carry_item, etc.). ' +
        'Returns parent chain (what this entity inherits from via file= attribute) ' +
        'and children (what inherits from this entity). Use when the user asks about ' +
        'inheritance, base files, parent templates, or "inherits from".',
      inputSchema: z.object({
        key: z.string().describe('The entity key (e.g., "m4a1.weapon", "K309.carry_item")'),
      }),
      execute: async ({ key }) => getInheritanceChain(key),
    }),

    findReferences: tool({
      description:
        'Find all entities that reference a given entity (reverse lookup). ' +
        'Shows who points TO this entity via extends, fires, transforms_to, etc. ' +
        'Use to answer "who uses this projectile", "which weapons reference this base".',
      inputSchema: z.object({
        key: z.string().describe('The entity key to find references for'),
      }),
      execute: async ({ key }) => findReferences(key),
    }),

    getTransformChain: tool({
      description:
        'Trace the degradation/consumption chain of a carry item (e.g., armor layers). ' +
        'Items with transform_on_consume transform into another item when consumed. ' +
        'Use to answer "how many armor layers does X have" or trace armor degradation.',
      inputSchema: z.object({
        key: z.string().describe('The carry item key (e.g., "K309.carry_item")'),
      }),
      execute: async ({ key }) => getTransformChain(key),
    }),

    readSource: tool({
      description:
        'Read the raw source file content. Use to inspect exact XML attributes, ' +
        'verify data, or read AngelScript source code. ' +
        'Supports optional line range for large files.',
      inputSchema: z.object({
        file: z.string().describe('Relative file path (e.g., "weapons/m4a1.weapon")'),
        startLine: z.number().optional().describe('Start line (1-indexed)'),
        endLine: z.number().optional().describe('End line (1-indexed)'),
      }),
      execute: async ({ file, startLine, endLine }) =>
        readSource(file, startLine, endLine),
    }),

    listFiles: tool({
      description:
        'List indexed files matching a glob pattern. Use to find files by name ' +
        'when you do not know the exact key. Supports optional type filter. ' +
        'Patterns use * as wildcard (e.g., "*m4*", "*.weapon").',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern (e.g., "*m4*", "*.call")'),
        type: z
          .string()
          .optional()
          .describe('Filter by node type (weapon, carry_item, projectile, call, etc.)'),
      }),
      execute: async ({ pattern, type }) => listFiles(pattern, type, 30),
    }),

    getScriptSymbols: tool({
      description:
        'Get parsed AngelScript (.as) function/class/include signatures with line numbers. ' +
        'Use to answer questions about game scripts, custom game modes, hooks, or mod logic. ' +
        'Much better than reading the full script file for "what functions exist".',
      inputSchema: z.object({
        file: z.string().describe('Relative .as file path (e.g., "scripts/start_1.as")'),
      }),
      execute: async ({ file }) => getScriptSymbols(file),
    }),

    getNode: tool({
      description:
        'Look up a single entity by its key. Returns basic info (type, file path, mod). ' +
        'Use to resolve a key to its source file before calling readSource, ' +
        'or to verify an entity exists.',
      inputSchema: z.object({
        key: z.string().describe('The entity key to look up'),
      }),
      execute: async ({ key }) => getNode(key),
    }),

  };
}

// ---------------------------------------------------------------------------
// Tool registry: built-ins + runtime plugins
// ---------------------------------------------------------------------------

let registry: Record<string, Tool> | null = null;
let pluginEntries: PluginEntry[] = [];
let builtinNames: string[] = [];
let dirty = true;
let watching = false;
let reloadTimer: NodeJS.Timeout | null = null;

/** Mark the registry stale; the next getAgentTools() rebuilds it. */
export function invalidateToolRegistry(): void {
  dirty = true;
}

/**
 * Watch the plugin directory. Changes only flip the `dirty` flag — the actual reload
 * happens when the next request asks for tools, so an in-flight stream is never
 * swapped out from under itself.
 */
function watchPluginDir(): void {
  if (watching || !config.toolsHotReload) return;
  watching = true;
  try {
    fsSync.watch(config.toolsDir, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log('[plugin] Change detected — tools will reload on the next request');
        dirty = true;
      }, 300);
    });
  } catch {
    // Directory does not exist (or the platform refuses to watch it) — plugins stay static.
    watching = false;
  }
}

/** Built-in tools plus every successfully loaded plugin. Rebuilds when marked dirty. */
export async function getAgentTools(): Promise<Record<string, Tool>> {
  if (registry && !dirty) return registry;

  const builtin = buildBuiltinTools() as unknown as Record<string, Tool>;
  builtinNames = Object.keys(builtin);

  const { tools: plugins, entries } = await loadToolPlugins(createToolHost(), builtinNames);
  pluginEntries = entries;
  registry = { ...builtin, ...plugins };
  dirty = false;

  const ok = entries.filter((e) => !e.error);
  if (ok.length > 0 || entries.length > 0) {
    console.log(
      `[plugin] ${ok.length} plugin tool(s) loaded from ${config.toolsDir}` +
        (entries.length > ok.length ? ` (${entries.length - ok.length} failed)` : ''),
    );
  }

  watchPluginDir();
  return registry;
}

/** Snapshot for GET /v1/tools. Does not trigger a load. */
export function getToolInventory(): { builtin: string[]; plugins: PluginEntry[]; toolsDir: string; hotReload: boolean } {
  return {
    builtin: builtinNames,
    plugins: pluginEntries,
    toolsDir: config.toolsDir,
    hotReload: config.toolsHotReload,
  };
}
