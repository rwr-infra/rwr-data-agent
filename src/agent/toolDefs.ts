import * as fsSync from 'fs';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { createReloadGate } from '@rwr/agent-core';
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
  searchDocs,
} from './tools.js';
import { createToolHost, loadToolPlugins, type PluginEntry } from './plugins.js';
import { instrumentTools } from './toolRuntime.js';
import type { ToolDisclosureMeta } from './toolSelection.js';

let configured = false;

export function initGraphTools(): void {
  if (configured) return;
  configureGraph(config.dataDir, config.graphPath);
  configured = true;
}

/**
 * `scope` is the package the request selected (`body.mod`). It is applied inside every tool
 * rather than exposed as a model-settable argument — the model must not be able to widen it,
 * and a tool that can only see one package cannot drift into another mid-answer.
 */
export function buildBuiltinTools(scope?: string) {
  initGraphTools();

  const scoped = (description: string): string =>
    scope
      ? `${description}\n\nSCOPE: restricted to package "${scope}" (the user's selection). ` +
        `Other packages are excluded and there is no argument that widens this — do not try.`
      : description;

  return {
    searchDocs: tool({
      description: scoped(
        'Full-text search over the game data index (the same index the pre-fetched context ' +
          'came from). Matches Keys, English/Chinese localized names, and document content. ' +
          'USE THIS FIRST whenever the pre-fetched context does not contain the item the user ' +
          'asked about — retry with the bare item name, a Key fragment, an alias, or the ' +
          'English/Chinese equivalent. Never tell the user an item does not exist without ' +
          'having searched for it here.',
      ),
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Search terms, e.g. "ak47", "AK-47 突击步枪", "gkw_ak". Short and specific beats a full sentence.',
          ),
        type: z
          .string()
          .optional()
          .describe(
            'Optional node type filter (weapon, carry_item, projectile, call, character, script_chunk, …)',
          ),
        limit: z.number().optional().describe('Max results, 1-30 (default 10)'),
      }),
      execute: async ({ query, type, limit }) => searchDocs(query, type, limit ?? 10, scope),
    }),

    getInheritanceChain: tool({
      description: scoped(
        'Trace the full inheritance chain of an entity (weapon, carry_item, etc.). ' +
          'Returns parent chain (what this entity inherits from via file= attribute) ' +
          'and children (what inherits from this entity). Use when the user asks about ' +
          'inheritance, base files, parent templates, or "inherits from". Each layer reports ' +
          'its own `mod`: a parent may physically live in another package, and that is where ' +
          'the inherited value comes from — cite the package when it differs.',
      ),
      inputSchema: z.object({
        key: z.string().describe('The entity key (e.g., "m4a1.weapon", "K309.carry_item")'),
      }),
      execute: async ({ key }) => getInheritanceChain(key, scope),
    }),

    findReferences: tool({
      description: scoped(
        'Find all entities that reference a given entity (reverse lookup). ' +
          'Shows who points TO this entity via extends, fires, transforms_to, etc. ' +
          'Use to answer "who uses this projectile", "which weapons reference this base".',
      ),
      inputSchema: z.object({
        key: z.string().describe('The entity key to find references for'),
      }),
      execute: async ({ key }) => findReferences(key, scope),
    }),

    getTransformChain: tool({
      description: scoped(
        'Trace the degradation/consumption chain of a carry item (e.g., armor layers). ' +
          'Items with transform_on_consume transform into another item when consumed. ' +
          'Use to answer "how many armor layers does X have" or trace armor degradation.',
      ),
      inputSchema: z.object({
        key: z.string().describe('The carry item key (e.g., "K309.carry_item")'),
      }),
      execute: async ({ key }) => getTransformChain(key, scope),
    }),

    readSource: tool({
      description: scoped(
        'Read the raw source file content. Use to inspect exact XML attributes, ' +
          'verify data, or read AngelScript source code. ' +
          'Supports optional line range for large files. The result reports the owning `mod`, ' +
          'and flags `outOfScope` when the file belongs to another package.',
      ),
      inputSchema: z.object({
        file: z.string().describe('Relative file path (e.g., "weapons/m4a1.weapon")'),
        startLine: z.number().optional().describe('Start line (1-indexed)'),
        endLine: z.number().optional().describe('End line (1-indexed)'),
      }),
      execute: async ({ file, startLine, endLine }) => readSource(file, startLine, endLine, scope),
    }),

    listFiles: tool({
      description: scoped(
        'List indexed files matching a glob pattern. Use to find files by name ' +
          'when you do not know the exact key. Supports optional type filter. ' +
          'Patterns use * as wildcard (e.g., "*m4*", "*.weapon").',
      ),
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern (e.g., "*m4*", "*.call")'),
        type: z
          .string()
          .optional()
          .describe('Filter by node type (weapon, carry_item, projectile, call, etc.)'),
      }),
      execute: async ({ pattern, type }) => listFiles(pattern, type, 30, scope),
    }),

    getScriptSymbols: tool({
      description: scoped(
        'Get parsed AngelScript (.as) function/class/include signatures with line numbers. ' +
          'Use to answer questions about game scripts, custom game modes, hooks, or mod logic. ' +
          'Much better than reading the full script file for "what functions exist".',
      ),
      inputSchema: z.object({
        file: z.string().describe('Relative .as file path (e.g., "scripts/start_1.as")'),
      }),
      execute: async ({ file }) => getScriptSymbols(file, scope),
    }),

    getNode: tool({
      description: scoped(
        'Look up a single entity by its key. Returns basic info (type, file path, mod). ' +
          'Use to resolve a key to its source file before calling readSource, ' +
          'or to verify an entity exists.',
      ),
      inputSchema: z.object({
        key: z.string().describe('The entity key to look up'),
      }),
      execute: async ({ key }) => getNode(key, scope),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tool registry: built-ins + runtime plugins
// ---------------------------------------------------------------------------

/**
 * One registry per package scope, keyed by scope name (`''` = unscoped). Cached rather than
 * rebuilt per request because `measureToolDefTokens` keys its cache on the registry object's
 * identity — a fresh object every request would re-measure every tool definition each time.
 */
const registries = new Map<string, Record<string, Tool>>();
/**
 * Per-scope disclosure metadata, cached alongside `registries` and invalidated by the same
 * generation counter so a hot-reload cannot leave it stale. Populated only when a scope's
 * registry is actually built; `getToolDisclosureMeta` returns `undefined` for scopes
 * nobody requested yet, which simply disables disclosure for them.
 */
const disclosureMeta = new Map<string, ToolDisclosureMeta>();
let pluginEntries: PluginEntry[] = [];
let builtinNames: string[] = [];

/**
 * Staleness lives in the gate, not in a `dirty` boolean here — see `createReloadGate` for why a
 * boolean loses a race that two concurrent requests can reach.
 */
const reload = createReloadGate();
let watching = false;
let reloadTimer: NodeJS.Timeout | null = null;

/** Mark the registry stale; the next getAgentTools() rebuilds it. */
export function invalidateToolRegistry(): void {
  reload.invalidate();
}

/**
 * Watch the plugin directory. Changes only bump the generation counter — the actual reload
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
        reload.invalidate();
      }, 300);
    });
  } catch {
    // Directory does not exist (or the platform refuses to watch it) — plugins stay static.
    watching = false;
  }
}

/**
 * Built-in tools plus every successfully loaded plugin. Rebuilds when the generation has moved past
 * what the cache holds.
 *
 * `scope` is the request's selected package: the returned tools — plugins included, through the
 * host — only ever see that package.
 */
export async function getAgentTools(scope?: string): Promise<Record<string, Tool>> {
  const stale = reload.isStale();
  if (stale) {
    registries.clear();
    disclosureMeta.clear();
  }
  const cacheKey = scope ?? '';
  const cached = registries.get(cacheKey);
  if (cached && !stale) return cached;

  // Captured before the await, and checked after: the watcher can fire while `loadToolPlugins` is
  // reading the directory, and what comes back then describes a directory that no longer exists.
  const loadingGeneration = reload.begin();
  const builtin = buildBuiltinTools(scope) as unknown as Record<string, Tool>;
  builtinNames = Object.keys(builtin);

  const {
    tools: plugins,
    entries,
    triggers,
  } = await loadToolPlugins(createToolHost(scope), builtinNames);
  // One envelope over built-ins and plugins alike: duplicate guard, deadline, `{error, hint}` on
  // failure. Wrapped here rather than per request so the token-accounting cache keeps its key.
  const registry = instrumentTools({ ...builtin, ...plugins });

  if (!reload.publish(loadingGeneration)) {
    // The directory changed while we were reading it. Serve what we have — this request has to
    // answer with *something*, and a set of tools one edit out of date beats an error — but publish
    // nothing, so the next request reloads instead of inheriting it. Caching it here is the actual
    // bug: it would pin the stale registry with the gate agreeing that it is current.
    console.log('[plugin] Directory changed mid-load — this request keeps the pre-change tools');
    return registry;
  }
  pluginEntries = entries;
  registries.set(cacheKey, registry);
  disclosureMeta.set(cacheKey, {
    coreNames: builtinNames,
    allNames: Object.keys(registry),
    pluginTriggers: triggers,
  });

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
export function getToolInventory(): {
  builtin: string[];
  plugins: PluginEntry[];
  toolsDir: string;
  hotReload: boolean;
} {
  return {
    builtin: builtinNames,
    plugins: pluginEntries,
    toolsDir: config.toolsDir,
    hotReload: config.toolsHotReload,
  };
}

/**
 * Disclosure metadata for a package scope, or `undefined` when that scope's registry has not
 * been built (or registry building failed) — the caller then leaves disclosure off, which is
 * the safe default. Read-only; the caller is expected to have awaited `getAgentTools(scope)`
 * for the same request first, so the entry is never stale within a turn.
 */
export function getToolDisclosureMeta(scope?: string): ToolDisclosureMeta | undefined {
  return disclosureMeta.get(scope ?? '');
}
