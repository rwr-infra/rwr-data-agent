import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { config, validateConfig } from '../../config/index.js';
import { search } from '../../retrieval/search.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../retrieval/prompt.js';
import { buildSearchQuery } from '../../retrieval/queryRewrite.js';
import { extractQueryIntent } from '../../retrieval/search.js';
import type { ChatCompletionRequest } from '../../types/index.js';

let llmClient: OpenAI | null = null;

function getLlmClient(): OpenAI {
  if (!llmClient) {
    validateConfig();
    llmClient = new OpenAI({
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
  }
  return llmClient;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post('/chat/completions', async (request, reply) => {
    const startTime = Date.now();
    const body = request.body as ChatCompletionRequest;
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;
    const msgCount = messages.length;
    const historyRounds = msgCount > 0 ? Math.ceil(messages.filter((m) => m.role !== 'system').length / 2) : 0;

    console.log(`[chat] POST /v1/chat/completions | stream=${stream} | messages=${msgCount} | rounds=${historyRounds}`);

    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const lastUserMessage = [...nonSystemMessages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) {
      console.log('[chat] 400 - No user message found');
      return reply.status(400).send({
        error: { message: 'No user message found', type: 'invalid_request_error' },
      });
    }

    const externalSystemCount = messages.length - nonSystemMessages.length;
    if (externalSystemCount > 0) {
      console.log(`[chat] Ignored ${externalSystemCount} external system message(s). Server-side SYSTEM_PROMPT is enforced.`);
    }

    const query = lastUserMessage.content;
    const truncatedQuery = query.length > 80 ? query.slice(0, 80) + '…' : query;
    console.log(`[chat] Query: "${truncatedQuery}"`);

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 1.5);
    const effectiveLimit = Math.floor(config.maxContextTokens * 0.7);
    if (estimatedTokens > effectiveLimit) {
      console.log(`[chat] 400 - Request too large: ~${estimatedTokens} tokens > ${effectiveLimit} (70% of ${config.maxContextTokens}, reserved for system prompt + RAG context)`);
      return reply.status(400).send({
        error: { message: `Request too large: ~${estimatedTokens} estimated tokens exceed safe context limit (${effectiveLimit}, reserved space for system prompt and retrieval context)`, type: 'invalid_request_error' },
      });
    }

    let results;
    try {
      const historyForSearch = nonSystemMessages.slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      const enrichedQuery = buildSearchQuery(query, historyForSearch);
      if (enrichedQuery !== query) {
        console.log(`[chat] Query enriched: "${truncatedQuery}" → "${enrichedQuery.length > 120 ? enrichedQuery.slice(0, 120) + '…' : enrichedQuery}"`);
      }
      const searchIntent = extractQueryIntent(query);
      const topK = searchIntent.isEnumeration ? 30 : 5;
      results = await search(query, {}, topK, body.table, enrichedQuery);
      console.log(`[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}, table=${body.table ?? config.databaseTable})`);
    } catch (err) {
      console.error(`[chat] Search failed: ${(err as Error).message}`);
      return reply.status(500).send({ error: { message: 'Search failed', type: 'internal_error' } });
    }

    const ragUserPrompt = buildUserPrompt(query, results);

    const historyMessages = nonSystemMessages.slice(0, -1).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const llmMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historyMessages,
      { role: 'user', content: ragUserPrompt },
    ];

    console.log(`[chat] LLM request | model=${config.llmModel} | history=${historyMessages.length} | stream=${stream}`);

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let llmError: Error | null = null;
      let chunkCount = 0;
      let ttfb = 0;
      let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      try {
        const response = await getLlmClient().chat.completions.create({
          model: config.llmModel,
          messages: llmMessages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: body.max_tokens ?? Math.max(config.maxContextTokens - estimatedTokens, 1024),
        });

        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        for await (const chunk of response) {
          chunkCount++;
          if (ttfb === 0 && chunk.choices[0]?.delta?.content) {
            ttfb = Date.now() - startTime;
          }
          if (chunk.usage) {
            lastUsage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }
          const data = JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model ?? config.llmModel,
            choices: [
              {
                index: 0,
                delta: { content: chunk.choices[0]?.delta?.content ?? '' },
                finish_reason: chunk.choices[0]?.finish_reason,
              },
            ],
            usage: chunk.usage ?? undefined,
          });
          reply.raw.write(`data: ${data}\n\n`);
          (reply.raw as unknown as { flush?: () => void }).flush?.();
        }

        reply.raw.write('data: [DONE]\n\n');
        (reply.raw as unknown as { flush?: () => void }).flush?.();
      } catch (err) {
        llmError = err as Error;
        console.error(`[chat] LLM stream error after ${chunkCount} chunks: ${llmError.message}`);
      } finally {
        reply.raw.end();
        const elapsed = Date.now() - startTime;
        const inTok = lastUsage?.prompt_tokens ?? '-';
        const outTok = lastUsage?.completion_tokens ?? '-';
        if (llmError) {
          console.log(`[chat] FAILED | ${elapsed}ms | chunks=${chunkCount} | error=${llmError.message}`);
        } else {
          console.log(`[chat] COMPLETED | TTFB=${ttfb}ms | total=${elapsed}ms | chunks=${chunkCount} | in=${inTok} out=${outTok} tokens`);
        }
      }
      return;
    }

    try {
      const response = await getLlmClient().chat.completions.create({
        model: config.llmModel,
        messages: llmMessages,
        temperature: body.temperature ?? 0.7,
        max_tokens: body.max_tokens ?? Math.max(config.maxContextTokens - estimatedTokens, 1024),
        top_p: body.top_p ?? 1,
      });

      const choice = response.choices[0];
      const contentLen = choice?.message?.content?.length ?? 0;
      const elapsed = Date.now() - startTime;
      const ttfb = elapsed;
      const inTok = response.usage?.prompt_tokens ?? '-';
      const outTok = response.usage?.completion_tokens ?? '-';
      console.log(`[chat] COMPLETED | TTFB=${ttfb}ms | total=${elapsed}ms | in=${inTok} out=${outTok} tokens | content_len=${contentLen}`);

      return {
        id: response.id,
        object: 'chat.completion',
        created: response.created,
        model: body.model ?? config.llmModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content: choice?.message?.content ?? '',
            },
            finish_reason: choice?.finish_reason ?? 'stop',
          },
        ],
        usage: response.usage,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.error(`[chat] LLM non-stream error | ${elapsed}ms | ${(err as Error).message}`);
      return reply.status(502).send({ error: { message: 'LLM request failed', type: 'upstream_error' } });
    }
  });
}
