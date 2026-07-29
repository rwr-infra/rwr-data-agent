import * as fsSync from 'fs';
import type { FastifyInstance } from 'fastify';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, streamObject, stepCountIs } from 'ai';
import { startObservation } from '@langfuse/tracing';
import { config, validateConfig } from '../../config/index.js';
import { flushLangfuse } from '../../observability/langfuse.js';
import { search as localSearch, configureSearch } from '../../retrieval/localSearch.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../retrieval/prompt.js';
import { buildSearchQuery } from '../../retrieval/queryRewrite.js';
import { buildLlmProviderOptions } from '../../llm/providerOptions.js';
import { classifyQuery, isMetaQuery } from '../../retrieval/intent.js';
import { EnumResultSchema, ComparisonResultSchema } from '../../types/schemas.js';
import { getSummary, generateSummary, shouldGenerateSummary } from '../../memory/summarizer.js';
import { getAgentTools as loadAgentTools } from '../../agent/toolDefs.js';
import { createToolTranscriptShaper } from '../../agent/toolTranscript.js';
import {
  buildBreakdown,
  estimateTokens,
  measureToolCallTokens,
  measureToolDefTokens,
  measureTurn,
  resolveUsage,
} from '../tokenAccounting.js';
import type { Tool } from 'ai';
import type { ChatCompletionRequest, SearchResult } from '../../types/index.js';

let provider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  if (!provider) {
    validateConfig();
    provider = createOpenAICompatible({
      name: 'llm',
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
      // DEBUG_HTTP dumps the last outgoing request body — the only reliable way to see
      // what the provider converter actually produced when a backend rejects a message.
      ...(process.env.DEBUG_HTTP
        ? {
            fetch: async (...args: Parameters<typeof fetch>) => {
              try {
                // The converter always produces a JSON string body; anything else
                // (stream, Blob) has no useful on-disk form.
                const body = args[1]?.body;
                fsSync.writeFileSync('/tmp/rwr-wire.json', typeof body === 'string' ? body : '');
              } catch {
                // Debug-only dump; never let it break the actual request.
              }
              return fetch(...args);
            },
          }
        : {}),
    });
  }
  return provider;
}

/**
 * Built-in graph tools + runtime plugins. Returns null if the registry cannot be built
 * at all (graceful fallback to pure RAG). Re-queried per request so a hot-reloaded
 * plugin takes effect without a restart.
 */
async function getAgentTools(): Promise<Record<string, Tool> | null> {
  try {
    return await loadAgentTools();
  } catch (err) {
    console.warn(`[chat] Agent tools unavailable (${(err as Error).message}), falling back to pure RAG`);
    return null;
  }
}

/**
 * Read one field of a tool input as a display string. Tool inputs are model-produced
 * JSON, so every field is `unknown` — anything non-scalar has no useful label form.
 */
