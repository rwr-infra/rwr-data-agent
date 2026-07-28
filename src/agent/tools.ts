import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { search as indexSearch } from '../retrieval/localSearch.js';
import type { DocumentType, SearchFilters } from '../types/index.js';
import type { GraphNode, GraphEdge, EdgeRel, ScriptSymbol, RwrGraph } from './types.js';

let graphCache: RwrGraph | null = null;
let symbolsCache: ScriptSymbol[] | null = null;
let graphPath = '';
let symbolsPath = '';
let dataRoot = '';

export function configureGraph(dataDir: string, gPath?: string): void {
  dataRoot = path.resolve(dataDir);
  graphPath = gPath ?? path.join(dataRoot, 'graph.json');
  symbolsPath = path.join(path.dirname(graphPath), 'script-symbols.json');
  graphCache = null;
  symbolsCache = null;
}

async function loadGraph(): Promise<RwrGraph> {
  if (graphCache) return graphCache;
  try {
    const raw = await fs.readFile(graphPath, 'utf-8');
    graphCache = JSON.parse(raw) as RwrGraph;
  } catch {
    throw new Error(`Graph index not found at ${graphPath}. Run "npm run build:index" first.`);
  }
  return graphCache;
}

async function loadSymbols(): Promise<ScriptSymbol[]> {
  if (symbolsCache) return symbolsCache;
  try {
    const raw = await fs.readFile(symbolsPath, 'utf-8');
    symbolsCache = JSON.parse(raw) as ScriptSymbol[];
  } catch {
    symbolsCache = [];
  }
  return symbolsCache;
}

function findNode(graph: RwrGraph, key: string): GraphNode | undefined {
  const lower = key.toLowerCase();
  return graph.nodes.find((n) => n.key.toLowerCase() === lower);
}

function edgesFrom(graph: RwrGraph, key: string, rel?: EdgeRel): GraphEdge[] {
  const lower = key.toLowerCase();
  return graph.edges.filter((e) => e.from.toLowerCase() === lower && (!rel || e.rel === rel));
}

function edgesTo(graph: RwrGraph, key: string, rel?: EdgeRel): GraphEdge[] {
  const lower = key.toLowerCase();
  return graph.edges.filter((e) => e.to.toLowerCase() === lower && (!rel || e.rel === rel));
}

// ---------------------------------------------------------------------------
// Tool 1: get_inheritance_chain
// ---------------------------------------------------------------------------
export interface InheritanceResult {
  key: string;
  type: string;
  file: string;
  name?: string;
  parents: { key: string; type: string; file: string; name?: string }[];
  children: { key: string; type: string; file: string; name?: string }[];
  fullChain: { key: string; type: string; file: string; depth: number }[];
}

export async function getInheritanceChain(key: string): Promise<InheritanceResult> {
  const graph = await loadGraph();
  const node = findNode(graph, key);
  if (!node) throw new Error(`Node not found: ${key}`);

  const directParents = edgesFrom(graph, node.key, 'extends').map((e) => findNode(graph, e.to)).filter(Boolean) as GraphNode[];
  const directChildren = edgesTo(graph, node.key, 'extends').map((e) => findNode(graph, e.from)).filter(Boolean) as GraphNode[];

  const fullChain: { key: string; type: string; file: string; depth: number }[] = [];
  const visited = new Set<string>();
  function walkUp(k: string, depth: number) {
    if (visited.has(k.toLowerCase()) || depth > 15) return;
    visited.add(k.toLowerCase());
    const n = findNode(graph, k);
    if (n) fullChain.push({ key: n.key, type: n.type, file: n.file, depth });
    for (const e of edgesFrom(graph, k, 'extends')) {
      walkUp(e.to, depth + 1);
    }
  }
  walkUp(node.key, 0);

  return {
    key: node.key,
    type: node.type,
    file: node.file,
    name: node.name,
    parents: directParents.map((p) => ({ key: p.key, type: p.type, file: p.file, name: p.name })),
    children: directChildren.map((c) => ({ key: c.key, type: c.type, file: c.file, name: c.name })),
    fullChain,
  };
}

// ---------------------------------------------------------------------------
// Tool 2: find_references
// ---------------------------------------------------------------------------
export interface ReferenceResult {
  key: string;
  type: string;
  file: string;
  referencedByCount: number;
  referencesCount: number;
  referencedBy: { key: string; type: string; file: string; rel: EdgeRel }[];
  references: { key: string; type: string; file: string; rel: EdgeRel }[];
}

export async function findReferences(key: string): Promise<ReferenceResult> {
  const graph = await loadGraph();
  const node = findNode(graph, key);
  const nodeInfo = node ?? { key, type: 'unknown', file: '' };

  const allReferencedBy = edgesTo(graph, key).map((e) => {
    const n = findNode(graph, e.from);
    return { key: e.from, type: n?.type ?? 'unknown', file: n?.file ?? '', rel: e.rel };
  });
  const referencedBy = allReferencedBy.slice(0, 15);
  if (allReferencedBy.length > 15) {
    (referencedBy as unknown as { _truncated?: string })._truncated = `${allReferencedBy.length - 15} more omitted`;
  }

  const allReferences = edgesFrom(graph, key).map((e) => {
    const n = findNode(graph, e.to);
    return { key: e.to, type: n?.type ?? 'unknown', file: n?.file ?? '', rel: e.rel };
  });
  const references = allReferences.slice(0, 15);

  return {
    key: nodeInfo.key,
    type: nodeInfo.type,
    file: nodeInfo.file,
    referencedByCount: allReferencedBy.length,
    referencesCount: allReferences.length,
    referencedBy,
    references,
  };
}

