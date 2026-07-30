import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { createGraphCollector } from '../agent/graphBuilder.js';
import {
  createIndexWriter,
  entryFromDoc,
  fingerprintFiles,
  invalidateSearchIndex,
  type IndexFingerprint,
  type PackageSummary,
} from '../retrieval/localSearch.js';
import { discoverPackages } from '../ingestion/packages.js';
import { collectFiles, parseContent, XML_EXTS } from '../ingestion/shared.js';
import { clearParseCaches, parseXml } from '../ingestion/xmlParser.js';
import { loadAllLanguages, resolveI18n } from '../ingestion/i18n.js';
import { config } from '../config/index.js';

export interface BuildIndexesOptions {
  dataDir: string;
  graphPath: string;
  searchIndexPath: string;
  /** Restrict the build to these package names (default: every package discovered). */
  only?: string[];
  verbose?: boolean;
  /**
   * File lists per package name, already walked by the caller. `ensureIndexes()` walks the tree
   * to decide whether the index is stale and passes the result through so the build does not
   * repeat it — `walkFiles` is deterministic, so this is equivalent to re-walking.
   */
  filesByPackage?: Map<string, string[]>;
  /** Fingerprint of `filesByPackage`, when the caller already computed it. */
  fingerprint?: IndexFingerprint;
}

export interface BuildIndexesResult {
  packages: PackageSummary[];
  documents: number;
  nodes: number;
  edges: number;
  files: number;
  symbols: number;
}

/**
 * Build both indexes (graph + search) from a data root and write them to disk.
 *
 * One pass, one read and one XML parse per file, feeding the graph collector and the search
 * writer from the same parsed tree. Search entries are streamed straight to disk, so the only
 * thing that grows with the size of the data set is the graph itself — the peak used to be the
 * full entry array plus a MiniSearch index built from it plus a JSON string of the lot, all
 * alive at once, which is what made a 2 GB host thrash.
 */
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

  const filesByPackage = new Map<string, string[]>();
  const allFiles: string[] = [];
  for (const pkg of packages) {
    const files = options.filesByPackage?.get(pkg.name) ?? (await collectFiles(pkg.dir));
    filesByPackage.set(pkg.name, files);
    allFiles.push(...files);
  }

  // Fingerprinted before the pass, not after: a file touched *during* the build then reads as
  // newer than the index and forces a rebuild, instead of being silently missed forever.
  const fingerprint = options.fingerprint ?? (await fingerprintFiles(allFiles));

  const collector = createGraphCollector(root, packages);
  const writer = createIndexWriter(searchIndexPath);
  const summaries: PackageSummary[] = [];
  const limit = pLimit(config.indexConcurrency);

  try {
    for (const pkg of packages) {
      const files = filesByPackage.get(pkg.name) ?? [];
      const langData = await loadAllLanguages(path.join(pkg.dir, 'languages'));
      collector.setPackage(pkg.name);
      let seq = 0;

      await Promise.all(
        files.map((file) =>
          limit(async () => {
            const ext = path.extname(file).toLowerCase();
            const isXml = XML_EXTS.has(ext);

            // A non-XML file contributes one file-level node regardless of whether its content
            // can be read, which is what the graph has always recorded for these extensions.
            if (!isXml) collector.addOpaqueFile(file, 'resource');

            let content: string;
            try {
              content = await fs.readFile(file, 'utf-8');
            } catch {
              if (isXml) collector.addOpaqueFile(file, 'unknown');
              return;
            }

            let tree: Record<string, unknown> | undefined;
            if (isXml) {
              try {
                tree = parseXml(content);
              } catch {
                collector.addOpaqueFile(file, 'unknown');
                return;
              }
              collector.addXmlFile(file, tree);
            } else if (ext === '.as') {
              collector.addScriptSymbols(file, content);
            }

            try {
              const docs = await parseContent(content, file, pkg.name, tree);
              for (const doc of docs) {
                if (langData.length > 0) {
                  const i18n = resolveI18n(doc, langData);
                  if (i18n) doc.i18n = i18n;
                }
                await writer.add(entryFromDoc(root, pkg.name, doc, seq++));
              }
            } catch {
              // A single unparseable game file must not abort the build.
            }
          }),
        ),
      );

      // Inheritance/include trees are resolved relative to the referring file, so nothing in
      // them survives the package boundary usefully.
      clearParseCaches();
      summaries.push({ name: pkg.name, displayName: pkg.displayName, count: seq });
    }

    const { graph, symbols } = await collector.finalize({ packages, fileCount: allFiles.length });

    const resolvedGraphPath = path.resolve(graphPath);
    await fs.mkdir(path.dirname(resolvedGraphPath), { recursive: true });
    await fs.writeFile(resolvedGraphPath, JSON.stringify(graph), 'utf-8');
    const symbolsPath = path.join(path.dirname(resolvedGraphPath), 'script-symbols.json');
    await fs.writeFile(symbolsPath, JSON.stringify(symbols), 'utf-8');

    const written = await writer.finish({ dataDir: root, packages: summaries, fingerprint });
    invalidateSearchIndex();

    if (verbose) {
      console.log(`[index] graph.json          -> ${resolvedGraphPath}`);
      console.log(`[index] script-symbols.json -> ${symbolsPath}`);
      console.log(`[index] search-index        -> ${path.resolve(searchIndexPath)} (+ .ndjson body)`);
      console.log(
        `[index] ${written} documents | ${graph.stats.nodes} nodes | ${graph.stats.edges} edges | ${graph.stats.files} files | ${symbols.length} script symbols`,
      );
      for (const p of summaries) {
        console.log(`  ${p.name.padEnd(20)} ${String(p.count).padStart(7)} docs   ${p.displayName}`);
      }
    }

    return {
      packages: summaries,
      documents: written,
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      files: graph.stats.files,
      symbols: symbols.length,
    };
  } catch (err) {
    await writer.abort();
    throw err;
  }
}
