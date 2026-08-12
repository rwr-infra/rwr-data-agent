/**
 * A keyed store for per-session state, with eviction.
 *
 * The eviction is the whole reason this exists. Session ids are minted by the client, one per
 * conversation, and the server is never told when one is abandoned — so a plain `Map` grows for the
 * life of the process, one entry per conversation anyone ever started. That is a leak on a
 * long-lived server, and it is the kind that only shows up in production.
 *
 * In-memory and therefore **process-local**: behind more than one replica each replica keeps its
 * own view. That is the same constraint the steering registry carries, and it is why the interface
 * is separated from this implementation — a persistent backend slots in behind it without the
 * callers changing.
 */

/** State this store can hold. `updatedAt` is what eviction reads, so the caller owns freshness. */
export interface Timestamped {
  updatedAt: number;
}

export interface SessionStore<T extends Timestamped> {
  get(sessionId: string): T | undefined;
  /** Writing is also when the sweep runs — see `createMemorySessionStore`. */
  set(sessionId: string, value: T): void;
  delete(sessionId: string): void;
  /** Live entry count. For health reporting and tests. */
  size(): number;
}

/**
 * `ttlMs` is measured from an entry's own `updatedAt`, and the sweep is **lazy — on write**.
 *
 * An interval would be simpler to reason about but would hold the event loop open on a process
 * that is otherwise idle, and entries can only ever appear through `set`, so a write is the only
 * moment at which the map can have grown.
 */
export function createMemorySessionStore<T extends Timestamped>(ttlMs: number): SessionStore<T> {
  const entries = new Map<string, T>();

  return {
    get: (sessionId) => entries.get(sessionId),
    set(sessionId, value) {
      for (const [id, existing] of entries) {
        if (value.updatedAt - existing.updatedAt > ttlMs) entries.delete(id);
      }
      entries.set(sessionId, value);
    },
    delete: (sessionId) => {
      entries.delete(sessionId);
    },
    size: () => entries.size,
  };
}
