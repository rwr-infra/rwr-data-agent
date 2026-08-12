import 'dotenv/config';
import * as os from 'os';
import * as path from 'path';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const outputDir = path.resolve(process.env.OUTPUT_DIR ?? './output');

/**
 * How many files the index build parses at once.
 *
 * XML parsing is synchronous CPU work, so extra concurrency buys no throughput past the
 * core count — it only keeps that many file contents *and* their parse trees alive at the
 * same time, which is exactly the peak the build has to survive on a small box. Default
 * is the core count clamped to [2, 4]; a 2-vCPU host lands on 2.
 */
const indexConcurrency = (() => {
  const raw = parseInt(process.env.INDEX_CONCURRENCY ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const cores =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(4, cores || 2));
})();

/** Parse an integer env var, falling back to `fallback` on missing/garbage. `parseInt` is the wrong
 *  tool twice over: it returns NaN for non-numeric input, which silently breaks loop bounds
 *  downstream (`BEST_OF_N='abc'` → NaN candidates → empty best-of-N turn), and it happily reads
 *  `'3junk'` as `3` — a typo then applies a value nobody configured. `Number` rejects both. */
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

function positiveIntEnv(name: string, fallback: number): number {
  return intEnv(name, fallback, 1);
}

/** Same as `positiveIntEnv`, but `0` is a meaningful value (used as "no limit") rather than
 *  garbage that falls back to the default. Negative and non-numeric input still fall back. */
function nonNegativeIntEnv(name: string, fallback: number): number {
  return intEnv(name, fallback, 0);
}

