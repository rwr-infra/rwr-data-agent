import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { steerRoutes } from '../../src/api/routes/steer.js';
import { createTurn, endTurn, steeringLimits, type TurnHandle } from '@rwr/agent-core';

/**
 * Only `steerRoutes` is registered — not `buildApp()`, which kicks off an index build. The side
 * channel has no dependency on the index, so this stays a unit test.
 */
let app: FastifyInstance;
const opened: TurnHandle[] = [];

function openTurn(): { handle: TurnHandle; abort: AbortController } {
  const abort = new AbortController();
  const handle = createTurn(abort);
  opened.push(handle);
  return { handle, abort };
}

/** The failure shape both routes speak — OpenAI-ish, with a machine-readable `code`. */
interface ApiError {
  error: { message: string; type: string; code?: string };
}

// The return type is spelled out because `inject` is overloaded (callback vs promise) and the
// inferred union has neither `statusCode` nor `json`.
const post = (url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, payload });

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  app = Fastify({ logger: false });
  await app.register(steerRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(async () => {
  while (opened.length) endTurn(opened.pop()!.id);
  await app.close();
});

describe('POST /v1/chat/steer', () => {
  it('accepts an instruction for a running turn', async () => {
    const { handle } = openTurn();
    const res = await post('/v1/chat/steer', { turnId: handle.id, message: '只保留 class=3' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: true });
    expect(handle.steering()).toEqual(['只保留 class=3']);
  });

  /**
   * 404, not 400: the usual cause is a race — the turn finished between the user pressing the
   * button and the request landing — not a malformed call, and the UI wants to tell those apart.
   */
  it('reports an unknown turn as 404', async () => {
    const res = await post('/v1/chat/steer', {
      turnId: '00000000-0000-0000-0000-000000000000',
      message: 'hello',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiError>().error.code).toBe('not_found');
  });

  it('requires a turnId', async () => {
    const res = await post('/v1/chat/steer', { message: 'hello' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().error.message).toContain('turnId');
  });

  it('rejects an empty message', async () => {
    const { handle } = openTurn();
    const res = await post('/v1/chat/steer', { turnId: handle.id, message: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().error.code).toBe('empty');
  });

  it('rejects a message past the length cap', async () => {
    const { handle } = openTurn();
    const res = await post('/v1/chat/steer', {
      turnId: handle.id,
      message: 'x'.repeat(steeringLimits.maxChars + 1),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().error.code).toBe('too_long');
  });

  // 429 rather than 400 — the request is well-formed, the turn is just full.
  it('reports the per-turn cap as 429', async () => {
    const { handle } = openTurn();
    for (let i = 0; i < steeringLimits.maxMessages; i++) {
      await post('/v1/chat/steer', { turnId: handle.id, message: `instruction ${i}` });
    }
    const res = await post('/v1/chat/steer', { turnId: handle.id, message: 'one too many' });
    expect(res.statusCode).toBe(429);
    expect(res.json<ApiError>().error.code).toBe('too_many');
  });

  it('survives a non-string turnId or message', async () => {
    const { handle } = openTurn();
    expect((await post('/v1/chat/steer', { turnId: 42, message: 'x' })).statusCode).toBe(400);
    expect((await post('/v1/chat/steer', { turnId: handle.id, message: 42 })).statusCode).toBe(400);
  });
});

describe('POST /v1/chat/stop', () => {
  it('aborts a running turn', async () => {
    const { handle, abort } = openTurn();
    const res = await post('/v1/chat/stop', { turnId: handle.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
    expect(abort.signal.aborted).toBe(true);
    expect(handle.stoppedByUser()).toBe(true);
  });

  it('reports an unknown turn as 404', async () => {
    const res = await post('/v1/chat/stop', {
      turnId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiError>().error.code).toBe('not_found');
  });

  it('requires a turnId', async () => {
    const res = await post('/v1/chat/stop', {});
    expect(res.statusCode).toBe(400);
  });

  it('does not touch other turns', async () => {
    const first = openTurn();
    const second = openTurn();
    await post('/v1/chat/stop', { turnId: first.handle.id });

    expect(first.abort.signal.aborted).toBe(true);
    expect(second.abort.signal.aborted).toBe(false);
  });
});
