import { Command } from 'commander';
import * as path from 'path';
import { config } from '../config/index.js';
import { buildIndexes } from '../indexing/build.js';

const program = new Command();

program
  .name('rwr-build-index')
  .description('Build the graph index + search index from a RWR data directory (single- or multi-package)')
  .version('2.0.0')
  .option('-s, --source <path>', 'Data directory (a package, or a directory of packages)', config.dataDir)
  .option('-o, --output <path>', 'Output directory for the index files', config.outputDir)
  .option('--only <names>', 'Comma-separated package names to include (default: all discovered)')
  .parse();

async function main() {
  const options = program.opts();
  const only = typeof options.only === 'string' ? options.only.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
  const outputDir = path.resolve(options.output as string);

  await buildIndexes({
    dataDir: options.source as string,
    graphPath: path.join(outputDir, 'graph.json'),
    searchIndexPath: path.join(outputDir, 'search-index.json'),
    only,
    verbose: true,
  });
}

main().catch((err) => {
  console.error('Index build failed:', err);
  process.exit(1);
});