export const config = {
  // ── LLM (the only required external service) ──────────────────────────────
  // SILICONFLOW_* is still honoured as a fallback so pre-existing .env files keep working.
  llmApiKey: process.env.LLM_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmModel: process.env.LLM_MODEL ?? 'deepseek-v4-flash',
  /**
   * Models offered by GET /v1/models and accepted in `body.model`. Comma-separated; defaults to
   * the single configured model. Requests naming anything outside this list fall back to
   * `llmModel` — the client may switch within the operator's list, never beyond it.
   */
  llmModels: (() => {
    const raw = process.env.LLM_MODELS;
    if (raw) {
      const parsed = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length > 0) return parsed;
    }
    return [process.env.LLM_MODEL ?? 'deepseek-v4-flash'];
  })(),
  /**
   * Display names for the model switcher, as `id=Label` pairs (comma-separated). The UI shows
   * these instead of the raw model ids — a mapping table in the Gemini Flash/Pro style — while
   * `body.model` keeps carrying the real id. Absent labels fall back to the id itself.
   */
  llmModelLabels: (() => {
    const raw = process.env.LLM_MODEL_LABELS;
    const out: Record<string, string> = {};
    if (raw) {
      for (const pair of raw.split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
    return out;
  })(),

  // ── Local data & index ────────────────────────────────────────────────────
  /** Data root — either a single RWR package or a directory of packages. */
  dataDir,
  outputDir,
  graphPath: process.env.GRAPH_PATH
    ? path.resolve(process.env.GRAPH_PATH)
    : path.join(outputDir, 'graph.json'),
  searchIndexPath: process.env.SEARCH_INDEX_PATH
    ? path.resolve(process.env.SEARCH_INDEX_PATH)
    : path.join(outputDir, 'search-index.json'),
  /** Build/refresh the index at startup when it is missing or stale. */
  autoBuildIndex: process.env.AUTO_BUILD_INDEX !== 'false',
  /** Files parsed concurrently by the index build. See the comment on `indexConcurrency`. */
  indexConcurrency,

  // ── Agent tool plugins ────────────────────────────────────────────────────
  /** Directory of runtime tool plugins (plain ESM .js). Optional — skipped if absent. */
  toolsDir: path.resolve(process.env.TOOLS_DIR ?? './tools.d'),
  /**
   * Watch the plugin directory and reload on change. Off in production, where each reload
   * leaks the previous ESM module and a watcher buys nothing.
   */
  toolsHotReload:
    process.env.TOOLS_HOT_RELOAD !== undefined
      ? process.env.TOOLS_HOT_RELOAD === 'true'
      : process.env.NODE_ENV !== 'production',
  /**
   * Gate for progressive tool disclosure. When built-ins + plugins exceed this many tools,
   * the agent loop's FIRST step only exposes the built-ins plus any plugin whose `triggers`
   * matched the query; later steps always see everything. `0` disables disclosure entirely.
   * Default 12 — a no-op at the current tool count, so it only kicks in once `tools.d/`
   * grows past it.
   */
  toolDisclosureThreshold: parseInt(process.env.TOOL_DISCLOSURE_THRESHOLD ?? '12', 10),

  // ── Skills ────────────────────────────────────────────────────────────────
  /**
   * Directory of skills: markdown playbooks appended to the system prompt when the question
   * matches their declared triggers. Optional — skipped if absent.
   *
   * This is where domain knowledge belongs in a self-hosted deployment: a mod's quirks are a file
   * someone drops in, not an edit to the prompt in the codebase. Shares `TOOLS_HOT_RELOAD`, since
   * both are "operator-editable files reloaded on the next request".
   */
  skillsDir: path.resolve(process.env.SKILLS_DIR ?? './skills.d'),

  // ── Server ────────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT ?? '3000', 10),
  /**
   * Comma-separated allowed origins. Empty means reflect any origin, which is the historical default
   * and fine for a LAN box behind a firewall — set this the moment the port is reachable from
   * anywhere else.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  /**
   * When set, every `/v1/*` request must present it as `Authorization: Bearer <token>` or
   * `x-api-key`. Unset means no authentication, which is the historical behaviour. `/health` and the
   * static UI stay open either way so a load balancer and a browser can still reach them.
   */
  apiToken: process.env.API_TOKEN ?? '',
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '500000', 10),
  /**
   * Cap on how many rounds a single conversation may carry. A "round" is one user turn plus its
   * answer, counted off the non-system messages the client replays — so the 21st question of a
   * session is rejected with 400 rather than served, and the user starts a new chat.
   *
   * This is a conversation-length limit, not a rate limit: it bounds how far a single thread can
   * grow, which is what actually drives cost here (the whole history is re-sent every turn, and
   * the tool loop re-sends it once per step on top of that). `0` disables the check.
   */
  maxConversationRounds: nonNegativeIntEnv('MAX_CONVERSATION_ROUNDS', 20),
  // Cap on generated output tokens (reasoning + answer share this budget). Bounds long
  // enumerations/comparisons; raise if answers get truncated. DeepSeek-V4 allows up to 384K.
  llmMaxOutputTokens: parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '32768', 10),

  /**
   * Token cap on the *full text* of retrieved documents in the prompt. Hits beyond it still appear,
   * as one-line summaries the model can expand with `searchDocs` / `readSource`, so an enumeration
   * keeps complete coverage while the prompt stops growing. Uncapped, a 150-result enumeration reached
   * ~80K tokens of context — re-sent on every step of the tool loop.
   *
   * The default is sized so `specific` and `comparison` queries (topK 30) are untouched and only
   * enumeration is capped. Raise it if answers start missing attributes the model should have seen.
   */
  contextBudgetTokens: parseInt(process.env.CONTEXT_BUDGET_TOKENS ?? '24000', 10),

  /**
   * Step cap for the normal agent loop — a runaway backstop, deliberately not a tight budget.
   *
   * 100 keeps the historical behaviour, because a genuinely deep question needs the room: a
   * reference or inheritance chain that crosses several packages is *sequential* — each `readSource`
   * depends on what the previous layer reported — and truncating it mid-walk produces a confidently
   * wrong answer rather than a slow one.
   *
   * Note this counts **steps, not tool calls**: one step can fan out many parallel calls, and
   * measured runs do (15 calls in 9 steps; 54 `getScriptSymbols` in a single step). So the real
   * lever on cost is retrieval breadth and the prompt's playbooks, not this number — lower it only
   * when an operator wants a hard ceiling and accepts truncated answers as the trade.
   *
   * Hitting it is not a silent truncation: `finish.stopReason` reports `step-limit`, and the system
   * prompt's instruction is to answer from the evidence already gathered.
   */
  maxToolSteps: positiveIntEnv('MAX_TOOL_STEPS', 100),

  // ── Agent tool transcript ─────────────────────────────────────────────────
  /**
   * Fraction of the context window a step's prompt may occupy before the agent loop starts
   * shedding its oldest tool results. Tool results are replayed in full below this line — an
   * unconditional compression costs answer quality on multi-step enumerations, where the older
   * results *are* the answer. With the default window this threshold is effectively never reached;
   * it exists to survive pathological tool output, not to save tokens routinely.
   */
  toolContextBudgetRatio: parseFloat(process.env.TOOL_CONTEXT_BUDGET_RATIO ?? '0.75'),
  /** Size an old tool result is shrunk to when shedding is unavoidable. */
  toolShedResultTokens: parseInt(process.env.TOOL_SHED_RESULT_TOKENS ?? '600', 10),
  /**
   * Deadline for a single tool execution. On expiry the tool returns a `{ error, hint }` the model
   * can route around, so a hanging plugin or a pathological file read cannot stall the HTTP stream.
   */
  toolTimeoutMs: parseInt(process.env.TOOL_TIMEOUT_MS ?? '15000', 10),

  // ── Streaming ─────────────────────────────────────────────────────────────
  /**
   * Interval between `{"type":"ping"}` keep-alive lines on the chat stream. A turn is silent for as
   * long as its slowest phase — a cold first step, a tool call, the best-of-N judge — and whatever
   * sits in front of the app reads that silence as a stalled origin. The reset lands *after* the
   * 200 has gone out, so it reaches the browser as `ERR_HTTP2_PROTOCOL_ERROR` mid-answer rather
   * than as a status code. The default is deliberately under the tightest such timeout seen in
   * practice — Tencent EdgeOne's "HTTP response timeout" is 15s out of the box. `0` disables it.
   *
   * Guarded rather than raw `parseInt`: an unparseable value would come out NaN, which fails the
   * `> 0` check and silently turns the heartbeat off — reintroducing exactly the failure it exists
   * to prevent, with no signal at all.
   */
  streamHeartbeatMs: nonNegativeIntEnv('STREAM_HEARTBEAT_MS', 10000),

  // ── Session memory ────────────────────────────────────────────────────────
  summaryIntervalTurns: parseInt(process.env.SUMMARY_INTERVAL_TURNS ?? '3', 10),
  summaryModel: process.env.SUMMARY_MODEL ?? process.env.LLM_MODEL ?? 'deepseek-v4-flash',

  // ── Best-of-N synthesis ("max mode") ──────────────────────────────────────
  /**
   * Master switch for best-of-N. When on, a request with `mode: 'max'` runs N parallel
   * candidate agent loops and one synthesis ("judge") call that merges them into the
   * final answer. The normal path is untouched either way.
   */
  bestOfNEnabled: process.env.BEST_OF_N_ENABLED !== 'false',
  /** Number of parallel candidate drafts. Requests may override it via `body.candidates`. */
  bestOfN: positiveIntEnv('BEST_OF_N', 3),
  /**
   * Per-candidate agent step cap. Tighter than `maxToolSteps` on purpose: best-of-N multiplies
   * the loop by N, so a budget that is merely sane for one run is N times too loose here.
   */
  bestOfNMaxSteps: positiveIntEnv('BEST_OF_N_MAX_STEPS', 6),
  /**
   * Temperatures applied to the candidates, cycled when fewer entries than candidates. Default
   * `[0.3, 0.6, 0.9]`; the differentiation mostly comes from the tool paths anyway — reasoning
   * models respond weakly to temperature, so the sequence is a spread, not a guarantee.
   */
  bestOfNTemperatures: (() => {
    const raw = process.env.BEST_OF_N_TEMPERATURES;
    if (raw) {
      const parsed = raw
        .split(',')
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 2);
      if (parsed.length > 0) return parsed;
    }
    return [0.3, 0.6, 0.9];
  })(),
  /** Seed of the first candidate; each candidate adds its own index, so the runs stay distinct. */
  bestOfNSeedBase: positiveIntEnv('BEST_OF_N_SEED_BASE', 1),
  /** Model for the synthesis ("judge") call — defaults to the main model, can be a stronger one. */
  judgeModel: process.env.JUDGE_MODEL ?? process.env.LLM_MODEL ?? 'deepseek-v4-flash',
  /** True when JUDGE_MODEL was explicitly set — then the judge stays pinned even when the client
   *  switches the main model; otherwise the judge follows the turn's selected model. */
  judgeModelExplicit: !!process.env.JUDGE_MODEL,

  // ── Observability ─────────────────────────────────────────────────────────
  langfuseEnabled: process.env.LANGFUSE_ENABLED === 'true',
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',

  // ── Main-LLM reasoning controls — passed through to the OpenAI-compatible backend ──
  // reasoning_effort: '' (omit) | minimal | low | medium | high
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? '',
  // thinking: unset/'' = omit the field; 'true' -> { type: 'enabled' }; 'false' -> { type: 'disabled' }
  llmThinkingEnabled:
    process.env.LLM_THINKING_ENABLED === undefined || process.env.LLM_THINKING_ENABLED === ''
      ? undefined
      : process.env.LLM_THINKING_ENABLED === 'true',
  // temperature: unset = omit (let the model use its default)
  llmTemperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
};

export function validateConfig() {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is required (set it in .env)');
  }
}
