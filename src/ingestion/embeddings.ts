import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { config } from '../config/index.js';
import { getCachedEmbedding, setCachedEmbedding } from '../cache/index.js';
import { createHash } from 'node:crypto';
import { getTracer } from '../observability/langfuse.js';

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

export async function createEmbeddings(inputs: string[], maxRetries = 5): Promise<number[][]> {
  if (inputs.length === 0) return [];

  return getTracer().startActiveSpan('embedding', (span) => {
    span.setAttribute('input.count', inputs.length);
    span.setAttribute('model', config.embeddingModel);

    return execEmbeddings(inputs, maxRetries, span);
  });
}

async function execEmbeddings(inputs: string[], maxRetries: number, span: Span): Promise<number[][]> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: config.embeddingModel,
        input: inputs,
        encoding_format: 'float',
      });
      const embeddings = response.data.map((d) => d.embedding);
      span.setAttribute('output.count', embeddings.length);
      span.end();
      return embeddings;
    } catch (err) {
      lastError = err as Error;
      const status = (err as { status?: number }).status;

      if (status === 413) {
        if (inputs.length === 1) {
          const original = inputs[0];
          const truncated = original.slice(0, Math.floor(original.length / 2));
          console.log(`  Single item too large (${original.length} chars), truncating to ${truncated.length} chars...`);
          const result = await execEmbeddings([truncated], maxRetries, span);
          return result;
        }
        const mid = Math.ceil(inputs.length / 2);
        console.log(`  Payload too large (413), splitting batch of ${inputs.length} into ${mid} + ${inputs.length - mid}...`);
        const left = await execEmbeddings(inputs.slice(0, mid), maxRetries, span);
        const right = await execEmbeddings(inputs.slice(mid), maxRetries, span);
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

  span.setStatus({ code: SpanStatusCode.ERROR, message: lastError?.message });
  span.end();
  throw lastError;
}

export async function createEmbedding(input: string): Promise<number[]> {
  const cacheKey = createHash('sha256').update(input).digest('hex').slice(0, 16);
  const cached = getCachedEmbedding(cacheKey);
  if (cached) return cached;

  const results = await createEmbeddings([input]);
  const embedding = results[0];
  setCachedEmbedding(cacheKey, embedding);
  return embedding;
}
