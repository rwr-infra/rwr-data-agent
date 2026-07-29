export interface Message {
  role: string;
  content: string;
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
}

export interface ToolStep {
  icon: string;
  text: string;
  /** Absent while the call is still running; false when the tool returned an error. */
  ok?: boolean;
  durationMs?: number;
}

export type DisplayItem =
  | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string; id: string; reasoning?: string }
  | { type: 'meta'; text: string; id: string }
  | { type: 'tool-trace'; steps: ToolStep[]; id: string };

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
}