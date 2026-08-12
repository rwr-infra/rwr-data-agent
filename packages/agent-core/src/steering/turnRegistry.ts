/**
 * In-flight turns, so a second HTTP request can reach a stream that is already running.
 *
 * A turn is one `POST /v1/chat/completions`. While it streams, `POST /v1/chat/steer` can add an
 * instruction to it and `POST /v1/chat/stop` can end it. Both need a handle on a turn that lives
 * inside another request's closure — that handle is this module.
 *
 * ⚠️ **Process-local, single-replica.** Behind more than one replica a steer request lands on a
 * process that has never heard of the turn and answers 404. Solving that means moving this to
 * shared state; until then the deployment stays a single service (see ADR-0002).
 *
 * Steering messages are **sticky**: they accumulate and are re-appended on *every* later step, not
 * drained once. The AI SDK rebuilds `messages` from the original input plus its own accumulated
 * response on each step, so a `prepareStep` rewrite only reaches that one outgoing request — an
 * instruction injected once is gone from the next one. Measured; see the spike in ADR-0002.
 */
import { randomUUID } from 'crypto';

/** Ceiling on accepted steering messages per turn. They are re-sent on every step, so this is a
 *  cost bound, not a UX one: 8 short instructions across a 15-step loop is already 120 replays. */
const MAX_STEERING_MESSAGES = 8;
/** Longest single steering message. A user correction is a sentence, not a document. */
const MAX_STEERING_CHARS = 2000;
/**
 * Backstop for a turn whose `endTurn` never ran — a crash between opening the stream and the
 * `finally` block. Generous, because a legitimate turn can be slow: the normal path allows 100
 * steps, each with its own tool calls.
 */
const TURN_TTL_MS = 30 * 60_000;

interface TurnRecord {
  abort: AbortController;
  steering: string[];
  stoppedByUser: boolean;
  createdAt: number;
}

/** What the streaming route holds. Read-only from its side: mutation goes through the side channel. */
export interface TurnHandle {
  readonly id: string;
  /** Steering accepted so far, oldest first. Append all of these on every step — see the note above. */
  steering(): string[];
  /** True once `/v1/chat/stop` fired, so the stream reports `stopped` instead of mistaking the
   *  abort for a client disconnect. */
  stoppedByUser(): boolean;
}

export type SteerResult = 'queued' | 'not_found' | 'empty' | 'too_long' | 'too_many';

const turns = new Map<string, TurnRecord>();

/** Drop turns whose `endTurn` never ran. Lazy rather than an interval: a timer would keep the
 *  event loop alive for a process that is otherwise idle, and turns only appear here on create. */
function sweep(now: number): void {
  for (const [id, record] of turns) {
    if (now - record.createdAt > TURN_TTL_MS) turns.delete(id);
  }
}

/**
 * Register a turn that is about to start streaming. The caller keeps owning `abort` — the registry
 * only needs to be able to fire it — and must call `endTurn(handle.id)` in its `finally`.
 */
export function createTurn(abort: AbortController): TurnHandle {
  const now = Date.now();
  sweep(now);

  const id = randomUUID();
  const record: TurnRecord = { abort, steering: [], stoppedByUser: false, createdAt: now };
  turns.set(id, record);

  return {
    id,
    steering: () => record.steering,
    stoppedByUser: () => record.stoppedByUser,
  };
}

/**
 * Add an instruction to a running turn. Takes effect on its next step: the current step is already
 * in flight with the provider, and cancelling it would throw away reasoning the user has paid for.
 */
export function steerTurn(id: string, message: string): SteerResult {
  const record = turns.get(id);
  if (!record) return 'not_found';

  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (!trimmed) return 'empty';
  if (trimmed.length > MAX_STEERING_CHARS) return 'too_long';
  if (record.steering.length >= MAX_STEERING_MESSAGES) return 'too_many';

  record.steering.push(trimmed);
  return 'queued';
}

/**
 * End a running turn on the user's request. Whatever the model has already produced stays — the
 * stream closes with `stopReason: 'stopped'` rather than discarding the partial answer.
 */
export function stopTurn(id: string): boolean {
  const record = turns.get(id);
  if (!record) return false;
  record.stoppedByUser = true;
  record.abort.abort();
  return true;
}

/** Release a finished turn. Safe to call more than once. */
export function endTurn(id: string): void {
  turns.delete(id);
}

/** Live turn count — for `/health` and tests. */
export function activeTurnCount(): number {
  return turns.size;
}

export const steeringLimits = {
  maxMessages: MAX_STEERING_MESSAGES,
  maxChars: MAX_STEERING_CHARS,
} as const;
