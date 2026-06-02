import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseProvider: (process.env.DATABASE_PROVIDER ?? 'pg') as 'pg' | 'neon',
  databasePoolMax: parseInt(process.env.DATABASE_POOL_MAX ?? '20', 10),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  siliconFlowApiKey: process.env.SILICONFLOW_API_KEY ?? '',
  siliconFlowBaseUrl: process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmApiKey: process.env.LLM_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL ?? process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmModel: process.env.LLM_MODEL ?? 'deepseek-v4-flash',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3',
  embeddingDimension: parseInt(process.env.EMBEDDING_DIMENSION ?? '1024', 10),
  rerankModel: process.env.RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3',
  databaseTable: process.env.DATABASE_TABLE ?? 'rwr_documents',
  ingestBatchSize: parseInt(process.env.INGEST_BATCH_SIZE ?? '8', 10),
  ingestConcurrency: parseInt(process.env.INGEST_CONCURRENCY ?? '2', 10),
  port: parseInt(process.env.PORT ?? '3000', 10),
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '200000', 10),
  cacheEnabled: process.env.CACHE_ENABLED !== 'false',
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS ?? '600', 10),
  langfuseEnabled: process.env.LANGFUSE_ENABLED === 'true',
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
  summaryIntervalTurns: parseInt(process.env.SUMMARY_INTERVAL_TURNS ?? '3', 10),
  summaryModel: process.env.SUMMARY_MODEL ?? process.env.LLM_MODEL ?? 'deepseek-v4-flash',
  rrfK: parseInt(process.env.RRF_K ?? '60', 10),
  rrfWeightVector: parseFloat(process.env.RRF_WEIGHT_VECTOR ?? '0.50'),
  rrfWeightFts: parseFloat(process.env.RRF_WEIGHT_FTS ?? '0.35'),
  rrfWeightIlike: parseFloat(process.env.RRF_WEIGHT_ILIKE ?? '0.15'),
  rerankDocTruncate: parseInt(process.env.RERANK_DOC_TRUNCATE ?? '800', 10),
  rerankPinnedPrefix: process.env.RERANK_PINNED_PREFIX !== 'false',
  // HNSW tuning: ef_search controls ANN recall breadth. 0 = derive dynamically (~2x query limit, capped).
  hnswEfSearch: parseInt(process.env.HNSW_EF_SEARCH ?? '0', 10),
  // Low-confidence threshold on the top-1 rerank relevance score (0-1). Below this, warn the LLM.
  lowConfidenceThreshold: parseFloat(process.env.LOW_CONFIDENCE_THRESHOLD ?? '0.3'),
  // FTS weight multiplier applied when the query is (near-)pure CJK, where FTS('simple') is unreliable.
  rrfFtsCjkScale: parseFloat(process.env.RRF_FTS_CJK_SCALE ?? '0.3'),
  // Main-LLM reasoning controls — transparently passed through to the OpenAI-compatible backend.
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
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (!config.siliconFlowApiKey) {
    throw new Error('SILICONFLOW_API_KEY is required');
  }
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY or SILICONFLOW_API_KEY is required');
  }
}