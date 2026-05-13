import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { config } from '../config/index.js';
import { getCachedEmbedding, setCachedEmbedding } from '../cache/index.js';
import { createHash } from 'node:crypto';
import type { TraceHandle } from '../observability/langfuse.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const raw = new OpenAI({
      apiKey: config.siliconFlowApiKey,
      baseURL: config.siliconFlowBaseUrl,
    });
    client = config.langfuseEnabled ? observeOpenAI(raw) : raw;
  }
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createEmbeddings(inputs: string[], maxRetries = 5, trace?: TraceHandle): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const span = trace?.span('embedding', { inputCount: inputs.length, model: config.embeddingModel });

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: config.embeddingModel,
        input: inputs,
        encoding_format: 'float',
      });
      const embeddings = response.data.map((d) => d.embedding);
      span?.end({ count: embeddings.length });
      return embeddings;
    } catch (err) {
      lastError = err as Error;
      const status = (err as { status?: number }).status;

      if (status === 413) {
        if (inputs.length === 1) {
          const original = inputs[0];
          const truncated = original.slice(0, Math.floor(original.length / 2));
          console.log(`  Single item too large (${original.length} chars), truncating to ${truncated.length} chars...`);
          const result = await createEmbeddings([truncated], maxRetries, trace);
          return result;
        }
        const mid = Math.ceil(inputs.length / 2);
        console.log(`  Payload too large (413), splitting batch of ${inputs.length} into ${mid} + ${inputs.length - mid}...`);
        const left = await createEmbeddings(inputs.slice(0, mid), maxRetries, trace);
        const right = await createEmbeddings(inputs.slice(mid), maxRetries, trace);
        return [...left, ...right];
      }

      if (status === 429) {
        if (attempt === maxRetries) break;
        const delayMs = 1000 * 2 ** attempt;
        console.log(`  Rate limited (429), waiting ${delayMs}ms before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(delayMs);
        continue;
      }

      break;
    }
  }

  span?.error(lastError!);
  throw lastError;
}

export async function createEmbedding(input: string, trace?: TraceHandle): Promise<number[]> {
  const cacheKey = createHash('sha256').update(input).digest('hex').slice(0, 16);
  const cached = getCachedEmbedding(cacheKey);
  if (cached) return cached;

  const results = await createEmbeddings([input], 5, trace);
  const embedding = results[0];
  setCachedEmbedding(cacheKey, embedding);
  return embedding;
}