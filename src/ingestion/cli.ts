import { Command } from 'commander';
import * as path from 'path';
import pLimit from 'p-limit';
import { collectFiles, parseFile } from './shared.js';
import { createEmbeddings } from './embeddings.js';
import { storeDocuments, clearModDocuments, getExistingKeys } from './store.js';
import { chunkDocuments } from './chunker.js';
import { structuredDocToRWRDocument } from './xmlParser.js';
import { config, validateConfig } from '../config/index.js';

const BATCH_SIZE = config.ingestBatchSize;
const CONCURRENCY = config.ingestConcurrency;
const BATCH_DELAY_MS = 500;

const program = new Command();

program
  .name('rwr-ingest')
  .description('Ingest RWR data files into the vector database (extract + embed in one step)')
  .version('1.0.0')
  .requiredOption('-s, --source <path>', 'Source directory containing data files')
  .requiredOption('-m, --mod <name>', 'Mod name to tag documents with')
  .option('--clear', 'Clear existing documents for this mod before ingestion', false)
  .option('--resume', 'Skip documents already present in the database for this mod', false)
  .parse();

async function main() {
  validateConfig();
  const options = program.opts();
  const sourceDir = path.resolve(options.source);
  const modName = options.mod;
  console.log(`Ingesting from ${sourceDir} for mod "${modName}"...`);

  if (options.clear) {
    console.log(`Clearing existing documents for mod "${modName}"...`);
    await clearModDocuments(modName);
  }

  let existingKeys = new Set<string>();
  if (options.resume) {
    console.log('Fetching existing document keys from database...');
    existingKeys = await getExistingKeys(modName);
    console.log(`Found ${existingKeys.size} existing documents.`);
  }

  const files = await collectFiles(sourceDir);
  console.log(`Found ${files.length} files.`);

  const limit = pLimit(CONCURRENCY);
  const parsedDocs: import('../types/index.js').StructuredDocument[] = [];

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          const docs = await parseFile(file, modName);
          for (const doc of docs) {
            const dedupKey = `${doc.type}:${doc.key}`;
            if (existingKeys.has(dedupKey)) {
              continue;
            }
            parsedDocs.push(doc);
          }
        } catch (err) {
          console.error(`Failed to parse ${file}:`, (err as Error).message);
        }
      })
    )
  );

  console.log(`Parsed ${parsedDocs.length} new documents.`);

  const rwrDocs = parsedDocs.map(structuredDocToRWRDocument);
  const chunkedDocs = chunkDocuments(rwrDocs);
  if (chunkedDocs.length !== rwrDocs.length) {
    console.log(`Chunked into ${chunkedDocs.length} segments (from ${rwrDocs.length} documents).`);
  }

  if (chunkedDocs.length === 0) {
    console.log('Nothing new to ingest.');
    process.exit(0);
  }

  for (let i = 0; i < chunkedDocs.length; i += BATCH_SIZE) {
    const batch = chunkedDocs.slice(i, i + BATCH_SIZE);
    const contents = batch.map((d) => d.content);
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(chunkedDocs.length / BATCH_SIZE)} (${batch.length} docs)...`);
    const embeddings = await createEmbeddings(contents);
    await storeDocuments(batch, embeddings);
    if (i + BATCH_SIZE < chunkedDocs.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log('Ingestion complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});