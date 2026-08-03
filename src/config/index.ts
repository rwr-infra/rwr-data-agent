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

/** Parse a positive integer from an env var, falling back to `fallback` on missing/garbage. The
 *  plain `parseInt(env ?? 'N')` idiom returns NaN for non-numeric input, which silently breaks
 *  loop bounds downstream (e.g. `BEST_OF_N='abc'` → NaN candidates → empty best-of-N turn). */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
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
   * Per-candidate agent step cap. The normal loop's `stepCountIs(100)` is a runaway backstop,
   * not a budget — a single question has measured 2.5M input tokens — and best-of-N multiplies
   * that by N, so each candidate gets a deliberately tight cap.
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
