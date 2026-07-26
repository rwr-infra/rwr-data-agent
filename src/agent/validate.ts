import * as path from 'path';
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
  const dataDir = path.resolve('./data');
  configureGraph(dataDir, path.resolve('./output/graph.json'));

  console.log('=== TOOL VALIDATION ===');

  await section('getInheritanceChain("base_primary_rare.weapon")', () =>
    getInheritanceChain('base_primary_rare.weapon'),
  );

  await section('getTransformChain("K309.carry_item")', async () => {
    const tc = await getTransformChain('K309.carry_item');
    return { length: tc.chain.length, chain: tc.chain.map((c) => c.key).join(' → ') };
  });

  await section('findReferences("vehicle_drop_script.projectile")', async () => {
    const refs = await findReferences('vehicle_drop_script.projectile');
    return { count: refs.referencedBy.length, referencedBy: refs.referencedBy };
  });

  await section('readSource("weapons/base_primary_rare.weapon")', () =>
    readSource('weapons/base_primary_rare.weapon'),
  );

  await section('listFiles("*.call", type=call, limit=5)', () => listFiles('*.call', 'call', 5));

  await section('getScriptSymbols("scripts/start_1.as")', () =>
    getScriptSymbols('scripts/start_1.as'),
  );

  await section('getNode("binoculars_aek999_spawn_fairy.weapon")', () =>
    getNode('binoculars_aek999_spawn_fairy.weapon'),
  );

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
