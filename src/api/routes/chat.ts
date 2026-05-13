import type { FastifyInstance } from 'fastify';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, streamObject } from 'ai';
import { observe, propagateAttributes, setActiveTraceIO, startActiveObservation, updateActiveObservation } from '@langfuse/tracing';
import { config, validateConfig } from '../../config/index.js';
import { search } from '../../retrieval/search.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../retrieval/prompt.js';
import { buildSearchQuery } from '../../retrieval/queryRewrite.js';
import { extractQueryIntent } from '../../retrieval/search.js';
import { classifyQuery } from '../../retrieval/intent.js';
import { EnumResultSchema, ComparisonResultSchema } from '../../types/schemas.js';
import { getSummary, generateSummary, shouldGenerateSummary } from '../../memory/summarizer.js';
import type { ChatCompletionRequest } from '../../types/index.js';

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

    const tracedHandler = observe(
      async () => {
        await propagateAttributes({
          traceName: 'chat-completions',
          sessionId,
          tags: [queryCategory],
        }, async () => {
          setActiveTraceIO({ input: query });
          updateActiveObservation({
            input: { query, messages: nonSystemMessages },
            metadata: { queryCategory },
          });

          let results;
          try {
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
            const searchIntent = extractQueryIntent(query);
            const topK = searchIntent.isEnumeration ? 30 : 5;
            results = await search(query, {}, topK, body.table, enrichedQuery);
            console.log(`[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}, table=${body.table ?? config.databaseTable})`);
          } catch (err) {
            console.error(`[chat] Search failed: ${(err as Error).message}`);
            reply.status(500).send({ error: { message: 'Search failed', type: 'internal_error' } });
            return;
          }

          updateActiveObservation({
            metadata: { queryCategory, searchResults: results.length },
          });

          const ragUserPrompt = buildUserPrompt(query, results);

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
          const maxTokens = body.max_tokens ?? Math.max(config.maxContextTokens - estimatedTokens, 1024);

          reply.raw.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          const llmResult: { error: Error | null; useStructuredMode: boolean } = { error: null, useStructuredMode: false };
          await startActiveObservation(
            'llm-generation',
            async (genObservation) => {
              genObservation.update({
                input: { messages: llmMessages, system: SYSTEM_PROMPT },
                model: config.llmModel,
                modelParameters: { maxTokens },
              });

              try {
                if (useStructured) {
                  llmResult.useStructuredMode = true;
                  const schema = queryCategory === 'enumeration' ? EnumResultSchema : ComparisonResultSchema;
                  const result = streamObject({
                    model: getProvider().chatModel(config.llmModel),
                    system: SYSTEM_PROMPT,
                    messages: llmMessages,
                    maxOutputTokens: maxTokens,
                    schema,
                    onFinish: ({ object, usage }) => {
                      const outputText = JSON.stringify(object).slice(0, 500);
                      setActiveTraceIO({ output: outputText });
                      updateActiveObservation({
                        output: outputText,
                        usageDetails: {
                          inputTokens: usage?.inputTokens,
                          outputTokens: usage?.outputTokens,
                          totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
                        },
                      }, { asType: 'generation' });
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
                    onFinish: ({ text, usage }) => {
                      const outputText = text.slice(0, 500);
                      setActiveTraceIO({ output: outputText });
                      updateActiveObservation({
                        output: outputText,
                        usageDetails: {
                          inputTokens: usage?.inputTokens,
                          outputTokens: usage?.outputTokens,
                          totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
                        },
                      }, { asType: 'generation' });
                    },
                  });

                  for await (const textPart of result.textStream) {
                    const data = JSON.stringify({ type: 'text-delta', textDelta: textPart });
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
                }
              } catch (err) {
                llmResult.error = err as Error;
                console.error(`[chat] LLM stream error: ${llmResult.error.message}`);
                const errData = JSON.stringify({ type: 'error', error: llmResult.error.message });
                reply.raw.write(errData + '\n');
              }
            },
            { asType: 'generation' },
          );

          reply.raw.end();
          const elapsed = Date.now() - startTime;
          if (llmResult.error) {
            console.log(`[chat] FAILED | ${elapsed}ms | mode=${llmResult.useStructuredMode ? 'structured' : 'text'} | error=${llmResult.error.message}`);
          } else {
            console.log(`[chat] COMPLETED | total=${elapsed}ms | mode=${llmResult.useStructuredMode ? 'structured' : 'text'}`);
          }
        });
      },
      {
        name: 'chat-completions',
        asType: 'chain',
        captureInput: false,
        captureOutput: false,
      },
    );

    await tracedHandler();
  });
}
