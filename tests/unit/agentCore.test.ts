import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, createMemorySessionStore, encodeEvent } from '@rwr/agent-core';

/**
 * Tests the package through its published entry point rather than by reaching into `src/` — the
 * export surface in `index.ts` is the thing external consumers get, so it is the thing worth
 * pinning. A symbol that stops being exported should break a test, not just a build somewhere else.
 */

describe('session store', () => {
  const HOUR = 60 * 60_000;
  const at = (updatedAt: number) => ({ updatedAt, note: `t${updatedAt}` });

  it('round-trips and deletes', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    store.set('a', at(1000));
    expect(store.get('a')?.note).toBe('t1000');
    expect(store.size()).toBe(1);

    store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  /**
   * The eviction is the reason this exists. Session ids come from the client, one per conversation,
   * and nothing ever tells the server a conversation was abandoned — a plain Map grows forever.
   */
  it('evicts past the TTL, measured from each entry own timestamp', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    const now = 10 * HOUR;

    store.set('stale', at(now - 3 * HOUR));
    store.set('recent', at(now - 0.5 * HOUR));
    // The sweep runs on write, keyed off the incoming entry's timestamp.
    store.set('fresh', at(now));

    expect(store.get('stale')).toBeUndefined();
    expect(store.get('recent')).toBeDefined();
    expect(store.get('fresh')).toBeDefined();
  });

  it('does not evict on read', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    store.set('old', at(0));
    expect(store.get('old')).toBeDefined();
    expect(store.get('old')).toBeDefined();
  });

  it('keeps stores independent', () => {
    const a = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    const b = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    a.set('k', at(1));
    expect(b.get('k')).toBeUndefined();
  });
});

describe('transport', () => {
  // Newline-delimited is the whole format; a missing one silently merges two events into a line
  // no consumer can parse.
  it('encodes one event per line, newline included', () => {
    const line = encodeEvent({ type: 'turn-start', turnId: 'abc', protocolVersion: '1.1' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({
      type: 'turn-start',
      turnId: 'abc',
      protocolVersion: '1.1',
    });
  });

  // The protocol is open to domain extensions (RWR adds best-of-N candidate frames), so the encoder
  // must not be limited to the core union.
  it('accepts an event type the core does not know about', () => {
    const line = encodeEvent({ type: 'candidate-open', candidate: 2, total: 3 });
    expect(JSON.parse(line)).toEqual({ type: 'candidate-open', candidate: 2, total: 3 });
  });

  it('publishes a parseable version', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
