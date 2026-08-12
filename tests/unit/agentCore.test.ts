import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, createMemorySessionStore, encodeEvent } from '@rwr/agent-core';

/**
 * Tests the package through its published entry point rather than by reaching into `src/` — the
 * export surface in `index.ts` is the thing external consumers get, so it is the thing worth
 * pinning. A symbol that stops being exported should break a test, not just a build somewhere else.
 */

describe('session store', () => {
  const HOUR = 60 * 60_000;
  /**
   * Ages are relative to the wall clock, not absolute like `at(1000)`, because the read path
   * compares against `Date.now()` — a literal timestamp would be hours stale the moment it is
   * written and every entry would read as expired.
   */
  const aged = (agoMs: number) => ({ updatedAt: Date.now() - agoMs, note: `age${agoMs}` });

  it('round-trips and deletes', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    store.set('a', aged(0));
    expect(store.get('a')?.note).toBe('age0');
    expect(store.size()).toBe(1);

    store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  /**
   * The eviction is the reason this exists. Session ids come from the client, one per conversation,
   * and nothing ever tells the server a conversation was abandoned — a plain Map grows forever.
   *
   * Asserted through `size()`, not `get()`: `get` expires stale entries itself, so it would pass
   * whether or not the write ever swept. Only the count can tell the two apart.
   */
  it('sweeps entries past the TTL on write', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);

    store.set('stale', aged(3 * HOUR));
    expect(store.size()).toBe(1);

    // Keyed off the *incoming* entry's timestamp, so this write is already 2.5h past `stale` and
    // sweeps it — the count stays at one rather than growing to two.
    store.set('recent', aged(0.5 * HOUR));
    expect(store.size()).toBe(1);

    // Half an hour apart, inside the TTL: this one adds instead of replacing.
    store.set('fresh', aged(0));
    expect(store.size()).toBe(2);
    expect(store.get('recent')).toBeDefined();
    expect(store.get('fresh')).toBeDefined();
  });

  /**
   * The write sweep bounds memory but not retention: nothing was written here after the entry aged
   * out, and on an idle process nothing would be. A store whose TTL only applied to what it *keeps*
   * would still hand this back.
   */
  it('expires a stale entry on read', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    store.set('old', aged(2 * HOUR));
    expect(store.size()).toBe(1);

    expect(store.get('old')).toBeUndefined();
    // Reported as a miss *and* dropped — a read that only hid it would leak on a busy process.
    expect(store.size()).toBe(0);
  });

  it('keeps an entry inside the TTL across repeated reads', () => {
    const store = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    store.set('warm', aged(0.5 * HOUR));
    expect(store.get('warm')).toBeDefined();
    expect(store.get('warm')).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it('keeps stores independent', () => {
    const a = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    const b = createMemorySessionStore<{ updatedAt: number; note: string }>(HOUR);
    a.set('k', aged(0));
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
