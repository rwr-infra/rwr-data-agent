import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { search as indexSearch } from '../retrieval/localSearch.js';
import type { DocumentType, SearchFilters } from '../types/index.js';
import type { GraphNode, GraphEdge, EdgeRel, ScriptSymbol, RwrGraph } from './types.js';

let graphCache: RwrGraph | null = null;
let symbolsCache: ScriptSymbol[] | null = null;
let fileModCache: Map<string, string> | null = null;
let graphPath = '';
let symbolsPath = '';
let dataRoot = '';

export function configureGraph(dataDir: string, gPath?: string): void {
  dataRoot = path.resolve(dataDir);
  graphPath = gPath ?? path.join(dataRoot, 'graph.json');
  symbolsPath = path.join(path.dirname(graphPath), 'script-symbols.json');
  graphCache = null;
  symbolsCache = null;
  fileModCache = null;
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

// ---------------------------------------------------------------------------
// Package scoping
//
// Every tool takes an optional `mod`. When the request selected a package, the whole graph
// traversal is confined to it: 1300+ keys are defined in more than one package, so an
// unscoped lookup silently answers from whichever package happens to come first in the node
// array. Omitting `mod` keeps the original global behaviour (CLI, validate, eval).
// ---------------------------------------------------------------------------

/** An edge belongs to the scope when its referring file does. Graphs older than version 3 carry
 *  no `mod`, so they stay unfiltered rather than returning nothing. */
function edgeInScope(e: GraphEdge, mod?: string): boolean {
  return !mod || e.mod === undefined || e.mod === mod;
}

function findNode(graph: RwrGraph, key: string, mod?: string): GraphNode | undefined {
  const lower = key.toLowerCase();
  if (mod) return graph.nodes.find((n) => n.key.toLowerCase() === lower && n.mod === mod);
  return graph.nodes.find((n) => n.key.toLowerCase() === lower);
}

/**
 * Resolve a key that a scoped traversal walked *into*. Inheritance legitimately crosses into
 * another package (a mod extending a vanilla base), so the target is looked up in scope first
 * and globally second — the caller reports the resolved node's own `mod`.
 */
function findNodeAcross(graph: RwrGraph, key: string, mod?: string): GraphNode | undefined {
  return findNode(graph, key, mod) ?? (mod ? findNode(graph, key) : undefined);
}

export interface EdgeTargetResolution {
  node?: GraphNode;
  /** Packages defining the target key, when the edge cannot be pinned to one of them. */
  ambiguousIn?: string[];
}

/**
 * The node an edge points at.
 *
 * `toMod` records where the `file=` reference actually resolved at build time, so it beats both
 * the scope and a bare-key lookup — several packages define `base_valuable.carry_item` and only
 * one of them is the layer this edge meant. When the reference never resolved to a file and the
 * key is defined in more than one package, the ambiguity is reported rather than guessed:
 * picking the first match is exactly how an answer ends up quoting the wrong package.
 */
function resolveEdgeTarget(graph: RwrGraph, edge: GraphEdge, mod?: string): EdgeTargetResolution {
  const pinned = edge.toMod ? findNode(graph, edge.to, edge.toMod) : undefined;
  if (pinned) return { node: pinned };

  const scoped = findNode(graph, edge.to, mod);
  if (scoped) return { node: scoped };

  const lower = edge.to.toLowerCase();
  const candidates = graph.nodes.filter((n) => n.key.toLowerCase() === lower);
  if (candidates.length === 1) return { node: candidates[0] };
  if (candidates.length === 0) return {};
  return { ambiguousIn: [...new Set(candidates.map((n) => n.mod))] };
}

/** An edge target that could not be pinned to a package, rendered as a chain/reference entry. */
function ambiguousEntry(key: string, packages: string[]) {
  return {
    key,
    type: 'unresolved',
    file: '',
    ambiguousIn: packages,
    note:
      `The reference does not resolve to a file, and "${key}" is defined in ${packages.join(', ')}. ` +
      `Which one applies is undetermined — say so instead of picking one.`,
  };
}

/** Packages other than `exclude` that define this key — what a scoped miss withheld. */
function otherPackagesWithKey(graph: RwrGraph, key: string, exclude?: string): string[] {
  const lower = key.toLowerCase();
  return [
    ...new Set(
      graph.nodes
        .filter((n) => n.key.toLowerCase() === lower && n.mod !== exclude)
        .map((n) => n.mod),
    ),
  ];
}

/** Error for a key that exists, but not in the package the request is scoped to. */
function outOfScopeError(graph: RwrGraph, key: string, mod: string): Error {
  const elsewhere = otherPackagesWithKey(graph, key, mod);
  return new Error(
    elsewhere.length > 0
      ? `Node not found in package "${mod}": ${key} (it is defined in ${elsewhere.join(', ')} — ` +
          `outside the package the user selected. Do not answer from there; tell the user it exists ` +
          `in another package and ask whether to switch.)`
      : `Node not found in package "${mod}": ${key}`,
  );
}

function edgesFrom(graph: RwrGraph, key: string, rel?: EdgeRel, mod?: string): GraphEdge[] {
  const lower = key.toLowerCase();
  return graph.edges.filter(
    (e) => e.from.toLowerCase() === lower && (!rel || e.rel === rel) && edgeInScope(e, mod),
  );
}

function edgesTo(graph: RwrGraph, key: string, rel?: EdgeRel, mod?: string): GraphEdge[] {
  const lower = key.toLowerCase();
  return graph.edges.filter(
    (e) => e.to.toLowerCase() === lower && (!rel || e.rel === rel) && edgeInScope(e, mod),
  );
}

// ---------------------------------------------------------------------------
// Tool 1: get_inheritance_chain
// ---------------------------------------------------------------------------
/** One layer of a chain: a resolved node, or an unresolvable reference with its candidates. */
export interface ChainEntry {
  key: string;
  type: string;
  file: string;
  name?: string;
  mod?: string;
  ambiguousIn?: string[];
  note?: string;
}

export interface InheritanceResult {
  key: string;
  type: string;
  file: string;
  name?: string;
  mod?: string;
  scope?: string;
  parents: ChainEntry[];
  children: ChainEntry[];
  fullChain: (ChainEntry & { depth: number })[];
}

/**
 * `mod` anchors the entity in one package. The chain may still leave it — a mod weapon whose
 * `file=` parent lives in vanilla — because that parent is where the effective attribute value
 * comes from, so cutting it would produce a wrong answer rather than a scoped one. Each layer
 * therefore carries its own `mod` and the walk follows the resolved layer's package.
 */
export async function getInheritanceChain(key: string, mod?: string): Promise<InheritanceResult> {
  const graph = await loadGraph();
  const node = findNode(graph, key, mod);
  if (!node) {
    if (mod) throw outOfScopeError(graph, key, mod);
    throw new Error(`Node not found: ${key}`);
  }

  const entry = (n: GraphNode): ChainEntry => ({
    key: n.key,
    type: n.type,
    file: n.file,
    name: n.name,
    mod: n.mod,
  });

  const parents: ChainEntry[] = [];
  for (const e of edgesFrom(graph, node.key, 'extends', mod)) {
    const { node: target, ambiguousIn } = resolveEdgeTarget(graph, e, mod);
    if (target) parents.push(entry(target));
    else if (ambiguousIn) parents.push(ambiguousEntry(e.to, ambiguousIn));
  }

  // Children are entities that extend this one, so an out-of-package child is another mod's
  // business — the scoped edge filter already drops them.
  const children = edgesTo(graph, node.key, 'extends', mod)
    .map((e) => findNode(graph, e.from, e.mod ?? mod) ?? findNode(graph, e.from))
    .filter(Boolean)
    .map((c) => entry(c as GraphNode));

  const fullChain: (ChainEntry & { depth: number })[] = [];
  const visited = new Set<string>();
  function walkUp(k: string, depth: number, curMod?: string) {
    if (visited.has(k.toLowerCase()) || depth > 15) return;
    visited.add(k.toLowerCase());
    const n = findNodeAcross(graph, k, curMod);
    if (n) fullChain.push({ ...entry(n), depth });
    // Follow the layer's own package: once the chain crosses into vanilla, vanilla's edges are
    // the ones that continue it. Each hop then starts from where its reference resolved.
    const nextMod = n?.mod ?? curMod;
    for (const e of edgesFrom(graph, k, 'extends', nextMod)) {
      const { node: target, ambiguousIn } = resolveEdgeTarget(graph, e, nextMod);
      if (ambiguousIn) {
        // Walking into a guess would attribute the rest of the chain to a package that may not
        // own it, so the branch stops here and says why.
        fullChain.push({ ...ambiguousEntry(e.to, ambiguousIn), depth: depth + 1 });
        continue;
      }
      walkUp(e.to, depth + 1, target?.mod ?? e.toMod ?? nextMod);
    }
  }
  walkUp(node.key, 0, mod);

  return {
    key: node.key,
    type: node.type,
    file: node.file,
    name: node.name,
    mod: node.mod,
    scope: mod,
    parents,
    children,
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
  mod?: string;
  scope?: string;
  referencedByCount: number;
  referencesCount: number;
  referencedBy: (ChainEntry & { rel: EdgeRel })[];
  references: (ChainEntry & { rel: EdgeRel })[];
  /** Referring entities that live in another package and were deliberately left out. */
  omittedFromOtherPackages?: number;
  note?: string;
}

/** Reverse lookup. Scoped to `mod`, both ends: who in *this* package points at the key. */
export async function findReferences(key: string, mod?: string): Promise<ReferenceResult> {
  const graph = await loadGraph();
  const node = findNode(graph, key, mod);
  const nodeInfo = node ?? { key, type: 'unknown', file: '', mod: undefined as string | undefined };

  const globalReferencedBy = edgesTo(graph, key);
  const scopedReferencedBy = mod
    ? globalReferencedBy.filter((e) => edgeInScope(e, mod))
    : globalReferencedBy;
  const allReferencedBy = scopedReferencedBy.map((e) => {
    const n = findNode(graph, e.from, e.mod ?? mod) ?? findNode(graph, e.from);
    return {
      key: e.from,
      type: n?.type ?? 'unknown',
      file: n?.file ?? '',
      rel: e.rel,
      mod: n?.mod ?? e.mod,
    };
  });
  const referencedBy = allReferencedBy.slice(0, 15);
  if (allReferencedBy.length > 15) {
    (referencedBy as unknown as { _truncated?: string })._truncated =
      `${allReferencedBy.length - 15} more omitted`;
  }

  const allReferences = edgesFrom(graph, key, undefined, mod).map((e) => {
    const { node: n, ambiguousIn } = resolveEdgeTarget(graph, e, mod);
    if (!n && ambiguousIn) return { ...ambiguousEntry(e.to, ambiguousIn), rel: e.rel };
    return { key: e.to, type: n?.type ?? 'unknown', file: n?.file ?? '', rel: e.rel, mod: n?.mod };
  });
  const references = allReferences.slice(0, 15);

  const omitted = globalReferencedBy.length - scopedReferencedBy.length;
  const missingInScope = mod !== undefined && node === undefined;

  return {
    key: nodeInfo.key,
    type: nodeInfo.type,
    file: nodeInfo.file,
    mod: nodeInfo.mod,
    scope: mod,
    referencedByCount: allReferencedBy.length,
    referencesCount: allReferences.length,
    referencedBy,
    references,
    ...(omitted > 0 ? { omittedFromOtherPackages: omitted } : {}),
    ...(missingInScope
      ? {
          note: `"${key}" is not defined in package "${mod}". Counts above cover this package only.`,
        }
      : omitted > 0
        ? {
            note: `${omitted} referring entities in other packages were excluded — the user selected "${mod}".`,
          }
        : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool 3: get_transform_chain (armor degradation layers)
// ---------------------------------------------------------------------------
export interface TransformChainResult {
  key: string;
  scope?: string;
  chain: { key: string; file: string; depth: number; mod?: string }[];
}

export async function getTransformChain(key: string, mod?: string): Promise<TransformChainResult> {
  const graph = await loadGraph();
  const chain: { key: string; file: string; depth: number; mod?: string }[] = [];
  const visited = new Set<string>();
  let current = key;
  let depth = 0;
  while (current && !visited.has(current.toLowerCase()) && depth < 50) {
    visited.add(current.toLowerCase());
    const node = findNodeAcross(graph, current, mod);
    chain.push({ key: current, file: node?.file ?? '', depth, mod: node?.mod });
    const next = edgesFrom(graph, current, 'transforms_to', mod)[0];
    if (!next) break;
    current = next.to;
    depth++;
    // `transform_on_consume` names a key, never a file, so there is no `toMod` to follow —
    // the chain stays inside the scope it started in.
  }
  return { key, scope: mod, chain };
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
  /** Package that owns the file, when the graph knows it. */
  mod?: string;
  /** Set when the file belongs to a package other than the one the request selected. */
  outOfScope?: boolean;
  note?: string;
}

/** Owning package per indexed file path, built once from the graph. */
async function fileToMod(): Promise<Map<string, string>> {
  if (fileModCache) return fileModCache;
  const graph = await loadGraph();
  const map = new Map<string, string>();
  for (const n of graph.nodes) if (!map.has(n.file)) map.set(n.file, n.mod);
  fileModCache = map;
  return map;
}

/**
 * `mod` does not restrict which files can be read: an inheritance chain that crosses into
 * another package still has to be verifiable, and every path the model gets comes from a tool
 * result that is already scoped. A file outside the scope is flagged instead, so the answer can
 * say where the value actually lives.
 */
export async function readSource(
  relFile: string,
  startLine?: number,
  endLine?: number,
  mod?: string,
): Promise<ReadSourceResult> {
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

  const owner = (await fileToMod()).get(relFile);
  const outOfScope = mod !== undefined && owner !== undefined && owner !== mod;

  return {
    file: relFile,
    totalLines,
    startLine: start,
    endLine: end,
    content: truncated ? slice.slice(0, maxChars) + '\n... [truncated]' : slice,
    truncated,
    mod: owner,
    ...(outOfScope
      ? {
          outOfScope: true,
          note:
            `This file belongs to package "${owner}", not the selected "${mod}". Use it only to ` +
            `explain an inherited value, and say which package it came from. Do not answer the ` +
            `question from "${owner}" data.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool 5: list_files
// ---------------------------------------------------------------------------
export interface ListFilesResult {
  pattern: string;
  type?: string;
  scope?: string;
  total: number;
  files: { file: string; type: string; key: string; name?: string; mod?: string }[];
  /** Matches in other packages, withheld because the request is scoped. */
  omittedFromOtherPackages?: number;
  note?: string;
}

export async function listFiles(
  pattern: string,
  type?: string,
  limit = 15,
  mod?: string,
): Promise<ListFilesResult> {
  const graph = await loadGraph();
  const regex = new RegExp(pattern.split('*').map(escapeRegex).join('.*'), 'i');
  let matched = graph.nodes.filter((n) => regex.test(n.file) || regex.test(n.key));
  if (type) matched = matched.filter((n) => n.type === type);

  const globalTotal = matched.length;
  if (mod) matched = matched.filter((n) => n.mod === mod);
  const omitted = globalTotal - matched.length;

  return {
    pattern,
    type,
    scope: mod,
    total: matched.length,
    files: matched
      .slice(0, limit)
      .map((n) => ({ file: n.file, type: n.type, key: n.key, name: n.name, mod: n.mod })),
    ...(omitted > 0
      ? {
          omittedFromOtherPackages: omitted,
          note: `${omitted} match(es) in other packages were excluded — the user selected "${mod}". Do not list them.`,
        }
      : {}),
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

export async function getScriptSymbols(file: string, mod?: string): Promise<ScriptSymbolsResult> {
  const symbols = await loadSymbols();
  const fileBase = path.basename(file);
  // `s.mod` is absent on symbol files written before graph version 3 — those stay unfiltered.
  const matched = symbols.filter(
    (s) =>
      (s.file === fileBase || s.file === file) && (!mod || s.mod === undefined || s.mod === mod),
  );

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
/** A key that exists, but only outside the package the request is scoped to. */
export interface NodeOutOfScope {
  key: string;
  found: false;
  scope: string;
  otherPackages: string[];
  note: string;
}

export async function getNode(
  key: string,
  mod?: string,
): Promise<GraphNode | NodeOutOfScope | null> {
  const graph = await loadGraph();
  const node = findNode(graph, key, mod);
  if (node) return node;
  if (!mod) return null;

  const elsewhere = otherPackagesWithKey(graph, key, mod);
  if (elsewhere.length === 0) return null;
  return {
    key,
    found: false,
    scope: mod,
    otherPackages: elsewhere,
    note:
      `"${key}" is not in package "${mod}". It exists in ${elsewhere.join(', ')}, which the user ` +
      `did not select — do not answer from there. Say so and offer to switch packages.`,
  };
}

// ---------------------------------------------------------------------------
// Tool 8: search_docs — full-text retrieval, the same index the RAG context comes from
// ---------------------------------------------------------------------------
export interface SearchDocsResult {
  query: string;
  scope?: string;
  total: number;
  results: { key: string; type: string; file: string; mod?: string; snippet: string }[];
  /** Hits this query would have had in other packages, when the scoped search found nothing. */
  otherPackageHits?: number;
  note?: string;
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
export async function searchDocs(
  query: string,
  type?: string,
  limit = 10,
  mod?: string,
): Promise<SearchDocsResult> {
  const SNIPPET_CHARS = 500;
  const capped = Math.min(Math.max(limit, 1), 30);
  const typeFilter: SearchFilters = type ? { type: type as DocumentType } : {};
  const filters: SearchFilters = mod ? { ...typeFilter, mod_name: mod } : typeFilter;
  const hits = await indexSearch(query, filters, capped);

  // A scoped miss is the moment the model is most tempted to wander. Report *that* other
  // packages have hits — as a count, never as content — so it can offer to switch instead of
  // quietly answering from the wrong package.
  let elsewhere = 0;
  if (mod && hits.length === 0) {
    elsewhere = (await indexSearch(query, typeFilter, capped)).length;
  }

  return {
    query,
    scope: mod,
    total: hits.length,
    ...(elsewhere > 0
      ? {
          otherPackageHits: elsewhere,
          note:
            `No hit in package "${mod}". ${elsewhere} document(s) match in other packages and were ` +
            `withheld on purpose. Tell the user the item is not in "${mod}" and ask whether to ` +
            `switch packages — do not answer from another package.`,
        }
      : {}),
    results: hits.map((r) => ({
      key: r.key,
      type: r.type,
      file: r.metadata.file_path ?? '',
      mod: r.metadata.mod_name,
      snippet:
        r.content.length > SNIPPET_CHARS ? r.content.slice(0, SNIPPET_CHARS) + '…' : r.content,
    })),
  };
}
