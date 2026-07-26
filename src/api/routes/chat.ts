import type { FastifyInstance } from 'fastify';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, streamObject, stepCountIs } from 'ai';
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
import { buildAgentTools } from '../../agent/toolDefs.js';
import type { ChatCompletionRequest, SearchResult } from '../../types/index.js';

let provider: ReturnType<typeof createOpenAICompatible> | null = null;
let agentTools: ReturnType<typeof buildAgentTools> | null | undefined;

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

/** Try to load graph tools; return null if graph.json is missing (graceful fallback to pure RAG). */
function getAgentTools(): ReturnType<typeof buildAgentTools> | null {
  if (agentTools !== undefined) return agentTools;
  try {
    agentTools = buildAgentTools();
    console.log('[chat] Agent graph tools enabled');
  } catch (err) {
    console.warn(`[chat] Graph tools unavailable (${(err as Error).message}), falling back to pure RAG`);
    agentTools = null;
  }
  return agentTools;
}

/** Char-based token estimate, matching the request-size guard divisor (chat.ts ~line 59).
 *  Used as a fallback when the upstream provider omits usage in streaming mode. */
function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 1.5);
}

/** Build a short human-readable summary of a tool call's input, shown to the UI. */
function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  if (!toolName || !input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case 'getInheritanceChain':
      return `Inheritance: ${inp.key ?? '?'}`;
    case 'findReferences':
      return `References: ${inp.key ?? '?'}`;
    case 'getTransformChain':
      return `Transform chain: ${inp.key ?? '?'}`;
    case 'readSource':
      return `Read: ${inp.file ?? '?'}${inp.startLine ? ` (L${inp.startLine}-${inp.endLine ?? ''})` : ''}`;
    case 'listFiles':
      return `List: ${inp.pattern ?? '?'}${inp.type ? ` [${inp.type}]` : ''}`;
    case 'getScriptSymbols':
      return `Script symbols: ${inp.file ?? '?'}`;
    case 'getNode':
      return `Lookup: ${inp.key ?? '?'}`;
    default:
      return toolName;
  }
}

/** Build a short summary of a tool result for the UI. */
function summarizeToolResult(toolName: string | undefined, output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const out = output as Record<string, unknown>;
  if (typeof out.total === 'number') return `${out.total} result(s)`;
  if (Array.isArray(out.chain)) return `${out.chain.length} layer(s)`;
  if (Array.isArray(out.parents)) return `${out.parents.length} parent(s)`;
  if (Array.isArray(out.referencedBy)) return `${out.referencedBy.length} ref(s)`;
  if (Array.isArray(out.symbols)) return `${out.symbols.length} symbol(s)`;
  if (typeof out.totalLines === 'number') return `${out.totalLines} line(s)`;
  return 'done';
}

/** Resolve token usage for the finish event. Many OpenAI-compatible backends omit (or return
 *  NaN/0) usage on streamed responses; in that case fall back to a char-based estimate from the
 *  real prompt (system + messages) and generated output, and flag the result as estimated so the
 *  UI can mark it (e.g. with a "~" prefix). */
function resolveUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  promptText: string,
  outputText: string,
): { promptTokens: number; completionTokens: number; estimated: boolean } {
  const valid = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const inReal = valid(usage?.inputTokens) ? usage!.inputTokens! : undefined;
  const outReal = valid(usage?.outputTokens) ? usage!.outputTokens! : undefined;
  return {
    promptTokens: inReal ?? estimateTokensFromChars(promptText),
    completionTokens: outReal ?? estimateTokensFromChars(outputText),
    estimated: inReal === undefined || outReal === undefined,
  };
}

export interface TokenBreakdown {
  systemPrompt: number;
  context: number;
  messages: number;
  reasoning: number;
  answer: number;
}

/** Break the input/output token totals down by component (system prompt, retrieved context,
 *  conversation messages; reasoning vs answer) using char-based estimates, then scale each group
 *  proportionally so the parts sum to the displayed In/Out totals. Lets the UI show "where the
 *  tokens went" even when the provider only reports aggregate usage. */
