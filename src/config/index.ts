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
  llmModel: process.env.LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct',
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
  summaryModel: process.env.SUMMARY_MODEL ?? process.env.LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct',
  rrfK: parseInt(process.env.RRF_K ?? '60', 10),
  rrfWeightVector: parseFloat(process.env.RRF_WEIGHT_VECTOR ?? '0.50'),
  rrfWeightFts: parseFloat(process.env.RRF_WEIGHT_FTS ?? '0.35'),
  rrfWeightIlike: parseFloat(process.env.RRF_WEIGHT_ILIKE ?? '0.15'),
  rerankDocTruncate: parseInt(process.env.RERANK_DOC_TRUNCATE ?? '800', 10),
  rerankPinnedPrefix: process.env.RERANK_PINNED_PREFIX !== 'false',
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