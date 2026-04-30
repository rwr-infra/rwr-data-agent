import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { parseXmlFile } from './xmlParser.js';
import { parseAngelScriptFile } from './asParser.js';
import { createEmbeddings } from './embeddings.js';
import { storeDocuments, clearModDocuments } from './store.js';
import type { RWRDocument } from '../types/index.js';

const BATCH_SIZE = 32;
const CONCURRENCY = 4;

const program = new Command();

program
  .name('rwr-ingest')
  .description('Ingest RWR data files into the vector database')
  .version('1.0.0');

program
  .command('ingest')
  .description('Ingest data from source directory')
  .requiredOption('-s, --source <path>', 'Source directory containing data files')
  .requiredOption('-m, --mod <name>', 'Mod name to tag documents with')
  .option('--clear', 'Clear existing documents for this mod before ingestion', false)
  .action(async (options) => {
    const sourceDir = path.resolve(options.source);
    const modName = options.mod;
    console.log(`Ingesting from ${sourceDir} for mod "${modName}"...`);

    if (options.clear) {
      console.log(`Clearing existing documents for mod "${modName}"...`);
      await clearModDocuments(modName);
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
            parsedDocs.push(...docs);
          } catch (err) {
            console.error(`Failed to parse ${file}:`, (err as Error).message);
          }
        })
      )
    );

    console.log(`Parsed ${parsedDocs.length} documents.`);

    // Batch embeddings
    for (let i = 0; i < parsedDocs.length; i += BATCH_SIZE) {
      const batch = parsedDocs.slice(i, i + BATCH_SIZE);
      const contents = batch.map((d) => d.content);
      console.log(`Embedding batch ${i / BATCH_SIZE + 1} / ${Math.ceil(parsedDocs.length / BATCH_SIZE)}...`);
      const embeddings = await createEmbeddings(contents);
      await storeDocuments(batch, embeddings);
    }

    console.log('Ingestion complete.');
    process.exit(0);
  });

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.xml' || ext === '.as') {
        files.push(path.join(entry.parentPath ?? dir, entry.name));
      }
    }
  }
  return files;
}

async function parseFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xml') return parseXmlFile(filePath, modName);
  if (ext === '.as') return parseAngelScriptFile(filePath, modName);
  return [];
}

program.parse();
