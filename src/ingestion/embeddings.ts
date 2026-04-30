import OpenAI from 'openai';
import { config } from '../config/index.js';

const client = new OpenAI({
  apiKey: config.siliconFlowApiKey,
  baseURL: config.siliconFlowBaseUrl,
});

export async function createEmbeddings(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: inputs,
    encoding_format: 'float',
  });
  return response.data.map((d) => d.embedding);
}

export async function createEmbedding(input: string): Promise<number[]> {
  const results = await createEmbeddings([input]);
  return results[0];
}
