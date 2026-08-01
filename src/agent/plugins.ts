import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { dynamicTool, jsonSchema, type Tool } from 'ai';
import { config } from '../config/index.js';
import { search } from '../retrieval/localSearch.js';
import {
  getInheritanceChain,
  findReferences,
  getTransformChain,
  readSource,
  listFiles,
  getScriptSymbols,
  getNode,
} from './tools.js';

/**
 * Runtime tool plugins.
 *
 * ⚠️ Plugins are imported into this process and therefore run with the server's full
 * privileges — filesystem, network, `process.env`. This is an operator-drops-a-file
 * trust model. Do NOT expose the plugin directory to untrusted uploads; that would
 * require `worker_threads` isolation, which this loader deliberately does not do.
 */

/** Capabilities handed to a plugin so it never has to reach into internal modules. */
export interface ToolHost {
  config: {
    dataDir: string;
    outputDir: string;
    graphPath: string;
    searchIndexPath: string;
  };
  /**
   * Package the request selected, or undefined when unscoped. `search` and `graph` are already
   * bound to it — a plugin only needs this to word its own output, or to skip work when the
   * selected package is not the one it covers.
   */
  scope?: string;
  /** Full-text search over the local index. Filtered to `scope` unless the caller overrides
   *  `mod_name` explicitly. */
  search: typeof search;
  /** The same graph primitives the built-in tools are built from. */
  graph: {
    getInheritanceChain: typeof getInheritanceChain;
    findReferences: typeof findReferences;
    getTransformChain: typeof getTransformChain;
    readSource: typeof readSource;
    listFiles: typeof listFiles;
    getScriptSymbols: typeof getScriptSymbols;
    getNode: typeof getNode;
  };
  log: (message: string) => void;
}

export interface PluginToolSpec {
  /** Tool name exposed to the model. Must be a valid identifier. */
  name: string;
  description: string;
  /** JSON Schema for the tool input — no zod dependency in plugin files. */
  inputSchema: Record<string, unknown>;
  /**
   * Optional relevance keywords (case-insensitive substring match against the user's query).
   * When progressive tool disclosure is active (tool count above `toolDisclosureThreshold`),
   * the first agent step only exposes this tool if one of these hit. Declaring `triggers` is
   * an author opt-in to being hidden; tools without it are always visible.
   */
  triggers?: string[];
  /** May return a promise; `unknown` already covers that. */
  execute: (input: never) => unknown;
}

export type PluginFactory = (host: ToolHost) => PluginToolSpec[] | Promise<PluginToolSpec[]>;

/** What `GET /v1/tools` reports for each discovered plugin file. */
export interface PluginEntry {
  name: string;
  file: string;
  description?: string;
  /** As declared by the author (not normalized) — what /v1/tools shows should be debuggable. */
  triggers?: string[];
  loadedAt: string;
  error?: string;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * `scope` is the package the request selected. Binding it here rather than asking plugin
 * authors to honour it means a plugin written before package scoping existed becomes scoped
 * for free — and a careless one cannot leak another package's data into a scoped answer.
 */
export function createToolHost(scope?: string): ToolHost {
  return {
    config: {
      dataDir: config.dataDir,
      outputDir: config.outputDir,
      graphPath: config.graphPath,
      searchIndexPath: config.searchIndexPath,
    },
    scope,
    search: (query, filters = {}, topK, searchQuery, offset) => {
      const scopedFilters = { ...filters };
      if (scope && scopedFilters.mod_name === undefined) scopedFilters.mod_name = scope;
      return search(query, scopedFilters, topK, searchQuery, offset);
    },
    graph: {
      getInheritanceChain: (key, mod) => getInheritanceChain(key, mod ?? scope),
      findReferences: (key, mod) => findReferences(key, mod ?? scope),
      getTransformChain: (key, mod) => getTransformChain(key, mod ?? scope),
      readSource: (file, startLine, endLine, mod) => readSource(file, startLine, endLine, mod ?? scope),
      listFiles: (pattern, type, limit, mod) => listFiles(pattern, type, limit, mod ?? scope),
      getScriptSymbols: (file, mod) => getScriptSymbols(file, mod ?? scope),
      getNode: (key, mod) => getNode(key, mod ?? scope),
    },
    log: (message: string) => console.log(`[plugin] ${message}`),
  };
}

function validateSpec(spec: unknown, file: string): PluginToolSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error(`${file}: tool spec must be an object`);
  }
  const s = spec as Partial<PluginToolSpec>;
  if (typeof s.name !== 'string' || !TOOL_NAME.test(s.name)) {
    throw new Error(`${file}: invalid tool name ${JSON.stringify(s.name)}`);
  }
  if (typeof s.description !== 'string' || !s.description.trim()) {
    throw new Error(`${file}: tool "${s.name}" needs a non-empty description`);
  }
  if (typeof s.inputSchema !== 'object' || s.inputSchema === null) {
    throw new Error(`${file}: tool "${s.name}" needs a JSON Schema inputSchema`);
  }
  if (s.triggers !== undefined) {
    if (
      !Array.isArray(s.triggers) ||
      s.triggers.length === 0 ||
      !s.triggers.every((t) => typeof t === 'string' && t.trim().length > 0)
    ) {
      throw new Error(
        `${file}: tool "${s.name}" needs triggers as a non-empty array of non-empty strings ` +
          `(omit the field to keep the tool always visible)`,
      );
    }
  }
  if (typeof s.execute !== 'function') {
    throw new Error(`${file}: tool "${s.name}" needs an execute function`);
  }
  return s as PluginToolSpec;
}

