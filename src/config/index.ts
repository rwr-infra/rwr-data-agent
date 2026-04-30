import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  siliconFlowApiKey: process.env.SILICONFLOW_API_KEY ?? '',
  siliconFlowBaseUrl: process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmApiKey: process.env.LLM_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL ?? process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
  llmModel: process.env.LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3',
  embeddingDimension: parseInt(process.env.EMBEDDING_DIMENSION ?? '1024', 10),
  ingestBatchSize: parseInt(process.env.INGEST_BATCH_SIZE ?? '8', 10),
  ingestConcurrency: parseInt(process.env.INGEST_CONCURRENCY ?? '2', 10),
  port: parseInt(process.env.PORT ?? '3000', 10),
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
if (!config.siliconFlowApiKey) {
  throw new Error('SILICONFLOW_API_KEY is required');
}
if (!config.llmApiKey) {
  throw new Error('LLM_API_KEY or SILICONFLOW_API_KEY is required');
}
