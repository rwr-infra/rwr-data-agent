import MiniSearch, { type Options } from 'minisearch';
import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import { collectFiles, parseFile } from '../ingestion/shared.js';
import { structuredDocToRWRDocument } from '../ingestion/xmlParser.js';
import { loadAllLanguages, resolveI18n } from '../ingestion/i18n.js';
import { discoverPackages, type DataPackage } from '../ingestion/packages.js';
import type { StructuredDocument, SearchResult, SearchFilters, DocumentType } from '../types/index.js';

export interface IndexEntry {
  id: string;
  key: string;
  type: string;
  name: string;
  content: string;
  /** Localized names (all languages, deduped) — makes Chinese queries hit. */
  i18nNames: string;
  file: string;
  faction: string;
  weaponClass: string;
  mod: string;
}

// CJK (plus kana/hangul) — scripts that are written without spaces, so MiniSearch's
// default whitespace/punctuation tokenizer would emit a whole phrase as one token.
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/** Fields where a CJK run is expanded into unigrams + bigrams. */
const CJK_FIELDS = new Set(['key', 'name', 'i18nNames', 'type']);

function splitPlain(text: string): string[] {
  return text.split(/[\n\r\p{Z}\p{P}\p{S}]+/u).filter(Boolean);
}

/**
 * Whitespace/punctuation split, then CJK runs are further broken into unigrams and
 * bigrams. Bigrams are what make multi-character Chinese terms ("伤害", "突击步枪")
 * match without a dictionary segmenter.
 *
 * Only applied to the short, high-signal fields (and to every query). Expanding
 * `content` too would drown real hits in noise from the large localized text blobs
 * (journal/ui/*.text_lines) that contain every Chinese character in the game.
 */
export function tokenize(text: string, fieldName?: string): string[] {
  if (fieldName !== undefined && !CJK_FIELDS.has(fieldName)) return splitPlain(text);

  const tokens: string[] = [];
  for (const chunk of splitPlain(text)) {
    if (!CJK_CHAR.test(chunk)) {
      tokens.push(chunk);
      continue;
    }
    // Split mixed strings like "AK47突击步枪" into latin and CJK runs.
    let last = 0;
    for (const match of chunk.matchAll(CJK_RUN)) {
      const start = match.index;
      if (start > last) tokens.push(chunk.slice(last, start));
      const chars = [...match[0]];
      for (const c of chars) tokens.push(c);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
      last = start + match[0].length;
    }
    if (last < chunk.length) tokens.push(chunk.slice(last));
  }
  return tokens;
}

const MINI_SEARCH_OPTIONS: Options<IndexEntry> = {
  fields: ['key', 'name', 'i18nNames', 'content', 'type'],
  storeFields: ['key', 'type', 'name', 'i18nNames', 'content', 'file', 'faction', 'weaponClass', 'mod'],
  tokenize,
  searchOptions: {
    boost: { key: 3, name: 2.5, i18nNames: 2.5, content: 1 },
    fuzzy: 0.2,
    prefix: true,
    combineWith: 'OR',
  },
};

const SEARCH_BOOST = { key: 3, name: 2.5, i18nNames: 2.5, content: 1 };

// Fuzzy/prefix matching on a single CJK character matches almost everything, so both
// are restricted to latin terms.
const isCjk = (term: string) => CJK_CHAR.test(term);
const SEARCH_OPTIONS = {
  fuzzy: (term: string) => (isCjk(term) ? false : 0.2),
  prefix: (term: string) => !isCjk(term),
  boost: SEARCH_BOOST,
};

export const INDEX_VERSION = 2;

export interface PackageSummary {
  name: string;
  displayName: string;
  count: number;
}

export interface IndexFingerprint {
  files: number;
  maxMtimeMs: number;
}

export interface IndexFile {
  version: number;
  built_at: string;
  data_dir: string;
  packages: PackageSummary[];
  fingerprint: IndexFingerprint;
  count: number;
  entries: IndexEntry[];
}

