import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeTurnCount,
  createTurn,
  endTurn,
  steerTurn,
  steeringLimits,
  stopTurn,
  type TurnHandle,
} from '@rwr/agent-core';

/** The registry is module-level state, so every test cleans up after itself. */
const opened: TurnHandle[] = [];

function open(): { handle: TurnHandle; abort: AbortController } {
  const abort = new AbortController();
  const handle = createTurn(abort);
  opened.push(handle);
  return { handle, abort };
}

afterEach(() => {
  vi.useRealTimers();
  while (opened.length) endTurn(opened.pop()!.id);
});

describe('createTurn / endTurn', () => {
  it('registers a turn and releases it', () => {
    const before = activeTurnCount();
    const { handle } = open();

    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(activeTurnCount()).toBe(before + 1);

    endTurn(handle.id);
    expect(activeTurnCount()).toBe(before);
  });

  it('hands out distinct ids', () => {
    const ids = new Set([open().handle.id, open().handle.id, open().handle.id]);
    expect(ids.size).toBe(3);
  });

  it('tolerates a double release', () => {
    const { handle } = open();
    endTurn(handle.id);
    expect(() => endTurn(handle.id)).not.toThrow();
  });

  it('starts with no steering and no stop', () => {
    const { handle } = open();
    expect(handle.steering()).toEqual([]);
    expect(handle.stoppedByUser()).toBe(false);
  });
});

describe('steerTurn', () => {
  /**
   * Sticky, not a queue: reading the list must not consume it. The stream re-appends every message
   * on every step, because a `prepareStep` rewrite only reaches one outgoing request (ADR-0002).
   */
  it('accumulates messages in order and never drains them', () => {
    const { handle } = open();

    expect(steerTurn(handle.id, '只保留 class=3')).toBe('queued');
    expect(steerTurn(handle.id, '再按伤害排序')).toBe('queued');

    expect(handle.steering()).toEqual(['只保留 class=3', '再按伤害排序']);
    // Read twice — a queue would be empty the second time.
    expect(handle.steering()).toEqual(['只保留 class=3', '再按伤害排序']);
  });

  it('trims the message', () => {
    const { handle } = open();
    steerTurn(handle.id, '  只保留 class=3  ');
    expect(handle.steering()).toEqual(['只保留 class=3']);
  });

  it('rejects an unknown turn', () => {
    expect(steerTurn('00000000-0000-0000-0000-000000000000', 'hello')).toBe('not_found');
  });

  it('rejects a turn that already ended', () => {
    const { handle } = open();
    endTurn(handle.id);
    expect(steerTurn(handle.id, 'too late')).toBe('not_found');
  });

  it('rejects empty and whitespace-only messages', () => {
    const { handle } = open();
    expect(steerTurn(handle.id, '')).toBe('empty');
    expect(steerTurn(handle.id, '   \n ')).toBe('empty');
    expect(handle.steering()).toEqual([]);
  });

  it('rejects a message past the length cap', () => {
    const { handle } = open();
    expect(steerTurn(handle.id, 'x'.repeat(steeringLimits.maxChars + 1))).toBe('too_long');
    expect(steerTurn(handle.id, 'x'.repeat(steeringLimits.maxChars))).toBe('queued');
  });

  // The cap bounds cost, not politeness: every accepted message is re-sent on every later step.
  it('stops accepting past the message cap', () => {
    const { handle } = open();
    for (let i = 0; i < steeringLimits.maxMessages; i++) {
      expect(steerTurn(handle.id, `instruction ${i}`)).toBe('queued');
    }
    expect(steerTurn(handle.id, 'one too many')).toBe('too_many');
    expect(handle.steering()).toHaveLength(steeringLimits.maxMessages);
  });
});

describe('stopTurn', () => {
  it('aborts the caller-owned controller and marks the reason', () => {
    const { handle, abort } = open();

    expect(stopTurn(handle.id)).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    // This is what lets the stream report `stopped` instead of mistaking the abort for a
    // client disconnect.
    expect(handle.stoppedByUser()).toBe(true);
  });

  it('reports an unknown turn rather than throwing', () => {
    expect(stopTurn('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('does not abort a turn that already ended', () => {
    const { handle, abort } = open();
    endTurn(handle.id);
    expect(stopTurn(handle.id)).toBe(false);
    expect(abort.signal.aborted).toBe(false);
  });
});

describe('TTL sweep', () => {
  /**
   * Backstop for a turn whose `endTurn` never ran — a crash between opening the stream and the
   * `finally`. Lazy on create rather than an interval, which would hold the event loop open.
   */
  it('drops turns older than the TTL when a new turn opens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));

    const stale = createTurn(new AbortController());
    expect(steerTurn(stale.id, 'still alive')).toBe('queued');

    // Past the 30-minute TTL. Nothing happens until something touches the registry…
    vi.setSystemTime(new Date('2026-08-12T00:31:00Z'));
    expect(steerTurn(stale.id, 'not swept yet')).toBe('queued');

    // …and opening a turn is what touches it.
    const fresh = createTurn(new AbortController());
    opened.push(fresh);
    expect(steerTurn(stale.id, 'gone now')).toBe('not_found');
    expect(steerTurn(fresh.id, 'fresh is fine')).toBe('queued');
  });

  it('leaves turns inside the TTL alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));

    const young = createTurn(new AbortController());
    opened.push(young);

    vi.setSystemTime(new Date('2026-08-12T00:29:00Z'));
    const fresh = createTurn(new AbortController());
    opened.push(fresh);

    expect(steerTurn(young.id, 'survives')).toBe('queued');
  });
});
