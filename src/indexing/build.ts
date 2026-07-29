import * as fs from 'fs/promises';
import * as path from 'path';
import { buildGraph } from '../agent/graphBuilder.js';
import { buildSearchIndex, saveSearchIndex, invalidateSearchIndex, type PackageSummary } from '../retrieval/localSearch.js';
import { discoverPackages } from '../ingestion/packages.js';

export interface BuildIndexesOptions {
  dataDir: string;
  graphPath: string;
  searchIndexPath: string;
  /** Restrict the build to these package names (default: every package discovered). */
  only?: string[];
  verbose?: boolean;
}

export interface BuildIndexesResult {
  packages: PackageSummary[];
  documents: number;
  nodes: number;
  edges: number;
  files: number;
  symbols: number;
}

/** Build both indexes (graph + search) from a data root and write them to disk. */
export async function buildIndexes(options: BuildIndexesOptions): Promise<BuildIndexesResult> {
  const { dataDir, graphPath, searchIndexPath, only, verbose = false } = options;
  const root = path.resolve(dataDir);

  let packages = await discoverPackages(root);
  if (only?.length) {
    const wanted = new Set(only);
    packages = packages.filter((p) => wanted.has(p.name));
    if (packages.length === 0) {
      throw new Error(`No package matched --only=${only.join(',')} under ${root}`);
    }
  }

  if (verbose) {
    console.log(`[index] Data root: ${root}`);
    console.log(`[index] Packages  : ${packages.map((p) => p.name).join(', ')}`);
  }

  const { graph, symbols } = await buildGraph(root, packages);

  await fs.mkdir(path.dirname(path.resolve(graphPath)), { recursive: true });
  await fs.writeFile(path.resolve(graphPath), JSON.stringify(graph), 'utf-8');
  const symbolsPath = path.join(path.dirname(path.resolve(graphPath)), 'script-symbols.json');
  await fs.writeFile(symbolsPath, JSON.stringify(symbols), 'utf-8');

  const search = await buildSearchIndex(root, packages);
  await saveSearchIndex(search, root, searchIndexPath);
  invalidateSearchIndex();

  if (verbose) {
    console.log(`[index] graph.json          -> ${path.resolve(graphPath)}`);
    console.log(`[index] script-symbols.json -> ${symbolsPath}`);
    console.log(`[index] search-index.json   -> ${path.resolve(searchIndexPath)}`);
    console.log(
      `[index] ${search.count} documents | ${graph.stats.nodes} nodes | ${graph.stats.edges} edges | ${graph.stats.files} files | ${symbols.length} script symbols`,
    );
    for (const p of search.packages) {
      console.log(`  ${p.name.padEnd(20)} ${String(p.count).padStart(7)} docs   ${p.displayName}`);
    }
  }

  return {
    packages: search.packages,
    documents: search.count,
    nodes: graph.stats.nodes,
    edges: graph.stats.edges,
    files: graph.stats.files,
    symbols: symbols.length,
  };
}
