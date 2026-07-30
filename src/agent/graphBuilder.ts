import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import { collectFiles } from '../ingestion/shared.js';
import { discoverPackages, type DataPackage } from '../ingestion/packages.js';
import { extractScriptSymbols } from '../ingestion/asSymbols.js';
import pLimit from 'p-limit';
import type { GraphNode, GraphEdge, EdgeRel, ScriptSymbol, RwrGraph } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: true,
  alwaysCreateTextNode: false,
});

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
    ctx.nodes.push({
      key: currentKey,
      type: nodeType,
      file: path.relative(ctx.sourceDir, filePath).replace(/\\/g, '/'),
      name: typeof attrs['@_name'] === 'string' ? attrs['@_name'] : undefined,
      mod: ctx.modName,
    });

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

async function buildFileNodes(filePath: string, ctx: BuildCtx): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();

  if (['.as', '.ai', '.resources', '.models', '.name', '.text_lines'].includes(ext)) {
    ctx.nodes.push({
      key: path.basename(filePath),
      type: EXT_TYPE_MAP[ext] ?? 'resource',
      file: path.relative(ctx.sourceDir, filePath).replace(/\\/g, '/'),
      mod: ctx.modName,
    });
    return;
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    // fast-xml-parser types parse() as `any`; narrow it at the boundary.
    const parsed: unknown = parser.parse(content);
    const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const rootKey = Object.keys(root).find((k) => k !== '?xml');
    if (!rootKey) return;
    walk(root[rootKey], filePath, ctx, rootKey, true);
  } catch {
    ctx.nodes.push({
      key: path.basename(filePath),
      type: EXT_TYPE_MAP[ext] ?? 'unknown',
      file: path.relative(ctx.sourceDir, filePath).replace(/\\/g, '/'),
      mod: ctx.modName,
    });
  }
}

/**
 * Resolve a `file="…"` reference. RWR packages overlay each other, so a reference can
 * point inside the referring package or fall through to a sibling package. Order:
 * the referring file's own directory, then its package root, then the data root.
 */
async function resolveFilePath(
  refFile: string,
  fromFile: string,
  sourceDir: string,
  packageRootOf: (file: string) => string,
): Promise<string | undefined> {
  const candidates = [
    path.resolve(path.dirname(fromFile), refFile),
    path.resolve(packageRootOf(fromFile), refFile),
    path.resolve(sourceDir, refFile),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return c;
    } catch {
      // Candidate path does not exist — try the next one.
    }
  }
  return undefined;
}

/** Read a `.as` file and extract its symbols. Shared implementation lives in ingestion/asSymbols. */
export async function extractScriptSymbolsFromFile(filePath: string): Promise<ScriptSymbol[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return extractScriptSymbols(content, path.basename(filePath));
}

/**
 * Build the entity graph over every package under `sourceDir`.
 *
 * Node `file` paths stay relative to `sourceDir` (not the package dir) so a single
 * data root is enough for the agent's `readSource` tool, while `mod` carries the
 * owning package name.
 */
export async function buildGraph(
  sourceDir: string,
  packages?: DataPackage[],
): Promise<{ graph: RwrGraph; symbols: ScriptSymbol[] }> {
  const root = path.resolve(sourceDir);
  const pkgs = packages ?? (await discoverPackages(root));

  const ctx: BuildCtx = { nodes: [], edges: [], sourceDir: root, modName: '' };
  const limit = pLimit(8);
  const files: string[] = [];

  // Longest-prefix match so a file always maps back to its own package root.
  const pkgDirs = pkgs
    .map((p) => ({ dir: path.resolve(p.dir), name: p.name }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const packageEntryOf = (file: string) =>
    pkgDirs.find((p) => file === p.dir || file.startsWith(p.dir + path.sep));
  const packageRootOf = (file: string): string => packageEntryOf(file)?.dir ?? root;
  /** Owning package of a file, by the same longest-prefix rule the node walk uses. */
  const packageNameOf = (file: string): string => packageEntryOf(file)?.name ?? '';

  for (const pkg of pkgs) {
    const pkgFiles = await collectFiles(pkg.dir);
    files.push(...pkgFiles);
    ctx.modName = pkg.name;
    await Promise.all(pkgFiles.map((file) => limit(() => buildFileNodes(file, ctx))));
  }

  // Deduplicate nodes (same key+file can appear from nested walks)
  const seenNodes = new Set<string>();
  const uniqueNodes = ctx.nodes.filter((n) => {
    const id = `${n.key}|${n.file}`;
    if (seenNodes.has(id)) return false;
    seenNodes.add(id);
    return true;
  });

  const keyToNode = new Map<string, GraphNode>();
  const fileToNodeKeys = new Map<string, string[]>();
  for (const n of uniqueNodes) {
    keyToNode.set(n.key, n);
    const absFile = path.resolve(root, n.file);
    const arr = fileToNodeKeys.get(absFile) ?? [];
    arr.push(n.key);
    fileToNodeKeys.set(absFile, arr);
  }

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const re of ctx.edges) {
    let resolvedTo = re.targetRef;
    let toMod: string | undefined;

    if (re.targetFile) {
      const resolvedPath = await resolveFilePath(re.targetFile, re.fromFile, root, packageRootOf);
      if (resolvedPath) {
        const nodeKeys = fileToNodeKeys.get(resolvedPath);
        resolvedTo = nodeKeys?.[0] ?? re.targetFile;
        // Keep which package the reference landed in — the key alone is ambiguous for base
        // files that several packages define.
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

  const scriptFiles = files.filter((f) => path.extname(f).toLowerCase() === '.as');
  const symbols: ScriptSymbol[] = [];
  for (const f of scriptFiles) {
    try {
      // `ScriptSymbol.file` is a basename, so the package has to be stamped here — two mods
      // shipping `ItemDropEvent.as` are otherwise indistinguishable at lookup time.
      const mod = packageNameOf(f);
      for (const s of await extractScriptSymbolsFromFile(f)) symbols.push({ ...s, mod });
    } catch {
      // An unreadable or unparseable script must not abort the whole graph build.
    }
  }

  const graph: RwrGraph = {
    version: 3,
    packages: pkgs.map((p) => ({ name: p.name, displayName: p.displayName })),
    source_dir: root,
    built_at: new Date().toISOString(),
    stats: { nodes: uniqueNodes.length, edges: edges.length, files: files.length },
    nodes: uniqueNodes,
    edges,
  };

  return { graph, symbols };
}