/** Everything about the loaded index except the entries themselves. */
export type IndexMeta = Omit<IndexFile, 'entries'>;

let indexCache: MiniSearch<IndexEntry> | null = null;
let metaCache: IndexMeta | null = null;
let indexPath = path.resolve('./output/search-index.json');

export function configureSearch(searchIndexPath: string): void {
  const resolved = path.resolve(searchIndexPath);
  if (resolved !== indexPath) {
    indexCache = null;
    metaCache = null;
  }
  indexPath = resolved;
}

/** Drop the in-process cache so the next search re-reads from disk (used after a rebuild). */
export function invalidateSearchIndex(): void {
  indexCache = null;
  metaCache = null;
}

/** Metadata of the loaded index, or null if nothing has been loaded yet. */
export function getIndexMeta(): IndexMeta | null {
  return metaCache;
}

// Only the languages users actually query in. Indexing all ten would dilute term
// frequencies, and several of the others ship as ISO-8859-1 which reads back mojibake.
const INDEXED_LANGUAGES = new Set(['cn', 'zh', 'zh_cn', 'zh-cn', 'chinese', 'en', 'english']);

function flattenI18n(i18n: StructuredDocument['i18n']): string {
  if (!i18n) return '';
  const seen = new Set<string>();
  for (const [lang, perLang] of Object.entries(i18n)) {
    if (!INDEXED_LANGUAGES.has(lang.toLowerCase())) continue;
    for (const value of Object.values(perLang)) {
      if (value) seen.add(value);
    }
  }
  return [...seen].join(' ');
}

async function fingerprintFiles(files: string[]): Promise<IndexFingerprint> {
  const limit = pLimit(32);
  let maxMtimeMs = 0;
  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
      }),
    ),
  );
  return { files: files.length, maxMtimeMs: Math.round(maxMtimeMs) };
}

/** Cheap staleness probe over the data root — same shape as the fingerprint stored in the index. */
export async function computeDataFingerprint(dataDir: string): Promise<IndexFingerprint> {
  const packages = await discoverPackages(dataDir);
  const all: string[] = [];
  for (const pkg of packages) {
    all.push(...(await collectFiles(pkg.dir)));
  }
  return fingerprintFiles(all);
}

async function buildPackageEntries(root: string, pkg: DataPackage): Promise<IndexEntry[]> {
  const files = await collectFiles(pkg.dir);
  const langData = await loadAllLanguages(path.join(pkg.dir, 'languages'));
  const limit = pLimit(8);
  const docs: StructuredDocument[] = [];

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          const parsed = await parseFile(file, pkg.name);
          docs.push(...parsed);
        } catch {
          // A single unparseable game file must not abort the package index build.
        }
      }),
    ),
  );

  if (langData.length > 0) {
    for (const doc of docs) {
      const i18n = resolveI18n(doc, langData);
      if (i18n) doc.i18n = i18n;
    }
  }

  return docs.map((doc, i) => {
    const rwr = structuredDocToRWRDocument(doc);
    const absFile = rwr.metadata.file_path ?? doc.source_file;
    return {
      id: `${pkg.name}:${doc.type}:${doc.key}:${i}`,
      key: doc.key,
      type: doc.type,
      name: (doc.metadata.name as string) ?? doc.key,
      content: rwr.content,
      i18nNames: flattenI18n(doc.i18n),
      // Relative to the data root, so it carries the package prefix and stays
      // resolvable against a single dataRoot in the agent's readSource tool.
      file: absFile ? path.relative(root, path.resolve(root, absFile)).replace(/\\/g, '/') : '',
      faction: (rwr.metadata.faction as string) ?? '',
      weaponClass: (rwr.metadata.weapon_class as string) ?? '',
      mod: pkg.name,
    };
  });
}

