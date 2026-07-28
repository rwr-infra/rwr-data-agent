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
   * Watch the plugin directory and reload on change. Off in production and on Vercel,
   * where the filesystem is read-only and a watcher buys nothing.
   */
  toolsHotReload:
    process.env.TOOLS_HOT_RELOAD !== undefined
      ? process.env.TOOLS_HOT_RELOAD === 'true'
      : process.env.NODE_ENV !== 'production' && !process.env.VERCEL,

  // ── Server ────────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT ?? '3000', 10),
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '500000', 10),
  // Cap on generated output tokens (reasoning + answer share this budget). Bounds long
  // enumerations/comparisons; raise if answers get truncated. DeepSeek-V4 allows up to 384K.
  llmMaxOutputTokens: parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '32768', 10),

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
