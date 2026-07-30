import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { extractScriptSymbols } from '../ingestion/asSymbols.js';
import { config } from '../config/index.js';
import type { DataPackage } from '../ingestion/packages.js';
import type { GraphNode, GraphEdge, EdgeRel, ScriptSymbol, RwrGraph } from './types.js';

const EXT_TYPE_MAP: Record<string, string> = {
  '.weapon': 'weapon',
  '.base_weapon': 'weapon',
  '.projectile': 'projectile',
  '.carry_item': 'carry_item',
  '.base_carry_item': 'carry_item',
  '.vehicle': 'vehicle',
  '.base_vehicle': 'vehicle',
  '.call': 'call',
  '.character': 'character',
  '.valuable': 'carry_item',
  '.throwable': 'weapon',
  '.animation_base': 'animation',
  '.base': 'base',
  '.xml': 'xml',
  '.as': 'script',
  '.ai': 'ai_config',
  '.resources': 'resource',
  '.models': 'model',
};

const ROOT_ELEMENT_MAP: Record<string, string> = {
  weapon: 'weapon',
  carry_item: 'carry_item',
  projectile: 'projectile',
  vehicle: 'vehicle',
  call: 'call',
  character: 'character',
  faction: 'faction',
  soldier: 'soldier',
};

function makeKey(attrs: Record<string, unknown>, filePath: string): string {
  const k = attrs['@_key'] ?? attrs['@_name'] ?? attrs['@_filename'];
  if (typeof k === 'string' && k.trim()) return k.trim();
  return path.basename(filePath);
}

interface RawEdge {
  from: string;
  fromFile: string;
  targetRef: string;
  targetFile?: string;
  rel: EdgeRel;
  context?: string;
}

interface BuildCtx {
  nodes: GraphNode[];
  edges: RawEdge[];
  sourceDir: string;
  modName: string;
  /** `key|file` of every node already pushed — dedup happens on insert, not in a second pass. */
  seenNodes: Set<string>;
  /** First node key seen per absolute file path — the only thing edge resolution reads. */
  firstKeyOfFile: Map<string, string>;
}

function pushNode(ctx: BuildCtx, node: GraphNode, absFile: string): void {
  const id = `${node.key}|${node.file}`;
  if (ctx.seenNodes.has(id)) return;
  ctx.seenNodes.add(id);
  ctx.nodes.push(node);
  if (!ctx.firstKeyOfFile.has(absFile)) ctx.firstKeyOfFile.set(absFile, node.key);
}

function walk(obj: unknown, filePath: string, ctx: BuildCtx, rootElement: string | undefined, isRoot: boolean): void {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) walk(item, filePath, ctx, rootElement, isRoot);
    return;
  }

  const record = obj as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  const children: { name: string; value: unknown }[] = [];

  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith('@_')) attrs[k] = v;
    else children.push({ name: k, value: v });
  }

  const hasKeyAttr = attrs['@_key'] || attrs['@_name'];
  let currentKey: string | undefined;

  if (hasKeyAttr) {
    currentKey = makeKey(attrs, filePath);
  } else if (isRoot && Object.keys(attrs).length > 0) {
    currentKey = path.basename(filePath);
  }

  if (currentKey) {
    const nodeType = rootElement && ROOT_ELEMENT_MAP[rootElement]
      ? ROOT_ELEMENT_MAP[rootElement]
      : EXT_TYPE_MAP[path.extname(filePath).toLowerCase()] ?? 'unknown';
    pushNode(
      ctx,
      {
        key: currentKey,
        type: nodeType,
        file: path.relative(ctx.sourceDir, filePath).replace(/\\/g, '/'),
        name: typeof attrs['@_name'] === 'string' ? attrs['@_name'] : undefined,
        mod: ctx.modName,
      },
      filePath,
    );

    if (typeof attrs['@_file'] === 'string' && attrs['@_file'].trim()) {
      ctx.edges.push({ from: currentKey, fromFile: filePath, targetRef: attrs['@_file'], targetFile: attrs['@_file'], rel: 'extends' });
    }
    if (typeof attrs['@_transform_on_consume'] === 'string' && attrs['@_transform_on_consume'].trim()) {
      ctx.edges.push({ from: currentKey, fromFile: filePath, targetRef: attrs['@_transform_on_consume'], rel: 'transforms_to' });
    }
  }

  for (const { name, value } of children) {
    const childList = Array.isArray(value) ? value : [value];
    for (const childVal of childList) {
      const childAttrs = (childVal && typeof childVal === 'object' && !Array.isArray(childVal))
        ? childVal as Record<string, unknown>
        : {};

      if (name === 'projectile' && typeof childAttrs['@_file'] === 'string') {
        ctx.edges.push({
          from: currentKey ?? path.basename(filePath),
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'],
          rel: 'fires',
        });
      }
      if (name === 'call' && typeof childAttrs['@_file'] === 'string') {
        ctx.edges.push({
          from: currentKey ?? path.basename(filePath),
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'],
          rel: 'includes',
        });
      }
      if (name === 'next_in_chain' && typeof childAttrs['@_key'] === 'string') {
        ctx.edges.push({
          from: currentKey ?? path.basename(filePath),
          fromFile: filePath,
          targetRef: childAttrs['@_key'],
          rel: 'next_in_chain',
        });
      }
      if (name === 'weapon' && typeof childAttrs['@_file'] === 'string') {
        ctx.edges.push({
          from: currentKey ?? path.basename(filePath),
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'],
          rel: 'references',
        });
      }

      const childRoot = rootElement ?? ROOT_ELEMENT_MAP[name] ?? undefined;
      walk(childVal, filePath, ctx, childRoot, false);
    }
  }
}

