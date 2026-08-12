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
  /** A hit past its TTL is evicted and reported as a miss, so the TTL bounds reads too. */
  get(sessionId: string): T | undefined;
  /** Writing is also when the bulk sweep runs — see `createMemorySessionStore`. */
  set(sessionId: string, value: T): void;
  delete(sessionId: string): void;
  /** Live entry count. For health reporting and tests. */
  size(): number;
}

/**
 * `ttlMs` is measured from an entry's own `updatedAt`, and eviction runs at two moments.
 *
 * **On write**, as a bulk sweep: entries can only ever appear through `set`, so a write is the only
 * moment at which the map can have *grown*. An interval would be simpler to reason about but would
 * hold the event loop open on a process that is otherwise idle.
 *
 * **On read**, for the entry being read. The sweep alone bounds memory but not *retention*: on an
 * idle process, or one where a different session is the only writer, an entry past its TTL is still
 * there to be handed back. Since callers hold conversation content keyed by a client-minted session
 * id, "kept for `ttlMs` after its last update" has to hold for what is returned, not only for what
 * is stored — so a stale read expires the entry and reports a miss.
 */
export function createMemorySessionStore<T extends Timestamped>(ttlMs: number): SessionStore<T> {
  const entries = new Map<string, T>();

  return {
    get(sessionId) {
      const existing = entries.get(sessionId);
      if (!existing) return undefined;
      if (Date.now() - existing.updatedAt > ttlMs) {
        entries.delete(sessionId);
        return undefined;
      }
      return existing;
    },
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