export interface BuildResult {
  index: MiniSearch<IndexEntry>;
  entries: IndexEntry[];
  packages: PackageSummary[];
  fingerprint: IndexFingerprint;
  count: number;
}

/** Build a MiniSearch index over every package found under `dataDir`. */
export async function buildSearchIndex(dataDir: string, packages?: DataPackage[]): Promise<BuildResult> {
  const root = path.resolve(dataDir);
  const pkgs = packages ?? (await discoverPackages(root));

  const entries: IndexEntry[] = [];
  const summaries: PackageSummary[] = [];
  const allFiles: string[] = [];

  for (const pkg of pkgs) {
    const pkgEntries = await buildPackageEntries(root, pkg);
    entries.push(...pkgEntries);
    summaries.push({ name: pkg.name, displayName: pkg.displayName, count: pkgEntries.length });
    allFiles.push(...(await collectFiles(pkg.dir)));
  }

  const index = new MiniSearch<IndexEntry>(MINI_SEARCH_OPTIONS);
  index.addAll(entries);

  return {
    index,
    entries,
    packages: summaries,
    fingerprint: await fingerprintFiles(allFiles),
    count: entries.length,
  };
}

/** Persist the index to JSON for fast startup reload. */
export async function saveSearchIndex(
  result: Pick<BuildResult, 'entries' | 'packages' | 'fingerprint' | 'count'>,
  dataDir: string,
  outputPath: string,
): Promise<void> {
  const outPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const data: IndexFile = {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    data_dir: path.resolve(dataDir),
    packages: result.packages,
    fingerprint: result.fingerprint,
    count: result.count,
    entries: result.entries,
  };
  await fs.writeFile(outPath, JSON.stringify(data), 'utf-8');
}

/** Read only the header of a persisted index (entries are dropped after parsing). */
export async function readIndexMeta(searchIndexPath = indexPath): Promise<IndexMeta | null> {
  try {
    const raw = await fs.readFile(path.resolve(searchIndexPath), 'utf-8');
    const { entries: _entries, ...meta } = JSON.parse(raw) as IndexFile;
    return meta;
  } catch {
    return null;
  }
}

/** Load the search index into memory (process-lifetime singleton). */
async function loadIndex(): Promise<MiniSearch<IndexEntry>> {
  if (indexCache) return indexCache;

  let data: IndexFile;
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    data = JSON.parse(raw) as IndexFile;
  } catch {
    throw new Error(`Search index not found at ${indexPath}. Run "npm run build:index" first.`);
  }

  if (data.version !== INDEX_VERSION) {
    throw new Error(
      `Search index at ${indexPath} is version ${data.version}, expected ${INDEX_VERSION}. Run "npm run build:index" to rebuild.`,
    );
  }

  const index = new MiniSearch<IndexEntry>(MINI_SEARCH_OPTIONS);
  index.addAll(data.entries);
  indexCache = index;
  const { entries: _entries, ...meta } = data;
  metaCache = meta;
  console.log(
    `[localSearch] Loaded ${data.count} documents from ${data.packages.length} package(s): ${data.packages
      .map((p) => p.name)
      .join(', ')}`,
  );

  return indexCache;
}

/** Force the index into memory — used by the startup bootstrap so the first query is warm. */
export async function warmSearchIndex(): Promise<IndexMeta | null> {
  await loadIndex();
  return metaCache;
}

function applyFilters<T extends { type: string; faction: string; weaponClass: string; mod: string }>(
  results: T[],
  filters: SearchFilters,
): T[] {
  let out = results;
  if (filters.type) out = out.filter((r) => r.type === filters.type);
  if (filters.faction) out = out.filter((r) => r.faction === filters.faction);
  if (filters.weapon_class) out = out.filter((r) => r.weaponClass === filters.weapon_class);
  if (filters.mod_name) out = out.filter((r) => r.mod === filters.mod_name);
  return out;
}