function toTool(spec: PluginToolSpec): Tool {
  return dynamicTool({
    description: spec.description,
    inputSchema: jsonSchema(spec.inputSchema),
    // No try/catch here: `instrumentTools` (agent/toolRuntime.ts) wraps every registered tool with
    // the deadline and the `{error, hint}` envelope. Catching here would look like success to it and
    // the plugin's error would lose its recovery hint.
    execute: (input) => spec.execute(input as never),
  });
}

export interface LoadedPlugins {
  tools: Record<string, Tool>;
  entries: PluginEntry[];
  /** Tool name → normalized triggers (trimmed, lowercased), for tools that declared them. */
  triggers: Map<string, string[]>;
}

/**
 * Load every plugin under `config.toolsDir`.
 *
 * `reservedNames` are the built-in tools: a plugin may not shadow one, so an external
 * file can never hijack core behaviour.
 */
export async function loadToolPlugins(host: ToolHost, reservedNames: Iterable<string>): Promise<LoadedPlugins> {
  const dir = config.toolsDir;
  const tools: Record<string, Tool> = {};
  const entries: PluginEntry[] = [];
  const triggers = new Map<string, string[]>();
  const reserved = new Set(reservedNames);

  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => (f.endsWith('.js') || f.endsWith('.mjs')) && !f.startsWith('_') && !f.startsWith('.'))
      .sort();
  } catch {
    return { tools, entries, triggers }; // no plugin directory — plugins are optional
  }

  for (const file of files) {
    const abs = path.join(dir, file);
    const loadedAt = new Date().toISOString();
    try {
      const { mtimeMs } = await fs.stat(abs);
      // ESM module cache cannot be purged, so a changing query string is what makes
      // hot reload possible. Each reload leaks the previous module — acceptable
      // because hot reload is a development-only setting.
      const mod = (await import(`${pathToFileURL(abs).href}?v=${mtimeMs}`)) as { default?: unknown };

      if (typeof mod.default !== 'function') {
        throw new Error('default export must be a function (host) => tool specs');
      }
      const produced = await (mod.default as PluginFactory)(host);
      const specs = Array.isArray(produced) ? produced : [produced];

      for (const raw of specs) {
        const spec = validateSpec(raw, file);
        if (reserved.has(spec.name)) {
          entries.push({
            name: spec.name,
            file,
            loadedAt,
            error: `name collides with a built-in tool — plugin definition ignored`,
          });
          continue;
        }
        if (tools[spec.name]) {
          entries.push({ name: spec.name, file, loadedAt, error: 'duplicate tool name — ignored' });
          continue;
        }
        tools[spec.name] = toTool(spec);
        const entry: PluginEntry = { name: spec.name, file, description: spec.description, loadedAt };
        if (spec.triggers) {
          entry.triggers = spec.triggers;
          // Normalized once here so the disclosure matcher stays a plain substring check.
          triggers.set(spec.name, spec.triggers.map((t) => t.trim().toLowerCase()));
        }
        entries.push(entry);
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugin] Failed to load ${file}: ${message}`);
      entries.push({ name: path.basename(file, path.extname(file)), file, loadedAt, error: message });
    }
  }

  return { tools, entries, triggers };
}
