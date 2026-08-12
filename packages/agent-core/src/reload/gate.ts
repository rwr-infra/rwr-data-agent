/**
 * Staleness bookkeeping for a cache rebuilt from something outside the process — a directory of
 * plugin files, a directory of skill playbooks.
 *
 * The naive version is a `dirty` boolean: a watcher sets it, the loader clears it. That breaks as
 * soon as two loads can overlap, which they can — any two concurrent requests, plus endpoints that
 * force a load of their own. Whichever loader *started* first may finish last, and it then publishes
 * the pre-change data over the newer data while the flag reads clean, so nothing ever reloads it
 * again. Silent, and permanent until the source happens to change a second time.
 *
 * So the counter here counts **changes to the source**, and a load carries the generation it read.
 * Two loads racing with no change between them share a generation and both publish the same thing;
 * a load straddling a change cannot publish at all.
 *
 * Counting *load attempts* instead would also close the overwrite, and introduce a worse bug: two
 * overlapping loads with no change between them would make the first refuse to publish and leave the
 * cache empty, for a conflict that never existed.
 *
 * Deliberately free of I/O and of any notion of what is being cached — that is what makes the
 * ordering guarantee testable without a filesystem or a clock.
 */
export interface ReloadGate {
  /** Record that the source changed. */
  invalidate(): void;
  /** Whether the cache no longer reflects the source. */
  isStale(): boolean;
  /** Capture the generation a load is about to read. Hand it back to `publish`. */
  begin(): number;
  /**
   * Whether a load that began at `generation` may publish: true when the source has not changed
   * since, and the cache is then marked current. A `false` return is not an error — the caller still
   * has usable, if slightly old, data to answer its own request with. It just must not cache it.
   */
  publish(generation: number): boolean;
}

export function createReloadGate(): ReloadGate {
  let generation = 0;
  // Behind generation 0, so a gate starts stale and the first read triggers a load.
  let published = -1;

  return {
    invalidate() {
      generation++;
    },
    isStale: () => published !== generation,
    begin: () => generation,
    publish(loadingGeneration) {
      if (loadingGeneration !== generation) return false;
      published = loadingGeneration;
      return true;
    },
  };
}