/** Extract entity-like tokens (alphanumeric identifiers like "M4A1", "g36", "ak47") from a query. */
function extractEntityTokens(query: string): string[] {
  const tokens = query.match(/[a-zA-Z][a-zA-Z0-9_-]{1,}/g) ?? [];
  const stopWords = new Set(['weapon', 'the', 'and', 'for', 'with', 'list', 'all', 'data']);
  return tokens
    .filter((t) => !stopWords.has(t.toLowerCase()) && t.length >= 2)
    .slice(0, 5);
}

export async function search(
  query: string,
  filters: SearchFilters = {},
  topK = 60,
  searchQuery?: string,
  offset = 0,
): Promise<SearchResult[]> {
  const index = await loadIndex();
  const effectiveQuery = (searchQuery ?? query).trim();
  if (!effectiveQuery) return [];

  // --- Entity pinning: extract alphanumeric tokens (M4A1, G36, etc.) and search
  // them against key/name fields only, then pin those results at the top. This
  // prevents high-frequency CJK content terms ("武器") from drowning exact
  // key/name matches.
  //
  // Tokens come from the ORIGINAL query, not the enriched one. The enriched query
  // prepends entity keys from earlier turns, and those tokens would (a) fill the
  // 5-token cap in extractEntityTokens so the current question's own entity never
  // makes it in, and (b) match nothing once combined — asking about AK47 after a
  // turn about M1 pinned neither. ---
  const entityTokens = extractEntityTokens(query.trim() || effectiveQuery);
  const pinnedIds = new Set<string>();
  const pinnedResults: (IndexEntry & { id: string; score: number })[] = [];

  if (entityTokens.length > 0) {
    // One search per token rather than one AND search over all of them: a query that
    // names two entities ("M4A1 vs G36") has no document matching both, so AND pins
    // nothing at all.
    const PIN_PER_TOKEN = 8;
    const PIN_TOTAL = 20;

    for (const token of entityTokens) {
      const entityHits = index.search(token, {
        fields: ['key', 'name'],
        boost: { key: 10, name: 8 },
        fuzzy: 0.2,
        prefix: true,
      }) as unknown as (IndexEntry & { id: string; score: number })[];

      for (const hit of entityHits.slice(0, PIN_PER_TOKEN)) {
        if (pinnedIds.has(hit.id)) continue;
        pinnedIds.add(hit.id);
        pinnedResults.push({ ...hit, score: hit.score * 5 });
      }
    }

    pinnedResults.sort((a, b) => b.score - a.score);
    if (pinnedResults.length > PIN_TOTAL) {
      pinnedResults.length = PIN_TOTAL;
      // Rebuild the id set so the dropped entries can still surface through the
      // full-text pass instead of being filtered out of both.
      pinnedIds.clear();
      for (const p of pinnedResults) pinnedIds.add(p.id);
    }
  }

  // --- Full-text search for everything else ---
  const fullResults = index.search(effectiveQuery, SEARCH_OPTIONS) as unknown as (IndexEntry & {
    id: string;
    score: number;
  })[];

  // Merge: pinned results first, then full-text (minus already-pinned)
  const merged = [...pinnedResults];
  for (const r of fullResults) {
    if (!pinnedIds.has(r.id)) merged.push(r);
  }

  return applyFilters(merged, filters)
    .slice(offset, offset + topK)
    .map((r) => ({
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
}

/** Fast exact-key lookup — bypasses fuzzy/prefix matching for `key=` queries. */
export async function exactKeySearch(key: string, filters: SearchFilters = {}): Promise<SearchResult[]> {
  const index = await loadIndex();
  const lowerKey = key.toLowerCase();
  const matches = index.search(lowerKey, { fuzzy: 0, prefix: false, boost: { key: 10 } }) as unknown as (IndexEntry & {
    id: string;
  })[];

  const filtered = applyFilters(
    matches.filter((r) => r.key.toLowerCase() === lowerKey || r.key.toLowerCase().includes(lowerKey)),
    filters,
  );

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
