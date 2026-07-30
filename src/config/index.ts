import 'dotenv/config';
import * as path from 'path';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const outputDir = path.resolve(process.env.OUTPUT_DIR ?? './output');

export const config = {
  // ── LLM (the only required external service) ──────────────────────────────
  // SILICONFLOW_* is still honoured as a fallback so pre-existing .env files keep working.
  llmApiKey: process.env.LLM_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmModel: process.env.LLM_MODEL ?? 'deepseek-v4-flash',

  // ── Local data & index ────────────────────────────────────────────────────
  /** Data root — either a single RWR package or a directory of packages. */
  dataDir,
  outputDir,
  graphPath: process.env.GRAPH_PATH ? path.resolve(process.env.GRAPH_PATH) : path.join(outputDir, 'graph.json'),
  searchIndexPath: process.env.SEARCH_INDEX_PATH
    ? path.resolve(process.env.SEARCH_INDEX_PATH)
    : path.join(outputDir, 'search-index.json'),
  /** Build/refresh the index at startup when it is missing or stale. */
  autoBuildIndex: process.env.AUTO_BUILD_INDEX !== 'false',

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