/** Read a `.as` file and extract its symbols. Shared implementation lives in ingestion/asSymbols. */
export async function extractScriptSymbolsFromFile(filePath: string): Promise<ScriptSymbol[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return extractScriptSymbols(content, path.basename(filePath));
}

/**
 * Incremental graph builder — the only way to build the graph.
 *
 * The index build makes a *single* pass over the data files and feeds each one to both this
 * collector and the search-document extractor, so a file is read and XML-parsed exactly
 * once instead of once per index. Nothing here touches the filesystem during the pass — the
 * caller owns I/O — and the only state kept between files is the node/edge lists.
 *
 * Node `file` paths stay relative to the data root (not the package dir) so a single root is
 * enough for the agent's `readSource` tool, while `mod` carries the owning package name.
 */
export interface GraphCollector {
  /** Package that the following `add*` calls belong to. */
  setPackage(name: string): void;
  /** Contribute the nodes and edges of an already-parsed XML tree. */
  addXmlFile(filePath: string, tree: Record<string, unknown>): void;
  /**
   * Contribute a single file-level node for a file with no XML structure to walk. `fallback`
   * mirrors the two historical cases: `resource` for the natively opaque extensions (`.as`,
   * `.ai`, `.text_lines`, …), `unknown` for a file that failed to read or parse.
   */
  addOpaqueFile(filePath: string, fallback: 'resource' | 'unknown'): void;
  /** Contribute the AngelScript symbols of a `.as` file from content already in memory. */
  addScriptSymbols(filePath: string, content: string): void;
  /** Resolve edges and assemble the graph. */
  finalize(opts: { packages: DataPackage[]; fileCount: number }): Promise<{ graph: RwrGraph; symbols: ScriptSymbol[] }>;
}

