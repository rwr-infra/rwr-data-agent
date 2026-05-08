import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createEmbeddings } from './embeddings.js';
import { storeDocuments, clearModDocuments, getExistingKeys, dropAndRecreateTable } from './store.js';
import { chunkDocuments } from './chunker.js';
import { structuredDocToRWRDocument } from './xmlParser.js';
import { runMigrate } from '../db/migrate.js';
import { config, validateConfig } from '../config/index.js';
import { resetPool } from '../db/index.js';
import type { StructuredDocument, RWRDocument } from '../types/index.js';

interface ExtractOutput {
  version: number;
  mod_name: string;
  source_dir: string;
  extracted_at: string;
  total_files: number;
  total_documents: number;
  total_chunks: number;
  documents: StructuredDocument[];
}

const BATCH_SIZE = config.ingestBatchSize;
const BATCH_DELAY_MS = 500;

const program = new Command();

program
  .name('rwr-embed')
  .description('Read extracted JSON and embed documents into the vector database')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'Input JSON file from rwr-extract')
  .option('--clear', 'Clear existing documents for this mod before embedding', false)
  .option('--drop', 'Drop and recreate the table before embedding (full reset)', false)
  .option('--resume', 'Skip documents already present in the database', false)
  .option('--filter-type <type>', 'Only embed documents of this type (e.g. weapon, soldier)', '')
  .option('--limit <number>', 'Only embed the first N documents (for testing)', '0')
  .parse();

async function main() {
  validateConfig();
  const options = program.opts();
  const inputPath = path.resolve(options.input);

  console.log(`Reading extracted documents from ${inputPath}...`);
  const raw = await fs.readFile(inputPath, 'utf-8');
  const data: ExtractOutput = JSON.parse(raw);

  let docs = data.documents;
  const modName = data.mod_name;

  console.log(`Loaded ${docs.length} structured documents for mod "${modName}" (extracted at ${data.extracted_at}).`);

  if (options.filterType) {
    docs = docs.filter((d) => d.type === options.filterType);
    console.log(`Filtered to type "${options.filterType}": ${docs.length} documents.`);
  }

  const limit = parseInt(options.limit, 10);
  if (limit > 0) {
    docs = docs.slice(0, limit);
    console.log(`Limited to first ${limit} documents.`);
  }

  if (options.drop) {
    console.log('Dropping and recreating table...');
    await dropAndRecreateTable();
    resetPool();
    console.log('Running migration to recreate table with indexes...');
    await runMigrate();
  } else if (options.clear) {
    console.log(`Clearing existing documents for mod "${modName}"...`);
    await clearModDocuments(modName);
  }

  let existingKeys = new Set<string>();
  if (options.resume) {
    console.log('Fetching existing document keys from database...');
    existingKeys = await getExistingKeys(modName);
    console.log(`Found ${existingKeys.size} existing documents.`);
  }

  if (existingKeys.size > 0) {
    const before = docs.length;
    docs = docs.filter((d) => !existingKeys.has(`${d.type}:${d.key}`));
    console.log(`Skipped ${before - docs.length} already-ingested documents.`);
  }

  if (docs.length === 0) {
    console.log('Nothing new to embed.');
    process.exit(0);
  }

  const rwrDocs: RWRDocument[] = docs.map(structuredDocToRWRDocument);
  const chunkedDocs = chunkDocuments(rwrDocs);

  if (chunkedDocs.length !== rwrDocs.length) {
    console.log(`Chunked into ${chunkedDocs.length} embedding segments (from ${rwrDocs.length} documents).`);
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

  console.log(`Embedding complete. Stored ${chunkedDocs.length} chunks from ${docs.length} documents.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Embedding failed:', err);
  process.exit(1);
});