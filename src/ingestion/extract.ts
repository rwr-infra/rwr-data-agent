import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { collectFiles, parseFile } from './shared.js';
import { loadAllLanguages, resolveI18n } from './i18n.js';
import type { StructuredDocument } from '../types/index.js';

async function findLanguagesDir(sourceDir: string): Promise<string | undefined> {
  // Check source dir itself
  const direct = path.join(sourceDir, 'languages');
  try {
    await fs.access(direct);
    return direct;
  } catch {}

  // Check immediate subdirectories (e.g. data/GFL_Castling/languages)
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(sourceDir, entry.name, 'languages');
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
  }

  return undefined;
}

interface ExtractOutput {
  version: number;
  mod_name: string;
  source_dir: string;
  extracted_at: string;
  total_files: number;
  total_documents: number;
  languages: string[];
  documents: StructuredDocument[];
}

const program = new Command();

program
  .name('rwr-extract')
  .description('Extract RWR data files into a JSON file for review, then embed later')
  .version('1.0.0')
  .requiredOption('-s, --source <path>', 'Source directory containing data files')
  .requiredOption('-m, --mod <name>', 'Mod name to tag documents with')
  .option('-o, --output <path>', 'Output JSON file path', './extracted-documents.json')
  .option('-l, --languages <path>', 'Languages directory (default: <source>/languages)', '')
  .parse();

async function main() {
  const options = program.opts();
  const sourceDir = path.resolve(options.source);
  const modName = options.mod as string;
  const outputPath = path.resolve(options.output);
  const languagesDir = options.languages
    ? path.resolve(options.languages)
    : await findLanguagesDir(sourceDir);

  console.log(`Extracting from ${sourceDir} for mod "${modName}"...`);

  // Step 1: Load translations
  let langData: import('../types/index.js').LanguageData[] = [];
  if (languagesDir) {
    console.log(`Loading translations from ${languagesDir}...`);
    langData = await loadAllLanguages(languagesDir);
  } else {
    console.log('No languages directory found, skipping i18n resolution.');
  }
  const langNames = langData.map((l) => l.language);
  if (langData.length > 0) {
    console.log(`Loaded ${langData.length} language(s): ${langNames.join(', ')}`);
  }

  // Step 2: Parse all data files
  const files = await collectFiles(sourceDir);
  console.log(`Found ${files.length} files.`);

  const limit = pLimit(4);
  const parsedDocs: StructuredDocument[] = [];

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

  console.log(`Parsed ${parsedDocs.length} structured documents.`);

  // Step 3: Resolve i18n names
  if (langData.length > 0) {
    let resolved = 0;
    for (const doc of parsedDocs) {
      const i18n = resolveI18n(doc, langData);
      if (i18n) {
        doc.i18n = i18n;
        resolved++;
      }
    }
    console.log(`Resolved i18n names for ${resolved}/${parsedDocs.length} documents.`);
  }

  const output: ExtractOutput = {
    version: 2,
    mod_name: modName,
    source_dir: sourceDir,
    extracted_at: new Date().toISOString(),
    total_files: files.length,
    total_documents: parsedDocs.length,
    languages: langNames,
    documents: parsedDocs,
  };

  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Written ${parsedDocs.length} structured documents to ${outputPath}`);
  console.log('Extraction complete.');
}

main().catch((err) => {
  console.error('Extraction failed:', err);
  process.exit(1);
});