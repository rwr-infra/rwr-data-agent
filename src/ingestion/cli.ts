import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { parseXmlFile } from './xmlParser.js';
import { parseAngelScriptFile } from './asParser.js';
import { createEmbeddings } from './embeddings.js';
import { storeDocuments, clearModDocuments, getExistingKeys } from './store.js';
import { config } from '../config/index.js';
import type { RWRDocument } from '../types/index.js';

const BATCH_SIZE = config.ingestBatchSize;
const CONCURRENCY = config.ingestConcurrency;
const BATCH_DELAY_MS = 500; // delay between embedding batches to avoid rate limits

const SUPPORTED_EXTS = new Set(['.xml', '.as', '.call', '.character', '.ai', '.resources', '.models', '.name', '.text_lines', '.weapon', '.projectile']);
const EXCLUDED_DIRS = new Set(['models', 'maps']);

const program = new Command();

program
  .name('rwr-ingest')
  .description('Ingest RWR data files into the vector database')
  .version('1.0.0')
  .requiredOption('-s, --source <path>', 'Source directory containing data files')
  .requiredOption('-m, --mod <name>', 'Mod name to tag documents with')
  .option('--clear', 'Clear existing documents for this mod before ingestion', false)
  .option('--resume', 'Skip documents already present in the database for this mod', false)
  .parse();

async function main() {
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
  const parsedDocs: RWRDocument[] = [];

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          const docs = await parseFile(file, modName);
          for (const doc of docs) {
            const dedupKey = `${doc.type}:${doc.key}`;
            if (existingKeys.has(dedupKey)) {
              // Skip already-ingested documents in resume mode
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

  if (parsedDocs.length === 0) {
    console.log('Nothing new to ingest.');
    process.exit(0);
  }

  // Batch embeddings with delay between batches
  for (let i = 0; i < parsedDocs.length; i += BATCH_SIZE) {
    const batch = parsedDocs.slice(i, i + BATCH_SIZE);
    const contents = batch.map((d) => d.content);
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(parsedDocs.length / BATCH_SIZE)} (${batch.length} docs)...`);
    const embeddings = await createEmbeddings(contents);
    await storeDocuments(batch, embeddings);
    if (i + BATCH_SIZE < parsedDocs.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log('Ingestion complete.');
  process.exit(0);
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = path.join(entry.parentPath ?? dir, entry.name);
    const relativePath = path.relative(dir, fullPath);
    const pathParts = relativePath.split(path.sep);

    // Skip excluded directories (models/ and maps/ contain 3D assets and terrain, not game data)
    if (pathParts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_EXTS.has(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function parseFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  // XML-formatted files: .xml, .call, .character, .weapon, .projectile
  if (ext === '.xml' || ext === '.call' || ext === '.character' || ext === '.weapon' || ext === '.projectile') {
    return parseXmlFile(filePath, modName);
  }
  if (ext === '.as') {
    return parseAngelScriptFile(filePath, modName);
  }
  // Fallback for .ai, .resources, .models, .name, .text_lines: treat as plain text script chunks
  if (['.ai', '.resources', '.models', '.name', '.text_lines'].includes(ext)) {
    return parsePlainTextFile(filePath, modName);
  }
  return [];
}

async function parsePlainTextFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const base = path.basename(filePath);
  const ext = path.extname(filePath).slice(1);
  return [{
    doc_id: '',
    type: 'script_chunk' as const,
    key: base,
    content: `File: ${base} (type: ${ext})\n\n${content}`,
    metadata: {
      mod_name: modName,
      file_path: filePath,
      source_type: ext,
    },
  }];
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
