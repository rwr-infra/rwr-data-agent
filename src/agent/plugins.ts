import { loadToolPlugins as loadPlugins, type LoadedPlugins } from '@rwr/agent-core';
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
 * The RWR side of runtime tool plugins.
 *
 * The loader itself — discovery, validation, per-file failure isolation, trigger normalization —
 * lives in `@rwr/agent-core`, which knows nothing about this game. What stays here is the one thing
 * that is entirely domain: the **host**, i.e. what a plugin is actually given to work with.
 *
 * ⚠️ Plugins run with the server's full privileges. See the trust-model note on the core loader;
 * `host` is a convenience, not a boundary.
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

// Re-exported so a caller (and `types/tool-plugin.d.ts`) has one import site for the plugin
// vocabulary, rather than having to know which half lives where.
export type { PluginToolSpec, PluginEntry, LoadedPlugins } from '@rwr/agent-core';

/** A plugin's default export, with the host already bound to this domain's shape. */
export type PluginFactory = (host: ToolHost) => unknown;

/**
 * `scope` is the package the request selected. Binding it **here** rather than asking plugin
 * authors to honour it is deliberate and load-bearing: a plugin written before package scoping
 * existed becomes scoped for free, and a careless one cannot leak another package's data into a
 * scoped answer. That is why the host stays a closure and scope is never a call argument — moving
 * it into per-call context would hand compliance to third-party authors.
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
      readSource: (file, startLine, endLine, mod) =>
        readSource(file, startLine, endLine, mod ?? scope),
      listFiles: (pattern, type, limit, mod) => listFiles(pattern, type, limit, mod ?? scope),
      getScriptSymbols: (file, mod) => getScriptSymbols(file, mod ?? scope),
      getNode: (key, mod) => getNode(key, mod ?? scope),
    },
    log: (message: string) => console.log(`[plugin] ${message}`),
  };
}

/**
 * Load every plugin under `TOOLS_DIR`.
 *
 * `reservedNames` are the built-in tools: a plugin may not shadow one, so an external file can
 * never hijack core behaviour.
 */
export function loadToolPlugins(
  host: ToolHost,
  reservedNames: Iterable<string>,
): Promise<LoadedPlugins> {
  return loadPlugins({ dir: config.toolsDir, host, reservedNames });
}
