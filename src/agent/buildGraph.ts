import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { buildGraph } from './graphBuilder.js';

const program = new Command();

program
  .name('rwr-build-graph')
  .description('Build a graph index (nodes + edges) from RWR data files for the agent tool layer')
  .version('1.0.0')
  .requiredOption('-s, --source <path>', 'Source directory containing data files', './data')
  .requiredOption('-m, --mod <name>', 'Mod name', 'GFL_Castling')
  .option('-o, --output <path>', 'Output graph.json path', './output/graph.json')
  .parse();

async function main() {
  const options = program.opts();
  const sourceDir = path.resolve(options.source);
  const modName = options.mod as string;
  const outputPath = path.resolve(options.output);

  console.log(`Building graph index from ${sourceDir} for mod "${modName}"...`);

  const { graph, symbols } = await buildGraph(sourceDir, modName);

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
  console.error('Graph build failed:', err);
  process.exit(1);
});
