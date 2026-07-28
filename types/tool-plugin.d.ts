/**
 * Type surface for agent tool plugins.
 *
 * A plugin is a plain ESM `.js` file in `TOOLS_DIR` (default `./tools.d`) whose default
 * export is a factory. It must be `.js`, not `.ts` — production runs `node dist/…` with
 * no transpiler in the loader chain.
 *
 * ```js
 * /** @type {import('../types/tool-plugin.js').PluginFactory} *\/
 * export default function register(host) {
 *   return [{
 *     name: 'myTool',
 *     description: 'What the model should use this for.',
 *     inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
 *     async execute({ q }) { return host.search(q); },
 *   }];
 * }
 * ```
 *
 * ⚠️ Plugins run in the server process with full privileges. Only load files you wrote
 * or reviewed.
 */

export interface ToolHostConfig {
  dataDir: string;
  outputDir: string;
  graphPath: string;
  searchIndexPath: string;
}

export interface SearchFilters {
  type?: string;
  faction?: string;
  mod_name?: string;
  weapon_class?: string;
}

export interface SearchResult {
  doc_id: string;
  type: string;
  key: string;
  content: string;
  metadata: Record<string, unknown>;
  distance: number;
  score?: number;
  source?: string;
}

export interface ToolHostGraph {
  getInheritanceChain(key: string): Promise<unknown>;
  findReferences(key: string): Promise<unknown>;
  getTransformChain(key: string): Promise<unknown>;
  readSource(file: string, startLine?: number, endLine?: number): Promise<unknown>;
  listFiles(pattern: string, type?: string, limit?: number): Promise<unknown>;
  getScriptSymbols(file: string): Promise<unknown>;
  getNode(key: string): Promise<unknown>;
}

export interface ToolHost {
  config: ToolHostConfig;
  search(query: string, filters?: SearchFilters, topK?: number, searchQuery?: string, offset?: number): Promise<SearchResult[]>;
  graph: ToolHostGraph;
  log(message: string): void;
}

export interface PluginToolSpec {
  /** Name the model sees. `[A-Za-z_][A-Za-z0-9_]{0,63}`; may not shadow a built-in tool. */
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  inputSchema: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(input: any): unknown | Promise<unknown>;
}

export type PluginFactory = (host: ToolHost) => PluginToolSpec[] | Promise<PluginToolSpec[]>;
