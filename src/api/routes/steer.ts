import type { FastifyInstance } from 'fastify';
import { steerTurn, stopTurn, steeringLimits, type SteerResult } from '@rwr/agent-core';

/**
 * Side channel into a turn that is already streaming.
 *
 * A chat turn is one long-lived `POST /v1/chat/completions`; its request body was consumed before
 * the first token went out, so there is nowhere on that connection to say anything else. These two
 * routes are that "anything else", keyed by the `turnId` the stream announces in its `turn-start`
 * event.
 *
 * Both are process-local: the turn lives in another request's closure in *this* process. See the
 * single-replica note on `agent/turnRegistry.ts`.
 */

interface SteerBody {
  turnId?: unknown;
  message?: unknown;
}

/** 404 rather than 400 for an unknown turn: the usual cause is a race — the turn finished between
 *  the user pressing the button and the request landing — not a malformed call. */
const FAILURES: Record<Exclude<SteerResult, 'queued'>, { status: number; message: string }> = {
  not_found: {
    status: 404,
    message: 'No such turn is running. It may have already finished.',
  },
  empty: { status: 400, message: 'message must be a non-empty string' },
  too_long: {
    status: 400,
    message: `message exceeds ${steeringLimits.maxChars} characters`,
  },
  too_many: {
    status: 429,
    // Steering is re-sent on every later step, so the cap bounds cost rather than politeness.
    message: `This turn already carries ${steeringLimits.maxMessages} steering messages. Let it finish, then ask again.`,
  },
};

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function steerRoutes(app: FastifyInstance) {
  /**
   * Add an instruction to a running turn. It lands on the turn's **next** step: the current step is
   * already in flight with the provider, and cancelling it would throw away reasoning the user has
   * already paid for.
   */
  app.post('/chat/steer', (request, reply) => {
    const body = (request.body ?? {}) as SteerBody;
    const turnId = typeof body.turnId === 'string' ? body.turnId : '';
    if (!turnId) {
      return reply.status(400).send({
        error: { message: 'turnId is required', type: 'invalid_request_error' },
      });
    }

    const result = steerTurn(turnId, typeof body.message === 'string' ? body.message : '');
    if (result === 'queued') {
      console.log(`[steer] turn=${turnId} accepted`);
      return reply.send({ queued: true });
    }

    const failure = FAILURES[result];
    return reply.status(failure.status).send({
      error: { message: failure.message, type: 'invalid_request_error', code: result },
    });
  });

  /**
   * End a running turn. Whatever the model already produced is kept — the stream closes with
   * `stopReason: 'stopped'` instead of discarding the partial answer.
   */
  app.post('/chat/stop', (request, reply) => {
    const body = (request.body ?? {}) as SteerBody;
    const turnId = typeof body.turnId === 'string' ? body.turnId : '';
    if (!turnId) {
      return reply.status(400).send({
        error: { message: 'turnId is required', type: 'invalid_request_error' },
      });
    }

    if (!stopTurn(turnId)) {
      return reply.status(404).send({
        error: {
          message: FAILURES.not_found.message,
          type: 'invalid_request_error',
          code: 'not_found',
        },
      });
    }
    console.log(`[steer] turn=${turnId} stopped by user`);
    return reply.send({ stopped: true });
  });
}