// ---------------------------------------------------------------------------
// Tool 3: get_transform_chain (armor degradation layers)
// ---------------------------------------------------------------------------
export interface TransformChainResult {
  key: string;
  chain: { key: string; file: string; depth: number }[];
}

export async function getTransformChain(key: string): Promise<TransformChainResult> {
  const graph = await loadGraph();
  const chain: { key: string; file: string; depth: number }[] = [];
  const visited = new Set<string>();
  let current = key;
  let depth = 0;
  while (current && !visited.has(current.toLowerCase()) && depth < 50) {
    visited.add(current.toLowerCase());
    const node = findNode(graph, current);
    chain.push({ key: current, file: node?.file ?? '', depth });
    const next = edgesFrom(graph, current, 'transforms_to')[0];
    if (!next) break;
    current = next.to;
    depth++;
  }
  return { key, chain };
}

// ---------------------------------------------------------------------------
// Tool 4: read_source
// ---------------------------------------------------------------------------
export interface ReadSourceResult {
  file: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}

export async function readSource(relFile: string, startLine?: number, endLine?: number): Promise<ReadSourceResult> {
  const absPath = path.resolve(dataRoot, relFile);
  if (!absPath.startsWith(dataRoot + path.sep)) throw new Error('Path traversal blocked');

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch {
    throw new Error(`File not found: ${relFile}`);
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(totalLines, endLine ?? totalLines);
  const slice = lines.slice(start - 1, end).join('\n');
  const maxChars = 4000;
  const truncated = slice.length > maxChars;

  return {
    file: relFile,
    totalLines,
    startLine: start,
    endLine: end,
    content: truncated ? slice.slice(0, maxChars) + '\n... [truncated]' : slice,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Tool 5: list_files
// ---------------------------------------------------------------------------
export interface ListFilesResult {
  pattern: string;
  type?: string;
  total: number;
  files: { file: string; type: string; key: string; name?: string }[];
}

export async function listFiles(pattern: string, type?: string, limit = 15): Promise<ListFilesResult> {
  const graph = await loadGraph();
  const regex = new RegExp(pattern.split('*').map(escapeRegex).join('.*'), 'i');
  let matched = graph.nodes.filter((n) => regex.test(n.file) || regex.test(n.key));
  if (type) matched = matched.filter((n) => n.type === type);

  return {
    pattern,
    type,
    total: matched.length,
    files: matched.slice(0, limit).map((n) => ({ file: n.file, type: n.type, key: n.key, name: n.name })),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Tool 6: get_script_symbols
// ---------------------------------------------------------------------------
export interface ScriptSymbolsResult {
  file: string;
  total: number;
  symbols: ScriptSymbol[];
}

export async function getScriptSymbols(file: string): Promise<ScriptSymbolsResult> {
  const symbols = await loadSymbols();
  const fileBase = path.basename(file);
  const matched = symbols.filter((s) => s.file === fileBase || s.file === file);

  if (matched.length === 0) {
    const absPath = path.resolve(dataRoot, file);
    if (!absPath.startsWith(dataRoot + path.sep)) throw new Error('Path traversal blocked');
    if (fsSync.existsSync(absPath)) {
      const { extractScriptSymbolsFromFile } = await import('./graphBuilder.js');
      const fresh = await extractScriptSymbolsFromFile(absPath);
      return { file, total: fresh.length, symbols: fresh };
    }
  }

  return { file, total: matched.length, symbols: matched };
}

// ---------------------------------------------------------------------------
// Tool 7: get_node (basic lookup)
// ---------------------------------------------------------------------------
export async function getNode(key: string): Promise<GraphNode | null> {
  const graph = await loadGraph();
  return findNode(graph, key) ?? null;
}

// ---------------------------------------------------------------------------
// Tool 8: search_docs — full-text retrieval, the same index the RAG context comes from
// ---------------------------------------------------------------------------
export interface SearchDocsResult {
  query: string;
  total: number;
  results: { key: string; type: string; file: string; mod?: string; snippet: string }[];
}

/**
 * Re-run retrieval with a model-chosen query. The pre-fetched RAG context is a single
 * shot at one phrasing; this lets the agent retry with an alias, a Key fragment, or a
 * translated term before it can honestly claim an entity is absent.
 *
 * Snippet is 500 chars because `structuredDocToRWRDocument` puts the tag line, Key and
 * the "Localized Names" section in the first two blocks — that prefix is what a name
 * match has to be judged on.
 */
export async function searchDocs(query: string, type?: string, limit = 10): Promise<SearchDocsResult> {
  const SNIPPET_CHARS = 500;
  const capped = Math.min(Math.max(limit, 1), 30);
  const filters: SearchFilters = type ? { type: type as DocumentType } : {};
  const hits = await indexSearch(query, filters, capped);

  return {
    query,
    total: hits.length,
    results: hits.map((r) => ({
      key: r.key,
      type: r.type,
      file: r.metadata.file_path ?? '',
      mod: r.metadata.mod_name,
      snippet: r.content.length > SNIPPET_CHARS ? r.content.slice(0, SNIPPET_CHARS) + '…' : r.content,
    })),
  };
}
