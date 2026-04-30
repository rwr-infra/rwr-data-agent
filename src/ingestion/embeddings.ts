import OpenAI from 'openai';
import { config } from '../config/index.js';

const client = new OpenAI({
  apiKey: config.siliconFlowApiKey,
  baseURL: config.siliconFlowBaseUrl,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create embeddings with automatic retry on 429 and recursive split on 413.
 */
export async function createEmbeddings(inputs: string[], maxRetries = 5): Promise<number[][]> {
  if (inputs.length === 0) return [];

  // Try the batch as-is first
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: config.embeddingModel,
        input: inputs,
        encoding_format: 'float',
      });
      return response.data.map((d) => d.embedding);
    } catch (err) {
      lastError = err as Error;
      const status = (err as { status?: number }).status;

      if (status === 413) {
        // Payload too large — split and recurse
        if (inputs.length === 1) {
          // Single item too large: truncate and retry once
          const original = inputs[0];
          const truncated = original.slice(0, Math.floor(original.length / 2));
          console.log(`  Single item too large (${original.length} chars), truncating to ${truncated.length} chars...`);
          const result = await createEmbeddings([truncated], maxRetries);
          return result;
        }
        const mid = Math.ceil(inputs.length / 2);
        console.log(`  Payload too large (413), splitting batch of ${inputs.length} into ${mid} + ${inputs.length - mid}...`);
        const left = await createEmbeddings(inputs.slice(0, mid), maxRetries);
        const right = await createEmbeddings(inputs.slice(mid), maxRetries);
        return [...left, ...right];
      }

      if (status === 429) {
        if (attempt === maxRetries) throw err;
        const delayMs = 1000 * 2 ** attempt;
        console.log(`  Rate limited (429), waiting ${delayMs}ms before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(delayMs);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

export async function createEmbedding(input: string): Promise<number[]> {
  const results = await createEmbeddings([input]);
  return results[0];
}