function inputField(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Build a short human-readable summary of a tool call's input, shown to the UI. */
function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  if (!toolName || !input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  const key = inputField(inp, 'key') || '?';
  const file = inputField(inp, 'file') || '?';
  switch (toolName) {
    case 'searchDocs': {
      const type = inputField(inp, 'type');
      return `Search: ${inputField(inp, 'query') || '?'}${type ? ` [${type}]` : ''}`;
    }
    case 'getInheritanceChain':
      return `Inheritance: ${key}`;
    case 'findReferences':
      return `References: ${key}`;
    case 'getTransformChain':
      return `Transform chain: ${key}`;
    case 'readSource': {
      const startLine = inputField(inp, 'startLine');
      return `Read: ${file}${startLine ? ` (L${startLine}-${inputField(inp, 'endLine')})` : ''}`;
    }
    case 'listFiles': {
      const type = inputField(inp, 'type');
      return `List: ${inputField(inp, 'pattern') || '?'}${type ? ` [${type}]` : ''}`;
    }
    case 'getScriptSymbols':
      return `Script symbols: ${file}`;
    case 'getNode':
      return `Lookup: ${key}`;
    case 'lookupUpgrade':
      return `Upgrade lookup: ${inputField(inp, 'query') || '?'}`;
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

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: register() awaits the returned promise, so `async` is the interface here.
export async function chatRoutes(app: FastifyInstance) {
  // Point the local MiniSearch index at the configured path (loaded lazily / by bootstrap).
  configureSearch(config.searchIndexPath);

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

        const summary = getSummary(memorySessionId);
        if (shouldGenerateSummary(memorySessionId, nonSystemMessages.length)) {
          generateSummary(memorySessionId, nonSystemMessages).catch(() => {});
        }

        const enrichedQuery = buildSearchQuery(query, historyForSearch, summary);
        if (enrichedQuery !== query) {
          console.log(`[chat] Query enriched: "${truncatedQuery}" → "${enrichedQuery.length > 120 ? enrichedQuery.slice(0, 120) + '…' : enrichedQuery}"`);
        }
        // Enumeration needs broad coverage; detail/comparison queries stay focused.
        const topK = queryCategory === 'enumeration' ? 150 : 30;
        const filters = body.mod ? { mod_name: body.mod } : {};
        results = await localSearch(query, filters, topK, enrichedQuery);
        console.log(
          `[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}${body.mod ? `, mod=${body.mod}` : ''})`,
        );

        searchPath = 'local-index';
        // Low confidence heuristic: fewer than 3 results indicates a weak match.
        isLowConfidence = results.length > 0 && results.length < 3;

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
        role: m.role,
        content: m.content,
      })),
      { role: 'user' as const, content: ragUserPrompt },
    ];
    const maxTokens = Math.min(
      body.max_tokens ?? Math.max(config.maxContextTokens - estimatedTokens, 1024),
      config.llmMaxOutputTokens,
    );

    // Per-component token estimates for the breakdown, and the fallback input total when the
    // provider omits usage. Measured server-side, so they include the RAG context the frontend
    // can't see. The RAG user prompt wraps the retrieved docs + instructions around the question,
    // so "context" is that prompt minus the raw question, and "messages" is the conversation
    // history plus the question itself.
    const queryTokens = estimateTokens(query);
    const inputTokens = {
      system: estimateTokens(SYSTEM_PROMPT),
      context: Math.max(estimateTokens(ragUserPrompt) - queryTokens, 0),
      messages: historyMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0) + queryTokens,
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
        // Structured mode has no tool loop: a single step, no tool definitions in the prompt.
        const basis = measureTurn({ ...inputTokens, toolDefs: 0, reasoning: 0, answer: estimateTokens(answerText) }, {
          replay: [],
          toolCallTokens: 0,
        });
        const resolved = resolveUsage(usage, usage, basis);
        const breakdown = buildBreakdown(basis, resolved);
        const finishData = JSON.stringify({
          type: 'finish',
          usage: {
            promptTokens: resolved.promptTokens,
            completionTokens: resolved.completionTokens,
            contextTokens: resolved.contextTokens,
            maxContextTokens: config.maxContextTokens,
            estimated: resolved.estimated,
            breakdown,
          },
        });
        reply.raw.write(finishData + '\n');
        (reply.raw as unknown as { flush?: () => void }).flush?.();
      } else {
        const tools = await getAgentTools();
        const toolDefTokens = measureToolDefTokens(tools);
        // Tool results are replayed in full; the shaper only sheds them if a step's prompt would
        // otherwise overflow the window. The system prompt, tool definitions and the output
        // reservation ride alongside `messages`, so they come off the budget first.
        const shaper = createToolTranscriptShaper({
          budgetTokens:
            Math.floor(config.maxContextTokens * config.toolContextBudgetRatio) -
            inputTokens.system -
            toolDefTokens -
            maxTokens,
          shedTargetTokens: config.toolShedResultTokens,
        });
        const result = streamText({
          model: getProvider().chatModel(config.llmModel),
          system: SYSTEM_PROMPT,
          messages: llmMessages,
          maxOutputTokens: maxTokens,
          ...(tools
            ? {
                tools,
                stopWhen: stepCountIs(100),
                prepareStep: ({ messages }) => shaper.prepare(messages as Record<string, unknown>[]) as never,
              }
            : {}),
          providerOptions: buildLlmProviderOptions(),
          onFinish: ({ text, totalUsage }) => {
            const outputText = text.slice(0, 500);
            // `totalUsage`, not `usage`: the latter reports only the tool loop's final step.
            genObs.update({
              output: outputText,
              usageDetails: {
                inputTokens: totalUsage?.inputTokens ?? 0,
                outputTokens: totalUsage?.outputTokens ?? 0,
                totalTokens: (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0),
                ...(totalUsage?.outputTokenDetails?.reasoningTokens
                  ? { reasoningTokens: totalUsage.outputTokenDetails.reasoningTokens }
                  : {}),
                ...(totalUsage?.inputTokenDetails?.cacheReadTokens
                  ? { cacheReadInputTokens: totalUsage.inputTokenDetails.cacheReadTokens }
                  : {}),
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
          const finishReason = await result.finishReason;
          console.log(`[chat] Agent used ${toolCallCount} tool call(s) | finishReason=${finishReason} | answerLen=${answerText.length}`);

          // Step-limit guard: if the loop stopped because of step count but the model was still
          // requesting tool calls (no final text answer), surface an explicit error instead of
          // silently truncating.
          if (finishReason === 'tool-calls' && answerText.trim().length === 0) {
            const stepLimitMsg = `工具调用已达步数上限（100步），模型未能产出最终答案。请尝试缩小问题范围或换用更具体的关键词重试。`;
            reply.raw.write(JSON.stringify({ type: 'error', error: stepLimitMsg }) + '\n');
            (reply.raw as unknown as { flush?: () => void }).flush?.();
            chainObs.update({ level: 'ERROR', statusMessage: 'Agent step limit reached' });
          }
        }

        // `totalUsage` sums every step of the tool loop; `usage` is the last step alone, which is
        // what still occupies the context window.
        const [totalUsage, lastStepUsage, stepResults] = await Promise.all([
          result.totalUsage,
          result.usage,
          result.steps,
        ]);
        const basis = measureTurn(
          {
            ...inputTokens,
            toolDefs: toolDefTokens,
            reasoning: estimateTokens(reasoningText),
            answer: estimateTokens(answerText),
          },
          { replay: shaper.replay, toolCallTokens: measureToolCallTokens(stepResults) },
        );
        const resolved = resolveUsage(totalUsage, lastStepUsage, basis);
        const breakdown = buildBreakdown(basis, resolved);
        const finishData = JSON.stringify({
          type: 'finish',
          usage: {
            promptTokens: resolved.promptTokens,
            completionTokens: resolved.completionTokens,
            contextTokens: resolved.contextTokens,
            maxContextTokens: config.maxContextTokens,
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