export function createGraphCollector(sourceDir: string, packages: DataPackage[]): GraphCollector {
  const root = path.resolve(sourceDir);
  const ctx: BuildCtx = {
    nodes: [],
    edges: [],
    sourceDir: root,
    modName: '',
    seenNodes: new Set(),
    firstKeyOfFile: new Map(),
  };
  const symbols: ScriptSymbol[] = [];

  // Longest-prefix match so a file always maps back to its own package root.
  const pkgDirs = packages
    .map((p) => ({ dir: path.resolve(p.dir), name: p.name }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const packageEntryOf = (file: string) =>
    pkgDirs.find((p) => file === p.dir || file.startsWith(p.dir + path.sep));
  const packageRootOf = (file: string): string => packageEntryOf(file)?.dir ?? root;
  /** Owning package of a file, by the same longest-prefix rule the node walk uses. */
  const packageNameOf = (file: string): string => packageEntryOf(file)?.name ?? '';

  return {
    setPackage(name) {
      ctx.modName = name;
    },

    addXmlFile(filePath, tree) {
      const rootKey = Object.keys(tree).find((k) => k !== '?xml');
      if (!rootKey) return;
      walk(tree[rootKey], filePath, ctx, rootKey, true);
    },

    addOpaqueFile(filePath, fallback) {
      const ext = path.extname(filePath).toLowerCase();
      pushNode(
        ctx,
        {
          key: path.basename(filePath),
          type: EXT_TYPE_MAP[ext] ?? fallback,
          file: path.relative(root, filePath).replace(/\\/g, '/'),
          mod: ctx.modName,
        },
        filePath,
      );
    },

    addScriptSymbols(filePath, content) {
      // `ScriptSymbol.file` is a basename, so the package has to be stamped here — two mods
      // shipping `ItemDropEvent.as` are otherwise indistinguishable at lookup time.
      const mod = packageNameOf(filePath);
      for (const s of extractScriptSymbols(content, path.basename(filePath))) {
        symbols.push({ ...s, mod });
      }
    },

    async finalize({ packages: pkgs, fileCount }) {
      const edges = await resolveEdges(ctx, root, packageRootOf, packageNameOf);

      const graph: RwrGraph = {
        version: 3,
        packages: pkgs.map((p) => ({ name: p.name, displayName: p.displayName })),
        source_dir: root,
        built_at: new Date().toISOString(),
        stats: { nodes: ctx.nodes.length, edges: edges.length, files: fileCount },
        nodes: ctx.nodes,
        edges,
      };

      return { graph, symbols };
    },
  };
}

/**
 * Resolve a `file="…"` reference. RWR packages overlay each other, so a reference can
 * point inside the referring package or fall through to a sibling package. Order:
 * the referring file's own directory, then its package root, then the data root.
 *
 * `existsCache` is what makes this affordable. Thousands of edges point at the same handful
 * of base files, and every candidate used to cost an `fs.stat` in a fully sequential loop —
 * up to three per edge, tens of thousands of round trips on a network-backed data volume.
 */
async function resolveFilePath(
  refFile: string,
  fromFile: string,
  sourceDir: string,
  packageRootOf: (file: string) => string,
  existsCache: Map<string, boolean>,
): Promise<string | undefined> {
  const candidates = [
    path.resolve(path.dirname(fromFile), refFile),
    path.resolve(packageRootOf(fromFile), refFile),
    path.resolve(sourceDir, refFile),
  ];
  for (const c of candidates) {
    let exists = existsCache.get(c);
    if (exists === undefined) {
      exists = await fs
        .stat(c)
        .then((s) => s.isFile())
        .catch(() => false);
      existsCache.set(c, exists);
    }
    if (exists) return c;
  }
  return undefined;
}

async function resolveEdges(
  ctx: BuildCtx,
  root: string,
  packageRootOf: (file: string) => string,
  packageNameOf: (file: string) => string,
): Promise<GraphEdge[]> {
  // Every indexed file is known to exist, which answers the majority of successful lookups
  // without touching the filesystem at all.
  const existsCache = new Map<string, boolean>();
  for (const abs of ctx.firstKeyOfFile.keys()) existsCache.set(abs, true);

  // stat() is I/O, not CPU, so this is allowed to run wider than the parse pass.
  const limit = pLimit(config.indexConcurrency * 8);
  const resolved = await Promise.all(
    ctx.edges.map((re) =>
      limit(() =>
        re.targetFile
          ? resolveFilePath(re.targetFile, re.fromFile, root, packageRootOf, existsCache)
          : Promise.resolve(undefined),
      ),
    ),
  );

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (let i = 0; i < ctx.edges.length; i++) {
    const re = ctx.edges[i];
    let resolvedTo = re.targetRef;
    let toMod: string | undefined;

    if (re.targetFile) {
      const resolvedPath = resolved[i];
      if (resolvedPath) {
        // Keep which package the reference landed in — the key alone is ambiguous for base
        // files that several packages define.
        resolvedTo = ctx.firstKeyOfFile.get(resolvedPath) ?? re.targetFile;
        toMod = packageNameOf(resolvedPath);
      } else {
        resolvedTo = re.targetFile;
      }
    }

    // The package is part of the identity: two packages that both define `ak47.weapon ->
    // base.weapon` are two distinct edges, and collapsing them would hand one package's
    // relationship to the other.
    const mod = packageNameOf(re.fromFile);
    const edgeId = `${re.from}|${resolvedTo}|${re.rel}|${mod}|${toMod ?? ''}`;
    if (seenEdges.has(edgeId)) continue;
    seenEdges.add(edgeId);

    edges.push({ from: re.from, to: resolvedTo, rel: re.rel, context: re.context, mod, toMod });
  }

  // Raw edges carry an absolute path per entry and nothing needs them again.
  ctx.edges.length = 0;
  return edges;
}
