import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSummary,
  getSummary,
  setSummary,
  shouldGenerateSummary,
  summaryCount,
} from '../../src/memory/summarizer.js';
import type { ConversationSummary } from '../../src/memory/types.js';

const HOUR = 60 * 60_000;

function summary(updatedAt: number, turnCount = 0): ConversationSummary {
  return {
    summary: 'talked about weapons',
    mentionedEntities: ['gkw_g36'],
    currentTopic: 'weapons',
    turnCount,
    updatedAt,
  };
}

const ids: string[] = [];
function put(id: string, updatedAt: number, turnCount = 0): void {
  ids.push(id);
  setSummary(id, summary(updatedAt, turnCount));
}

afterEach(() => {
  while (ids.length) clearSummary(ids.pop()!);
});

describe('summary store', () => {
  it('round-trips and clears', () => {
    put('s1', Date.now());
    expect(getSummary('s1')?.summary).toBe('talked about weapons');
    clearSummary('s1');
    expect(getSummary('s1')).toBeUndefined();
  });

  /**
   * `x-session-id` is minted by the client, one per conversation, and the server is never told when
   * one is abandoned — so without eviction this map grows for the life of the process, one entry per
   * conversation anyone ever started.
   */
  it('evicts summaries past the TTL when a new one is written', () => {
    const now = Date.now();
    put('stale', now - 7 * HOUR);
    put('recent', now - 1 * HOUR);
    expect(summaryCount()).toBeGreaterThanOrEqual(2);

    // The sweep is lazy — it runs on write, keyed off the incoming summary's own timestamp.
    put('fresh', now);

    expect(getSummary('stale')).toBeUndefined();
    expect(getSummary('recent')).toBeDefined();
    expect(getSummary('fresh')).toBeDefined();
  });

  /**
   * The write sweep bounds memory, not retention: on an idle process — or one where some other
   * session is the only writer — nothing runs it, and a summary past its TTL would still be handed
   * back. These hold user conversation content keyed by a client-minted id, so the stated bound has
   * to apply to what is returned, not only to what is stored.
   */
  it('expires a stale summary on read, with nothing else writing', () => {
    const now = Date.now();
    put('old', now - 7 * HOUR);
    expect(getSummary('old')).toBeUndefined();
  });

  it('keeps a summary inside the TTL', () => {
    const now = Date.now();
    put('warm', now - 1 * HOUR);
    expect(getSummary('warm')).toBeDefined();
  });
});

describe('shouldGenerateSummary', () => {
  it('waits for the first interval, then for each one after', () => {
    expect(shouldGenerateSummary('never-seen', 1)).toBe(false);
    expect(shouldGenerateSummary('never-seen', 3)).toBe(true);

    put('seen', Date.now(), 4);
    // Counted against the turn the existing summary was built from, not from zero.
    expect(shouldGenerateSummary('seen', 5)).toBe(false);
    expect(shouldGenerateSummary('seen', 7)).toBe(true);
  });
});