function buildBreakdown(
  chars: { system: number; context: number; messages: number; reasoning: number; answer: number },
  inputTotal: number,
  outputTotal: number,
): TokenBreakdown {
  const tok = (c: number) => Math.ceil(c / 1.5);
  const sys = tok(chars.system);
  const ctx = tok(chars.context);
  const msg = tok(chars.messages);
  const rea = tok(chars.reasoning);
  const ans = tok(chars.answer);
  const inSum = sys + ctx + msg;
  const outSum = rea + ans;
  const inScale = inSum > 0 ? inputTotal / inSum : 0;
  const outScale = outSum > 0 ? outputTotal / outSum : 0;
  const scale = (n: number, s: number) => Math.round(n * s);
  return {
    systemPrompt: scale(sys, inScale),
    context: scale(ctx, inScale),
    messages: scale(msg, inScale),
    reasoning: scale(rea, outScale),
    answer: scale(ans, outScale),
  };
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
      config.llmMaxOutputTokens,
    );

    // Real prompt sent to the model (system + messages), used to estimate input tokens when the
    // provider omits usage. Includes the RAG context the frontend can't see, so it is far more
    // accurate than a client-side estimate.
    const promptText = SYSTEM_PROMPT + '\n' + llmMessages.map((m) => m.content).join('\n');

    // Char counts per input component for the token breakdown. The RAG user prompt wraps the
    // retrieved docs + instructions around the question, so "context" is that prompt minus the
    // raw question, and "messages" is the conversation history plus the question itself.
    const historyChars = historyMessages.reduce((sum, m) => sum + m.content.length, 0);
    const inputChars = {
      system: SYSTEM_PROMPT.length,
      context: Math.max(ragUserPrompt.length - query.length, 0),
      messages: historyChars + query.length,
    };

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

        let lastObject: unknown = null;
        for await (const chunk of result.partialObjectStream) {
          lastObject = chunk;
          const data = JSON.stringify({ type: 'json-delta', jsonDelta: chunk });
          reply.raw.write(data + '\n');
          (reply.raw as unknown as { flush?: () => void }).flush?.();
        }

        const usage = await result.usage;
        const answerText = JSON.stringify(lastObject ?? {});
        const resolved = resolveUsage(usage, promptText, answerText);
        const breakdown = buildBreakdown(
          { ...inputChars, reasoning: 0, answer: answerText.length },
          resolved.promptTokens,
          resolved.completionTokens,
        );
        const finishData = JSON.stringify({
          type: 'finish',
          usage: {
            promptTokens: resolved.promptTokens,
            completionTokens: resolved.completionTokens,
            estimated: resolved.estimated,
            breakdown,
          },
        });
        reply.raw.write(finishData + '\n');
        (reply.raw as unknown as { flush?: () => void }).flush?.();
      } else {
        const tools = getAgentTools();
        const result = streamText({
          model: getProvider().chatModel(config.llmModel),
          system: SYSTEM_PROMPT,
          messages: llmMessages,
          maxOutputTokens: maxTokens,
          ...(tools ? { tools, stopWhen: stepCountIs(5) } : {}),
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
        // Accumulate reasoning vs answer chars separately to estimate output tokens (and the
        // breakdown) when the provider omits usage.
        let reasoningText = '';
        let answerText = '';
        let toolCallCount = 0;
        for await (const part of result.fullStream) {
          const p = part as {
            type: string;
            text?: string;
            textDelta?: string;
            delta?: string;
            error?: unknown;
            toolName?: string;
            input?: unknown;
            output?: unknown;
          };
          if (process.env.DEBUG_AGENT === '1') {
            console.log(`[agent-stream] type=${p.type} toolName=${p.toolName ?? ''} hasText=${!!(p.text ?? p.textDelta ?? p.delta)}`);
          }
          if (p.type === 'reasoning-delta' || p.type === 'reasoning') {
            const delta = p.text ?? p.textDelta ?? p.delta ?? '';
            if (delta) {
              reasoningText += delta;
              reply.raw.write(JSON.stringify({ type: 'reasoning-delta', textDelta: delta }) + '\n');
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            }
          } else if (p.type === 'text-delta' || p.type === 'text') {
            const delta = p.text ?? p.textDelta ?? p.delta ?? '';
            if (delta) {
              answerText += delta;
              reply.raw.write(JSON.stringify({ type: 'text-delta', textDelta: delta }) + '\n');
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            }
          } else if (p.type === 'tool-call') {
            toolCallCount++;
            const summary = summarizeToolInput(p.toolName, p.input);
            reply.raw.write(JSON.stringify({ type: 'tool-step', toolName: p.toolName, summary }) + '\n');
            (reply.raw as unknown as { flush?: () => void }).flush?.();
          } else if (p.type === 'tool-result') {
            reply.raw.write(
              JSON.stringify({ type: 'tool-step', toolName: p.toolName, done: true, summary: summarizeToolResult(p.toolName, p.output) }) + '\n',
            );
            (reply.raw as unknown as { flush?: () => void }).flush?.();
          } else if (p.type === 'error') {
            throw p.error;
          }
        }

        if (toolCallCount > 0) {
          console.log(`[chat] Agent used ${toolCallCount} tool call(s)`);
        }

        const usage = await result.usage;
        const resolved = resolveUsage(usage, promptText, reasoningText + answerText);
        const breakdown = buildBreakdown(
          { ...inputChars, reasoning: reasoningText.length, answer: answerText.length },
          resolved.promptTokens,
          resolved.completionTokens,
        );
        const finishData = JSON.stringify({
          type: 'finish',
          usage: {
            promptTokens: resolved.promptTokens,
            completionTokens: resolved.completionTokens,
            estimated: resolved.estimated,
            breakdown,
          },
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
