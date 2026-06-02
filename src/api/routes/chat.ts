import type { FastifyInstance } from 'fastify';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, streamObject } from 'ai';
import { startObservation } from '@langfuse/tracing';
import { config, validateConfig } from '../../config/index.js';
import { flushLangfuse } from '../../observability/langfuse.js';
import { search } from '../../retrieval/search.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../retrieval/prompt.js';
import { buildSearchQuery } from '../../retrieval/queryRewrite.js';
import { buildLlmProviderOptions } from '../../llm/providerOptions.js';
import { classifyQuery, isMetaQuery } from '../../retrieval/intent.js';
import { EnumResultSchema, ComparisonResultSchema } from '../../types/schemas.js';
import { getSummary, generateSummary, shouldGenerateSummary } from '../../memory/summarizer.js';
import type { ChatCompletionRequest, SearchResult } from '../../types/index.js';

let provider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  if (!provider) {
    validateConfig();
    provider = createOpenAICompatible({
      name: 'llm',
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
  }
  return provider;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post('/chat/completions', async (request, reply) => {
    const startTime = Date.now();
    const body = request.body as ChatCompletionRequest;
    const messages = body.messages ?? [];
    const msgCount = messages.length;
    const historyRounds = msgCount > 0 ? Math.ceil(messages.filter((m) => m.role !== 'system').length / 2) : 0;

    console.log(`[chat] POST /v1/chat/completions | messages=${msgCount} | rounds=${historyRounds}`);

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
      console.log(`[chat] 400 - Request too large: ~${estimatedTokens} tokens > ${effectiveLimit}`);
      return reply.status(400).send({
        error: { message: `Request too large: ~${estimatedTokens} estimated tokens exceed safe context limit (${effectiveLimit})`, type: 'invalid_request_error' },
      });
    }

    const sessionId = (request.headers['x-session-id'] as string) || undefined;
    const memorySessionId = sessionId ?? 'default';
    const queryCategory = classifyQuery(query);

    const chainObs = startObservation('chat-completions', {
      input: { query, messages: nonSystemMessages },
      metadata: { queryCategory },
    }, { asType: 'chain' });

    if (sessionId) {
      chainObs.otelSpan.setAttribute('session.id', sessionId);
    }
    chainObs.otelSpan.setAttribute('langfuse.trace.name', 'chat-completions');
    chainObs.otelSpan.setAttribute('langfuse.trace.tags', [queryCategory]);
    chainObs.otelSpan.setAttribute('langfuse.trace.input', JSON.stringify({ query, messages: nonSystemMessages }));

    let results: SearchResult[];
    let searchPath = 'none';
    let isLowConfidence = false;
    try {
      const metaDetected = isMetaQuery(query);
      if (metaDetected) {
        console.log(`[chat] Meta query detected, skipping search`);
        results = [];
      } else {
        const searchObs = chainObs.startObservation('search-pipeline', {
          input: { query, topK: 60 },
        }, { asType: 'span' });

        const historyForSearch = nonSystemMessages.slice(0, -1).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

        let summary = getSummary(memorySessionId);
        if (shouldGenerateSummary(memorySessionId, nonSystemMessages.length)) {
          generateSummary(memorySessionId, nonSystemMessages).catch(() => {});
        }

        const enrichedQuery = buildSearchQuery(query, historyForSearch, summary);
        if (enrichedQuery !== query) {
          console.log(`[chat] Query enriched: "${truncatedQuery}" → "${enrichedQuery.length > 120 ? enrichedQuery.slice(0, 120) + '…' : enrichedQuery}"`);
        }
        // Enumeration needs broad coverage (its dedicated path skips rerank); detail/comparison
        // queries stay focused. A4.
        const topK = queryCategory === 'enumeration' ? 150 : 60;
        results = await search(query, {}, topK, body.table, enrichedQuery);
        console.log(`[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}, table=${body.table ?? config.databaseTable})`);

        searchPath = 'hybrid';
        // Low confidence when the top result's rerank score is weak; fall back to the
        // count heuristic when rerank didn't run (score absent, e.g. enumeration path). A5.
        const topScore = results[0]?.score;
        isLowConfidence =
          results.length > 0 &&
          (topScore !== undefined ? topScore < config.lowConfidenceThreshold : results.length < 3);

        searchObs.update({
          output: {
            resultCount: results.length,
            searchPath,
            isLowConfidence,
            topKeys: results.slice(0, 5).map((r) => r.key),
          },
        });
        searchObs.end();
      }
    } catch (err) {
      console.error(`[chat] Search failed: ${(err as Error).message}`);
      chainObs.update({ level: 'ERROR', statusMessage: 'Search failed' });
      chainObs.end();
      reply.status(500).send({ error: { message: 'Search failed', type: 'internal_error' } });
      return;
    }

    chainObs.update({ metadata: { queryCategory, searchResults: results.length, searchPath, isLowConfidence } });

    const ragUserPrompt = buildUserPrompt(query, results, { lowConfidence: isLowConfidence });

    const historyMessages = nonSystemMessages.slice(0, -1).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    console.log(`[chat] LLM request | model=${config.llmModel} | history=${historyMessages.length}`);

    const responseFormat = body.response_format?.type ?? (request.headers['x-response-format'] as string | undefined);
    const useStructured = (queryCategory === 'enumeration' || queryCategory === 'comparison') && responseFormat === 'json_object';

    const llmMessages = [
      ...historyMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: ragUserPrompt },
    ];
    const maxTokens = Math.min(
      body.max_tokens ?? Math.max(config.maxContextTokens - estimatedTokens, 1024),
      8192,
    );

    const genObs = chainObs.startObservation('llm-generation', {
      input: { messages: llmMessages, system: SYSTEM_PROMPT },
      model: config.llmModel,
      modelParameters: { maxTokens },
    }, { asType: 'generation' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let llmError: Error | null = null;
    try {
      if (useStructured) {
        const schema = queryCategory === 'enumeration' ? EnumResultSchema : ComparisonResultSchema;
        const result = streamObject({
          model: getProvider().chatModel(config.llmModel),
          system: SYSTEM_PROMPT,
          messages: llmMessages,
          maxOutputTokens: maxTokens,
          providerOptions: buildLlmProviderOptions(),
          schema,
          onFinish: ({ object, usage }) => {
            const outputText = JSON.stringify(object).slice(0, 500);
            genObs.update({
              output: outputText,
              usageDetails: {
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
              },
            });
            chainObs.otelSpan.setAttribute('langfuse.trace.output', outputText);
          },
        });

        for await (const chunk of result.partialObjectStream) {
          const data = JSON.stringify({ type: 'json-delta', jsonDelta: chunk });
          reply.raw.write(data + '\n');
          (reply.raw as unknown as { flush?: () => void }).flush?.();
        }

        const usage = await result.usage;
        const finishData = JSON.stringify({
          type: 'finish',
          usage: { promptTokens: usage?.inputTokens, completionTokens: usage?.outputTokens },
        });
        reply.raw.write(finishData + '\n');
        (reply.raw as unknown as { flush?: () => void }).flush?.();
      } else {
        const result = streamText({
          model: getProvider().chatModel(config.llmModel),
          system: SYSTEM_PROMPT,
          messages: llmMessages,
          maxOutputTokens: maxTokens,
          providerOptions: buildLlmProviderOptions(),
          onFinish: ({ text, usage }) => {
            const outputText = text.slice(0, 500);
            genObs.update({
              output: outputText,
              usageDetails: {
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
              },
            });
            chainObs.otelSpan.setAttribute('langfuse.trace.output', outputText);
          },
        });

        // Iterate fullStream (not textStream) so reasoning parts are surfaced separately. B4.
        for await (const part of result.fullStream) {
          const p = part as { type: string; text?: string; textDelta?: string; delta?: string; error?: unknown };
          if (p.type === 'reasoning-delta' || p.type === 'reasoning') {
            const delta = p.text ?? p.textDelta ?? p.delta ?? '';
            if (delta) {
              reply.raw.write(JSON.stringify({ type: 'reasoning-delta', textDelta: delta }) + '\n');
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            }
          } else if (p.type === 'text-delta' || p.type === 'text') {
            const delta = p.text ?? p.textDelta ?? p.delta ?? '';
            if (delta) {
              reply.raw.write(JSON.stringify({ type: 'text-delta', textDelta: delta }) + '\n');
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            }
          } else if (p.type === 'error') {
            throw p.error;
          }
        }

        const usage = await result.usage;
        const finishData = JSON.stringify({
          type: 'finish',
          usage: { promptTokens: usage?.inputTokens, completionTokens: usage?.outputTokens },
        });
        reply.raw.write(finishData + '\n');
        (reply.raw as unknown as { flush?: () => void }).flush?.();
      }
    } catch (err) {
      llmError = err as Error;
      console.error(`[chat] LLM stream error: ${llmError.message}`);
      const errData = JSON.stringify({ type: 'error', error: llmError.message });
      reply.raw.write(errData + '\n');
    } finally {
      genObs.end();
      chainObs.end();
      if (config.langfuseEnabled) {
        await flushLangfuse();
      }
      reply.raw.end();
      const elapsed = Date.now() - startTime;
      if (llmError) {
        console.log(`[chat] FAILED | ${elapsed}ms | mode=${useStructured ? 'structured' : 'text'} | error=${llmError.message}`);
      } else {
        console.log(`[chat] COMPLETED | total=${elapsed}ms | mode=${useStructured ? 'structured' : 'text'}`);
      }
    }
  });
}
