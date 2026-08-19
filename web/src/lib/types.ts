export interface Message {
  role: string;
  content: string;
  /** Per-turn stats from the turn's `finish` event, attached so the meta line and the breakdown
   *  survive a reload. Absent on old sessions and on user messages. */
  stats?: TurnStat;
  /** The turn's blocks in arrival order — text / reasoning / tool calls interleaved exactly as the
   *  agent produced them. Assistant messages only, and absent on sessions stored before the
   *  timeline UI, which fall back to a single bubble. */
  segments?: TurnSegment[];
  /** Groups a user message with the assistant blocks it produced. Retry / recall / copy all key on
   *  it, since one turn is many display items. Absent on old sessions — rebuilt on load. */
  turnId?: string;
}

/** One block of a turn, in arrival order. This is the persisted shape of the live timeline. */
export type TurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      /** `toolCallId` from the stream — pairs the opening event with its closing one. */
      callId: string;
      toolName: string;
      /** Argument summary, from the opening `tool-step`. */
      input?: string;
      /** Result summary, from the closing `tool-step`. */
      output?: string;
      ok?: boolean;
      durationMs?: number;
    }
  | {
      kind: 'reflection';
      verdict: 'pass' | 'revised';
      issues?: { code: string; detail?: string }[];
    }
  /** The revised answer. Also what `Message.content` holds for the turn, so the replayed timeline and
   *  the history the next request sends agree on which version is the answer. The findings are
   *  repeated here rather than looked up on the neighbouring reflection segment, so a replay needs no
   *  cross-segment bookkeeping to render the same block. */
  | { kind: 'revision'; text: string; issues?: { code: string; detail?: string }[] };

/** Per-turn statistics as reported by `finish.usage`, kept on the assistant message. */
export interface TurnStat {
  ttfb: string | number;
  total: number;
  inTokens: string | number;
  outTokens: string | number;
  steps?: number;
  /** Next-request occupancy reported by the server — drives the context bar after a reload. */
  contextTokens?: number;
  maxContextTokens?: number;
  breakdown?: TokenBreakdown;
}

/** Mirrors `TokenBreakdown` in src/api/routes/chat.ts — one aggregate per turn, with every step of
 *  the agent tool loop already summed in. */
export interface TokenBreakdown {
  /** Input slices; sum to the reported input total. */
  systemPrompt: number;
  toolDefs: number;
  context: number;
  messages: number;
  toolResults: number;
  /** Cached input tokens read — a subset of the input total, not another slice of it. */
  cacheRead: number;
  /** Output slices; sum to the reported output total. */
  reasoning: number;
  toolCalls: number;
  answer: number;
  /** LLM round-trips in this turn: 1 without tools, N with an agent tool loop. */
  steps: number;
  /** Fields carrying a provider-reported exact count rather than a scaled char estimate. */
  exact: string[];
  /** Best-of-N (max mode): number of candidate runs. Absent on normal turns. */
  candidates?: number;
  /** Best-of-N: per-candidate spend, in candidate order. */
  perCandidate?: { i: number; steps: number; promptTokens: number; completionTokens: number }[];
  /** Best-of-N: the synthesis call's own spend. Absent when the turn fell back. */
  judge?: { promptTokens: number; completionTokens: number };
  /** The reflection call's own spend. Absent when the turn did not reflect. */
  reflection?: { promptTokens: number; completionTokens: number };
}

export interface ToolStep {
  text: string;
  /** Absent while the call is still running; false when the tool returned an error. */
  ok?: boolean;
  durationMs?: number;
  /** Candidate index when the step belongs to a best-of-N candidate trace. */
  candidate?: number;
}

/** One candidate's outcome as reported by the backend's `candidates` event. */
export interface CandidateView {
  i: number;
  steps: number;
  ok: boolean;
  answer: string;
}

/**
 * One rendered block. A turn is a *sequence* of these — every tool call and every stretch of text
 * between two tool calls is its own block, in arrival order — so `turnId` is what still ties them
 * together for retry / recall / copy.
 */
export type DisplayItem =
  | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string; id: string; turnId: string }
  | { type: 'reasoning'; text: string; id: string; turnId: string }
  | {
      type: 'tool-call';
      callId: string;
      toolName: string;
      input?: string;
      output?: string;
      /** Absent while the call is still running; false when the tool returned an error. */
      ok?: boolean;
      durationMs?: number;
      id: string;
      turnId: string;
    }
  | { type: 'meta'; text: string; id: string; turnId: string }
  /** A clean self-check, rendered as a one-line badge. A check that found something renders as the
   *  `revision` block instead — the findings belong next to the answer that fixes them. */
  | { type: 'reflection'; verdict: 'pass'; id: string; turnId: string }
  /** The revised answer, rendered as an ordinary AI bubble — it is the answer the conversation
   *  continues from, so it carries the turn's action bar and meta line. `issues` collapses into the
   *  one-line note above it, aggregated by code. */
  | {
      type: 'revision';
      text: string;
      issues: { code: string; detail?: string }[];
      id: string;
      turnId: string;
    }
  | { type: 'candidate-trace'; candidate: number; total: number; steps: ToolStep[]; done?: boolean; ok?: boolean; id: string; turnId: string }
  | { type: 'candidate-panel'; candidates: CandidateView[]; kind?: 'synthesis' | 'fallback'; id: string; turnId: string };

export interface MetaInfo {
  ttfb: string | number;
  total: number;
  inTokens: string | number;
  outTokens: string | number;
}

export interface PackageOption {
  value: string;
  label: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  selectedMod?: string;
  /** Best-of-N toggle state, persisted like `selectedMod`. */
  maxMode?: boolean;
}