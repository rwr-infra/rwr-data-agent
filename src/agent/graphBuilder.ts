import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import { collectFiles } from '../ingestion/shared.js';
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
          from: (currentKey ?? path.basename(filePath)) as string,
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'] as string,
          rel: 'fires',
        });
      }
      if (name === 'call' && typeof childAttrs['@_file'] === 'string') {
        ctx.edges.push({
          from: (currentKey ?? path.basename(filePath)) as string,
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'] as string,
          rel: 'includes',
        });
      }
      if (name === 'next_in_chain' && typeof childAttrs['@_key'] === 'string') {
        ctx.edges.push({
          from: (currentKey ?? path.basename(filePath)) as string,
          fromFile: filePath,
          targetRef: childAttrs['@_key'],
          rel: 'next_in_chain',
        });
      }
      if (name === 'weapon' && typeof childAttrs['@_file'] === 'string') {
        ctx.edges.push({
          from: (currentKey ?? path.basename(filePath)) as string,
          fromFile: filePath,
          targetRef: childAttrs['@_file'],
          targetFile: childAttrs['@_file'] as string,
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
    const parsed = parser.parse(content);
    const rootKey = Object.keys(parsed).find((k) => k !== '?xml');
    if (!rootKey) return;
    walk(parsed[rootKey], filePath, ctx, rootKey, true);
  } catch {
    ctx.nodes.push({
      key: path.basename(filePath),
      type: EXT_TYPE_MAP[ext] ?? 'unknown',
      file: path.relative(ctx.sourceDir, filePath).replace(/\\/g, '/'),
      mod: ctx.modName,
    });
  }
}

async function resolveFilePath(refFile: string, fromFile: string, sourceDir: string): Promise<string | undefined> {
  const candidates = [
    path.resolve(path.dirname(fromFile), refFile),
    path.resolve(sourceDir, refFile),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return c;
    } catch {}
  }
  return undefined;
}

export async function extractScriptSymbols(filePath: string): Promise<ScriptSymbol[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const symbols: ScriptSymbol[] = [];
  const fileBase = path.basename(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inc = line.match(/^\s*#include\s+"([^"]+)"/);
    if (inc) {
      symbols.push({ file: fileBase, name: inc[1], signature: `#include "${inc[1]}"`, kind: 'include', line: i + 1 });
      continue;
    }
    const cls = line.match(/^\s*(?:class|interface|mixin)\s+(\w+)/);
    if (cls) {
      symbols.push({ file: fileBase, name: cls[1], signature: line.trim(), kind: 'class', line: i + 1 });
      continue;
    }
    const fn = line.match(/^\s*(?:(?:void|bool|int|float|double|string|uint|array<[^>]+>)|[A-Za-z_]\w*(?:\s*[@&])?)\s+(\w+)\s*\(([^)]*)\)\s*\{?\s*$/);
    if (fn && !line.includes('=')) {
      symbols.push({ file: fileBase, name: fn[1], signature: line.trim().replace(/\{?\s*$/, ''), kind: 'function', line: i + 1 });
    }
  }
  return symbols;
}

export async function buildGraph(sourceDir: string, modName: string, existingFiles?: string[]): Promise<{ graph: RwrGraph; symbols: ScriptSymbol[] }> {
  const files = existingFiles ?? await collectFiles(sourceDir);
  const ctx: BuildCtx = { nodes: [], edges: [], sourceDir, modName };

  const limit = pLimit(8);
  await Promise.all(files.map((file) => limit(() => buildFileNodes(file, ctx))));

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
    const absFile = path.resolve(sourceDir, n.file);
    const arr = fileToNodeKeys.get(absFile) ?? [];
    arr.push(n.key);
    fileToNodeKeys.set(absFile, arr);
  }

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const re of ctx.edges) {
    let resolvedTo = re.targetRef;

    if (re.targetFile) {
      const resolvedPath = await resolveFilePath(re.targetFile, re.fromFile, sourceDir);
      if (resolvedPath) {
        const nodeKeys = fileToNodeKeys.get(resolvedPath);
        resolvedTo = nodeKeys?.[0] ?? re.targetFile;
      } else {
        resolvedTo = re.targetFile;
      }
    }

    const edgeId = `${re.from}|${resolvedTo}|${re.rel}`;
    if (seenEdges.has(edgeId)) continue;
    seenEdges.add(edgeId);

    edges.push({ from: re.from, to: resolvedTo, rel: re.rel, context: re.context });
  }

  const scriptFiles = files.filter((f) => path.extname(f).toLowerCase() === '.as');
  const symbols: ScriptSymbol[] = [];
  for (const f of scriptFiles) {
    try {
      symbols.push(...await extractScriptSymbols(f));
    } catch {}
  }

  const graph: RwrGraph = {
    version: 1,
    mod: modName,
    source_dir: sourceDir,
    built_at: new Date().toISOString(),
    stats: { nodes: uniqueNodes.length, edges: edges.length, files: files.length },
    nodes: uniqueNodes,
    edges,
  };

  return { graph, symbols };
}
