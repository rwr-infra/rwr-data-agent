import { config } from '../config/index.js';
import { MemoryCache } from './memory.js';
import { PostgresCache, generateCacheKey } from './postgres.js';
import type { SearchResult } from '../types/index.js';

export { generateCacheKey } from './postgres.js';

export interface SearchCacheEntry {
  results: SearchResult[];
}

const DEFAULT_L1_MAX = 500;
const DEFAULT_L1_TTL = 10 * 60 * 1000; // 10 minutes
const DEFAULT_L2_TTL = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_EMBEDDING_MAX = 1000;
const DEFAULT_EMBEDDING_TTL = 60 * 60 * 1000; // 1 hour

let searchL1: MemoryCache<SearchResult[]> | null = null;
let searchL2: PostgresCache | null = null;
let embeddingCache: MemoryCache<number[]> | null = null;

function getSearchL1(): MemoryCache<SearchResult[]> {
  if (!searchL1) {
    searchL1 = new MemoryCache<SearchResult[]>(
      DEFAULT_L1_MAX,
      config.cacheTtlSeconds > 0 ? config.cacheTtlSeconds * 1000 : DEFAULT_L1_TTL,
    );
  }
  return searchL1;
}

function getSearchL2(): PostgresCache {
  if (!searchL2) {
    searchL2 = new PostgresCache(DEFAULT_L2_TTL);
  }
  return searchL2;
}

function getEmbeddingCache(): MemoryCache<number[]> {
  if (!embeddingCache) {
    embeddingCache = new MemoryCache<number[]>(DEFAULT_EMBEDDING_MAX, DEFAULT_EMBEDDING_TTL);
  }
  return embeddingCache;
}

export function isCacheEnabled(): boolean {
  return config.cacheEnabled;
}

export async function getCachedSearch(key: string): Promise<SearchResult[] | null> {
  if (!isCacheEnabled()) return null;

  const l1 = getSearchL1();
  const hit = l1.get(key);
  if (hit) return hit;

  try {
    const l2 = getSearchL2();
    const l2Hit = await l2.get(key);
    if (l2Hit) {
      l1.set(key, l2Hit);
      return l2Hit;
    }
  } catch (err) {
    console.warn('[cache] L2 read failed:', (err as Error).message);
  }

  return null;
}

export async function setCachedSearch(key: string, query: string, results: SearchResult[]): Promise<void> {
  if (!isCacheEnabled()) return;

  const l1 = getSearchL1();
  l1.set(key, results);

  try {
    const l2 = getSearchL2();
    await l2.set(key, query, results);
  } catch (err) {
    console.warn('[cache] L2 write failed:', (err as Error).message);
  }
}

export function getCachedEmbedding(key: string): number[] | undefined {
  if (!isCacheEnabled()) return undefined;
  return getEmbeddingCache().get(key);
}

export function setCachedEmbedding(key: string, embedding: number[]): void {
  if (!isCacheEnabled()) return;
  getEmbeddingCache().set(key, embedding);
}
