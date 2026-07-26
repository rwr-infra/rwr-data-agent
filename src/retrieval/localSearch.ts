import MiniSearch, { type Options } from 'minisearch';
import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { collectFiles, parseFile } from '../ingestion/shared.js';
import { structuredDocToRWRDocument } from '../ingestion/xmlParser.js';
import type { StructuredDocument, SearchResult, SearchFilters, DocumentType } from '../types/index.js';

export interface IndexEntry {
  id: string;
  key: string;
  type: string;
  name: string;
  content: string;
  file: string;
  faction: string;
  weaponClass: string;
  mod: string;
}

const MINI_SEARCH_OPTIONS: Options<IndexEntry> = {
  fields: ['key', 'name', 'content', 'type'],
  storeFields: ['key', 'type', 'name', 'content', 'file', 'faction', 'weaponClass', 'mod'],
  searchOptions: {
    boost: { key: 3, name: 2.5, content: 1 },
    fuzzy: 0.2,
    prefix: true,
    combineWith: 'OR',
  },
};

let indexCache: MiniSearch<IndexEntry> | null = null;
let indexPath = '';

interface IndexFile {
  version: number;
  built_at: string;
  count: number;
  entries: IndexEntry[];
}

function configureSearch(dataDir?: string, gPath?: string): void {
  indexPath = gPath ?? path.resolve('./output/search-index.json');
}

/** Build a MiniSearch index from data files. Returns the index + entry count. */
export async function buildSearchIndex(
  sourceDir: string,
  modName: string,
  existingFiles?: string[],
): Promise<{
  index: MiniSearch<IndexEntry>;
  count: number;
  entries: IndexEntry[];
}> {
  const files = existingFiles ?? await collectFiles(sourceDir);
  const limit = pLimit(8);
  const docs: StructuredDocument[] = [];

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          const parsed = await parseFile(file, modName);
          docs.push(...parsed);
        } catch {}
      }),
    ),
  );

  const entries: IndexEntry[] = docs.map((doc, i) => {
    const rwr = structuredDocToRWRDocument(doc);
    return {
      id: `${doc.type}:${doc.key}:${i}`,
      key: doc.key,
      type: doc.type,
      name: (doc.metadata.name as string) ?? doc.key,
      content: rwr.content,
      file: (rwr.metadata.file_path as string) ?? '',
      faction: (rwr.metadata.faction as string) ?? '',
      weaponClass: (rwr.metadata.weapon_class as string) ?? '',
      mod: doc.mod_name,
    };
  });

  const index = new MiniSearch<IndexEntry>(MINI_SEARCH_OPTIONS);

  index.addAll(entries);
  return { index, count: entries.length, entries };
}

/** Persist index entries to JSON for fast startup reload. */
export async function saveSearchIndex(entries: IndexEntry[], outputPath?: string): Promise<void> {
  const outPath = outputPath ?? path.resolve('./output/search-index.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const data: IndexFile = {
    version: 1,
    built_at: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  await fs.writeFile(outPath, JSON.stringify(data), 'utf-8');
}

/** Load (or lazily build) the search index into memory. */
async function loadIndex(): Promise<MiniSearch<IndexEntry>> {
  if (indexCache) return indexCache;

  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const data = JSON.parse(raw) as IndexFile;
    const index = new MiniSearch<IndexEntry>(MINI_SEARCH_OPTIONS);
    index.addAll(data.entries);
    indexCache = index;
    console.log(`[localSearch] Loaded ${data.count} documents from ${indexPath}`);
  } catch {
    throw new Error(`Search index not found at ${indexPath}. Run "npm run build:graph" first.`);
  }

  return indexCache;
}

export { configureSearch };

/** Drop-in replacement for the old search() function. Returns SearchResult[] compatible with chat.ts. */
export async function search(
  query: string,
  filters: SearchFilters = {},
  topK = 60,
  _table?: string,
  searchQuery?: string,
  offset = 0,
): Promise<SearchResult[]> {
  const index = await loadIndex();
  const effectiveQuery = searchQuery ?? query;

  // Split on whitespace only — let MiniSearch's tokenizer handle CJK and other Unicode.
  const terms = effectiveQuery.split(/\s+/).filter((t) => t.length >= 1);

  if (terms.length === 0) return [];

  const results = index.search(terms.join(' '), {
    fuzzy: 0.2,
    prefix: true,
    boost: { key: 3, name: 2.5, content: 1 },
  });

  // Apply type filter
  let filtered = results;
  if (filters.type) {
    filtered = filtered.filter((r) => r.type === filters.type);
  }
  if (filters.faction) {
    filtered = filtered.filter((r) => r.faction === filters.faction);
  }
  if (filters.weapon_class) {
    filtered = filtered.filter((r) => r.weaponClass === filters.weapon_class);
  }

  // Convert to SearchResult format (compatible with chat.ts / prompt.ts)
  const searchResults: SearchResult[] = filtered.slice(offset, offset + topK).map((r) => ({
    doc_id: r.id,
    type: r.type as DocumentType,
    key: r.key,
    content: r.content,
    metadata: {
      mod_name: r.mod,
      file_path: r.file,
      faction: r.faction || undefined,
      weapon_class: r.weaponClass || undefined,
    },
    distance: 1 - (r.score ?? 0),
    score: r.score,
    source: 'local-index',
  }));

  return searchResults;
}

/** Fast exact-key lookup — bypasses full-text search for key= queries. */
export async function exactKeySearch(key: string, filters: SearchFilters = {}): Promise<SearchResult[]> {
  const index = await loadIndex();
  const lowerKey = key.toLowerCase();
  const matches = index.search(lowerKey, { fuzzy: 0, prefix: false, boost: { key: 10 } });

  let filtered = matches.filter((r) => r.key.toLowerCase() === lowerKey || r.key.toLowerCase().includes(lowerKey));
  if (filters.type) filtered = filtered.filter((r) => r.type === filters.type);

  return filtered.slice(0, 10).map((r) => ({
    doc_id: r.id,
    type: r.type as DocumentType,
    key: r.key,
    content: r.content,
    metadata: { mod_name: r.mod, file_path: r.file },
    distance: 0,
    score: 1,
    source: 'exact-key',
  }));
}
