export interface Message {
  role: string;
  content: string;
  /** Per-turn stats from the turn's `finish` event, attached so the meta line and the breakdown
   *  survive a reload. Absent on old sessions and on user messages. */
  stats?: TurnStat;
}

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
}

export interface ToolStep {
  icon: string;
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

export type DisplayItem =
  | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string; id: string; reasoning?: string }
  | { type: 'meta'; text: string; id: string }
  | { type: 'tool-trace'; steps: ToolStep[]; id: string }
  | { type: 'candidate-trace'; candidate: number; total: number; steps: ToolStep[]; done?: boolean; ok?: boolean; id: string }
  | { type: 'candidate-panel'; candidates: CandidateView[]; kind?: 'synthesis' | 'fallback'; id: string };

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