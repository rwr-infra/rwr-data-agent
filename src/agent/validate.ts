import * as fs from 'fs/promises';
import { config } from '../config/index.js';
import type { RwrGraph } from './types.js';
import {
  configureGraph,
  getInheritanceChain,
  getTransformChain,
  findReferences,
  readSource,
  listFiles,
  getScriptSymbols,
  getNode,
} from './tools.js';

async function section(title: string, fn: () => Promise<unknown>) {
  console.log(`\n--- ${title} ---`);
  try {
    const result = await fn();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`FAIL: ${(err as Error).message}`);
  }
}

async function main() {
  configureGraph(config.dataDir, config.graphPath);

  const graph = JSON.parse(await fs.readFile(config.graphPath, 'utf-8')) as RwrGraph;
  console.log('=== TOOL VALIDATION ===');
  console.log(`data dir : ${config.dataDir}`);
  console.log(`graph    : ${config.graphPath}`);
  console.log(`packages : ${graph.packages.map((p) => p.name).join(', ')}`);
  console.log(`nodes    : ${graph.stats.nodes}, edges: ${graph.stats.edges}`);

  // Pick real samples out of the graph so this stays valid for any data directory.
  const extendsEdge = graph.edges.find((e) => e.rel === 'extends');
  const transformEdge = graph.edges.find((e) => e.rel === 'transforms_to');
  const firesEdge = graph.edges.find((e) => e.rel === 'fires');
  const weaponNode = graph.nodes.find((n) => n.type === 'weapon');
  const scriptNode = graph.nodes.find((n) => n.type === 'script');

  if (extendsEdge) {
    await section(`getInheritanceChain("${extendsEdge.from}")`, () =>
      getInheritanceChain(extendsEdge.from),
    );
  }

  if (transformEdge) {
    await section(`getTransformChain("${transformEdge.from}")`, async () => {
      const tc = await getTransformChain(transformEdge.from);
      return { length: tc.chain.length, chain: tc.chain.map((c) => c.key).join(' → ') };
    });
  }

  if (firesEdge) {
    await section(`findReferences("${firesEdge.to}")`, async () => {
      const refs = await findReferences(firesEdge.to);
      return { count: refs.referencedBy.length, referencedBy: refs.referencedBy.slice(0, 10) };
    });
  }

  if (weaponNode) {
    await section(`readSource("${weaponNode.file}")`, () => readSource(weaponNode.file, 1, 20));
    await section(`getNode("${weaponNode.key}")`, () => getNode(weaponNode.key));
  }

  await section('listFiles("*.call", type=call, limit=5)', () => listFiles('*.call', 'call', 5));

  if (scriptNode) {
    await section(`getScriptSymbols("${scriptNode.file}")`, () =>
      getScriptSymbols(scriptNode.file),
    );
  }

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
