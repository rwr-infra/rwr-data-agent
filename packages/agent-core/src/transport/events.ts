/**
 * The NDJSON event protocol — the agent's only public stream contract.
 *
 * One JSON object per line, keyed by `type`. Deliberately not SSE: an agent turn emits tool
 * traces, candidate fan-out and a per-slice token breakdown, none of which fit in OpenAI's
 * `choices[].delta.content` shape. A client that wants those has to speak this instead.
 *
 * **Evolution rule, and it is a promise to external clients: add new optional fields and new
 * event types; never change what an existing field means.** Adding a value to an existing union
 * (a new `stopReason`) is allowed, which is why every consumer needs a default branch.
 */

/**
 * Bump the minor for a new optional field or event type; the major only for a change the rule
 * above forbids. Announced on `turn-start` so a client can refuse to guess.
 */
export const PROTOCOL_VERSION = '1.3';

/** Why a turn ended. Consumers **must** tolerate an unknown value here. */
export type StopReason = 'completed' | 'step-limit' | 'output-limit' | 'stopped';

/** First line of every stream. `turnId` is the key for any side channel into the running turn. */
export interface TurnStartEvent {
  type: 'turn-start';
  turnId: string;
  protocolVersion: string;
}

/** Keep-alive. Carries nothing; exists so a silent phase does not read as a stalled origin to
 *  whatever proxy sits in front. */
export interface PingEvent {
  type: 'ping';
}

export interface TextDeltaEvent {
  type: 'text-delta';
  textDelta: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning-delta';
  textDelta: string;
}

/** Partial object, structured-output mode only. */
export interface JsonDeltaEvent {
  type: 'json-delta';
  jsonDelta: unknown;
}

/**
 * Emitted **twice** per tool call — opening, then closing with `done: true`. `toolCallId` is the
 * pairing key: one card per call, updated in place.
 *
 * A *failed* tool arrives here with `ok: false`, not as an `error` event. `summary` is a short
 * human-readable line (arguments on the way in, result on the way out) and must never grow into
 * the raw input or output.
 */
export interface ToolStepEvent {
  type: 'tool-step';
  toolCallId?: string;
  toolName?: string;
  summary?: string;
  done?: boolean;
  ok?: boolean;
  durationMs?: number;
}

/** A mid-stream instruction reached the loop. Once per accepted message, **not** once per step —
 *  the injection itself repeats on every later step. */
export interface SteerAppliedEvent {
  type: 'steer-applied';
  turnId: string;
  step: number;
  message: string;
}

/**
 * The post-answer self-critique has started. Carries no result — it exists so a client can say what
 * the turn is doing during a phase that emits nothing else.
 *
 * Without it the reflection call is a silent gap between the last `text-delta` and `finish`, up to a
 * minute long, indistinguishable from a stalled stream: the answer is complete on screen, the stop
 * button is still lit, and nothing explains why. A client may ignore it, in which case the phase is
 * simply unlabelled — but every `reflection-start` is followed by either a `reflection` or, if the
 * check could not run, nothing at all, so it must never be treated as a promise of a verdict.
 */
export interface ReflectionStartEvent {
  type: 'reflection-start';
  /** Which risk signals selected this turn, same values as `ReflectionEvent.trigger`. */
  trigger?: string[];
}

/**
 * Outcome of the post-answer self-critique, emitted after the answer text and before `finish`.
 *
 * A turn that did not reflect emits nothing here — absence means "not checked", never "checked and
 * clean". `revised` is the only verdict followed by a `revision` event; a client that renders the
 * reflection must therefore tolerate both orders of arrival being absent.
 *
 * Findings are **not** errors: a reflection that fails its own checks still leaves a complete turn,
 * so nothing here may travel as an `ErrorEvent`.
 */
export interface ReflectionEvent {
  type: 'reflection';
  verdict: 'pass' | 'revised';
  /**
   * Machine-readable findings. `code` is an open set (`missing-citation`, `missing-key`,
   * `scope-violation`, `count-mismatch`, `unsupported-claim`, `no-answer`, `other` today) — the
   * client owns the wording and must tolerate an unknown value. `detail` is model-produced prose in
   * the question's language, displayed verbatim like answer text rather than localized.
   */
  issues?: { code: string; detail?: string }[];
  /** Which risk signals selected this turn for reflection, e.g. `['tool-failure']`. */
  trigger?: string[];
}

/**
 * The revised answer, whole rather than as deltas — the original already streamed as `text-delta`
 * and stays on screen. This is the version that enters the conversation history: a client replaying
 * the turn sends this instead of the streamed text, so a client that ignores the event keeps the
 * original and stays consistent with itself.
 */
export interface RevisionEvent {
  type: 'revision';
  text: string;
}

/**
 * Token usage for the turn. The two halves answer different questions and are not interchangeable:
 * `promptTokens`/`completionTokens` are **spend** (summed across every step of the loop), while
 * `contextTokens` is **occupancy** — what the *next* request will carry, with the tool transcript
 * excluded because it never survives the turn. A client gating its send button reads the latter.
 */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  contextTokens: number;
  maxContextTokens?: number;
  /** True when the provider omitted usage and these are char-based estimates. */
  estimated?: boolean;
  breakdown?: Record<string, unknown>;
}

export interface FinishEvent {
  type: 'finish';
  stopReason: StopReason;
  /** Absent when a turn was stopped before any usage could be measured. */
  usage?: TurnUsage;
}

/** The stream itself broke. **Not** a tool failure (that is `tool-step` with `ok: false`) and not
 *  a stop reason (that is `finish.stopReason`). Carries a message, never localized prose. */
export interface ErrorEvent {
  type: 'error';
  error: string;
}

export type AgentEvent =
  | TurnStartEvent
  | PingEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | JsonDeltaEvent
  | ToolStepEvent
  | SteerAppliedEvent
  | ReflectionStartEvent
  | ReflectionEvent
  | RevisionEvent
  | FinishEvent
  | ErrorEvent;

/**
 * One event as a wire line, newline included.
 *
 * Domain layers extend the protocol with their own event types (RWR adds best-of-N candidate
 * frames), so this accepts anything object-shaped rather than only `AgentEvent` — the union above
 * documents and types the core set without closing the protocol to extensions.
 */
export function encodeEvent(event: AgentEvent | Record<string, unknown>): string {
  return JSON.stringify(event) + '\n';
}
