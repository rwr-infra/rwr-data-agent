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
  /** Full-text search over the local index. */
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
  execute: (input: never) => unknown | Promise<unknown>;
}

export type PluginFactory = (host: ToolHost) => PluginToolSpec[] | Promise<PluginToolSpec[]>;

/** What `GET /v1/tools` reports for each discovered plugin file. */
export interface PluginEntry {
  name: string;
  file: string;
  description?: string;
  loadedAt: string;
  error?: string;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function createToolHost(): ToolHost {
  return {
    config: {
      dataDir: config.dataDir,
      outputDir: config.outputDir,
      graphPath: config.graphPath,
      searchIndexPath: config.searchIndexPath,
    },
    search,
    graph: {
      getInheritanceChain,
      findReferences,
      getTransformChain,
      readSource,
      listFiles,
      getScriptSymbols,
      getNode,
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
  if (typeof s.execute !== 'function') {
    throw new Error(`${file}: tool "${s.name}" needs an execute function`);
  }
  return s as PluginToolSpec;
}

function toTool(spec: PluginToolSpec, file: string): Tool {
  return dynamicTool({
    description: spec.description,
    inputSchema: jsonSchema(spec.inputSchema),
    // A throwing plugin must not kill the response stream — hand the model the error
    // so it can explain or route around it.
    execute: async (input) => {
      try {
        return await spec.execute(input as never);
      } catch (err) {
        const message = (err as Error).message;
        console.warn(`[plugin] ${file}: tool "${spec.name}" threw: ${message}`);
        return { error: message };
      }
    },
  });
}

export interface LoadedPlugins {
  tools: Record<string, Tool>;
  entries: PluginEntry[];
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
  const reserved = new Set(reservedNames);

  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => (f.endsWith('.js') || f.endsWith('.mjs')) && !f.startsWith('_') && !f.startsWith('.'))
      .sort();
  } catch {
    return { tools, entries }; // no plugin directory — plugins are optional
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
        tools[spec.name] = toTool(spec, file);
        entries.push({ name: spec.name, file, description: spec.description, loadedAt });
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugin] Failed to load ${file}: ${message}`);
      entries.push({ name: path.basename(file, path.extname(file)), file, loadedAt, error: message });
    }
  }

  return { tools, entries };
}
