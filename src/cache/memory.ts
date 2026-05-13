import { LRUCache } from 'lru-cache';

export class MemoryCache<T extends {}> {
  private cache: LRUCache<string, T>;

  constructor(max: number, ttlMs: number) {
    this.cache = new LRUCache<string, T>({ max, ttl: ttlMs });
  }

  get(key: string): T | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
