import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { buildGraph } from './graphBuilder.js';
import { buildSearchIndex, saveSearchIndex } from '../retrieval/localSearch.js';
import { collectFiles } from '../ingestion/shared.js';

const program = new Command();

program
  .name('rwr-build-index')
  .description('Build graph index + search index + AS symbols from RWR data files')
  .version('1.0.0')
  .requiredOption('-s, --source <path>', 'Source directory containing data files', './data')
  .requiredOption('-m, --mod <name>', 'Mod name', 'GFL_Castling')
  .option('-o, --output <path>', 'Output graph.json path', './output/graph.json')
  .option('--skip-search', 'Skip search index build', false)
  .parse();

async function main() {
  const options = program.opts();
  const sourceDir = path.resolve(options.source);
  const modName = options.mod as string;
  const outputPath = path.resolve(options.output);

  console.log(`Building index from ${sourceDir} for mod "${modName}"...`);

  // Collect files once — shared by graph builder and search index builder to avoid double I/O
  const files = await collectFiles(sourceDir);

  const { graph, symbols } = await buildGraph(sourceDir, modName, files);

  const outDir = path.dirname(outputPath);
  await fs.mkdir(outDir, { recursive: true });

  const relCounts: Record<string, number> = {};
  for (const e of graph.edges) {
    relCounts[e.rel] = (relCounts[e.rel] ?? 0) + 1;
  }
  const typeCounts: Record<string, number> = {};
  for (const n of graph.nodes) {
    typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;
  }

  await fs.writeFile(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
  const symbolsPath = path.join(path.dirname(outputPath), 'script-symbols.json');
  await fs.writeFile(symbolsPath, JSON.stringify(symbols, null, 2), 'utf-8');

  console.log(`\nGraph index written to ${outputPath}`);
  console.log(`Script symbols written to ${symbolsPath}`);

  // Build search index (Minisearch full-text, replaces pgvector)
  if (!options.skipSearch) {
    console.log(`\nBuilding search index...`);
    const { count, entries } = await buildSearchIndex(sourceDir, modName, files);
    const searchIndexPath = path.join(outDir, 'search-index.json');
    await saveSearchIndex(entries, searchIndexPath);
    console.log(`Search index written to ${searchIndexPath} (${count} documents)`);
  }

  console.log(`\nStats:`);
  console.log(`  Files scanned : ${graph.stats.files}`);
  console.log(`  Nodes         : ${graph.stats.nodes}`);
  console.log(`  Edges         : ${graph.stats.edges}`);
  console.log(`  Script symbols: ${symbols.length}`);
  console.log(`\nNodes by type:`);
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(16)} ${c}`);
  }
  console.log(`\nEdges by relationship:`);
  for (const [r, c] of Object.entries(relCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(16)} ${c}`);
  }
}

main().catch((err) => {
  console.error('Index build failed:', err);
  process.exit(1);
});
