import * as fsSync from 'fs';
import type { FastifyInstance } from 'fastify';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, streamObject, stepCountIs } from 'ai';
import { startObservation } from '@langfuse/tracing';
import { config, validateConfig } from '../../config/index.js';
import { flushLangfuse } from '../../observability/langfuse.js';
import { search as localSearch, configureSearch } from '../../retrieval/localSearch.js';
import { buildSystemPrompt, buildUserPrompt } from '../../retrieval/prompt.js';
import { buildSearchQuery } from '../../retrieval/queryRewrite.js';
import { buildLlmProviderOptions } from '../../llm/providerOptions.js';
import {
  classifyQuery,
  extractExactKey,
  isMetaQuery,
  retrievalTopK,
} from '../../retrieval/intent.js';
import { EnumResultSchema, ComparisonResultSchema } from '../../types/schemas.js';
import { getSummary, generateSummary, shouldGenerateSummary } from '../../memory/summarizer.js';
import { getAgentTools as loadAgentTools, getToolDisclosureMeta } from '../../agent/toolDefs.js';
import { createToolTranscriptShaper } from '../../agent/toolTranscript.js';
import { selectActiveTools } from '../../agent/toolSelection.js';
import { isToolFailure, repairToolCall } from '../../agent/toolRuntime.js';
import {
  aggregateBestOfN,
  buildBreakdown,
  estimateTokens,
  measureToolCallTokens,
  measureToolDefTokens,
  measureTurn,
  resolveUsage,
} from '../tokenAccounting.js';
import { runBestOfN, summarizeToolInput, summarizeToolResult } from '../../agent/synthesize.js';
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
async function getAgentTools(scope?: string): Promise<Record<string, Tool> | null> {
  try {
    return await loadAgentTools(scope);
  } catch (err) {
    console.warn(
      `[chat] Agent tools unavailable (${(err as Error).message}), falling back to pure RAG`,
    );
    return null;
  }
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
    const historyRounds =
      msgCount > 0 ? Math.ceil(messages.filter((m) => m.role !== 'system').length / 2) : 0;

    console.log(
      `[chat] POST /v1/chat/completions | messages=${msgCount} | rounds=${historyRounds}`,
    );

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
      console.log(
        `[chat] Ignored ${externalSystemCount} external system message(s). Server-side SYSTEM_PROMPT is enforced.`,
      );
    }

    const query = lastUserMessage.content;
    const truncatedQuery = query.length > 80 ? query.slice(0, 80) + '…' : query;
    console.log(`[chat] Query: "${truncatedQuery}"`);

    // First guard: reject absurd input before spending any work on it. This only sees the incoming
    // messages — the system prompt and the retrieved context are added later, so a second guard runs
    // once the real prompt size is known (search for "Second guard" below).
    const estimatedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const effectiveLimit = Math.floor(config.maxContextTokens * 0.7);
    if (estimatedTokens > effectiveLimit) {
      console.log(`[chat] 400 - Request too large: ~${estimatedTokens} tokens > ${effectiveLimit}`);
      return reply.status(400).send({
        error: {
          message: `Request too large: ~${estimatedTokens} estimated tokens exceed safe context limit (${effectiveLimit})`,
          type: 'invalid_request_error',
        },
      });
    }

    // The selected package scopes the whole turn: retrieval, every tool the agent can call, and
    // the system prompt. Anything less and the tool loop happily answers from a package the user
    // did not pick — 1300+ keys exist in more than one.
    const packageScope =
      typeof body.mod === 'string' && body.mod.trim() ? body.mod.trim() : undefined;

    const sessionId = (request.headers['x-session-id'] as string) || undefined;
    const memorySessionId = sessionId ?? 'default';
    const queryCategory = classifyQuery(query);
    // A question that is essentially one entity key needs neither query rewriting nor broad retrieval.
    const exactKey = extractExactKey(query);

    const chainObs = startObservation(
      'chat-completions',
      {
        input: { query, messages: nonSystemMessages },
        metadata: { queryCategory, exactKey },
      },
      { asType: 'chain' },
    );

    if (sessionId) {
      chainObs.otelSpan.setAttribute('session.id', sessionId);
    }
    chainObs.otelSpan.setAttribute('langfuse.trace.name', 'chat-completions');
    chainObs.otelSpan.setAttribute('langfuse.trace.tags', [queryCategory]);
    chainObs.otelSpan.setAttribute(
      'langfuse.trace.input',
      JSON.stringify({ query, messages: nonSystemMessages }),
    );

    let results: SearchResult[];
    let searchPath = 'none';
    let isLowConfidence = false;
    try {
      const metaDetected = isMetaQuery(query);
      if (metaDetected) {
        console.log(`[chat] Meta query detected, skipping search`);
        results = [];
      } else {
        const topK = retrievalTopK(queryCategory, exactKey !== null);
        const searchObs = chainObs.startObservation(
          'search-pipeline',
          {
            input: { query, topK, exactKey },
          },
          { asType: 'span' },
        );

        let enrichedQuery: string;
        if (exactKey !== null) {
          // The query is essentially one key, so it is already unambiguous. Rewriting would fold in
          // history and synonyms that can only pull the search away from the key the user named.
          enrichedQuery = exactKey;
          console.log(`[chat] Exact key detected: ${exactKey} — skipping query rewrite`);
        } else {
          const historyForSearch = nonSystemMessages.slice(0, -1).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }));

          const summary = getSummary(memorySessionId);
          if (shouldGenerateSummary(memorySessionId, nonSystemMessages.length)) {
            generateSummary(memorySessionId, nonSystemMessages).catch(() => {});
          }

          enrichedQuery = buildSearchQuery(query, historyForSearch, summary);
          if (enrichedQuery !== query) {
            console.log(
              `[chat] Query enriched: "${truncatedQuery}" → "${enrichedQuery.length > 120 ? enrichedQuery.slice(0, 120) + '…' : enrichedQuery}"`,
            );
          }
        }

        const filters = packageScope ? { mod_name: packageScope } : {};
        results = await localSearch(query, filters, topK, enrichedQuery);
        console.log(
          `[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}, intent=${queryCategory}${packageScope ? `, mod=${packageScope}` : ''})`,
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

    chainObs.update({
      metadata: { queryCategory, searchResults: results.length, searchPath, isLowConfidence },
    });

    const ragUserPrompt = buildUserPrompt(query, results, {
      lowConfidence: isLowConfidence,
      budgetTokens: config.contextBudgetTokens,
      mod: packageScope,
    });
    const systemPrompt = buildSystemPrompt(packageScope);

    const historyMessages = nonSystemMessages.slice(0, -1).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // The client may switch models within the operator's list (`LLM_MODELS`); anything else —
    // including the legacy `rwr-agent` alias — resolves to the configured default, so a request
    // can never steer the turn onto a model the operator did not approve.
    const turnModelId =
      typeof body.model === 'string' &&
      body.model !== 'rwr-agent' &&
      config.llmModels.includes(body.model)
        ? body.model
        : config.llmModel;
    // The judge follows the turn's model unless the operator pinned one via JUDGE_MODEL.
    const judgeModelId = config.judgeModelExplicit ? config.judgeModel : turnModelId;

    console.log(
      `[chat] LLM request | model=${turnModelId} | history=${historyMessages.length}`,
    );

    const responseFormat =
      body.response_format?.type ?? (request.headers['x-response-format'] as string | undefined);
    const useStructured =
      (queryCategory === 'enumeration' || queryCategory === 'comparison') &&
      responseFormat === 'json_object';

    // Best-of-N ("max mode"): parallel candidate agent loops + one synthesis call. Structured
    // responses are excluded by design — enumeration/comparison output is JSON built from the
    // retrieved context, where N drafts buy nothing. `body.candidates` overrides the configured N
    // (clamped; the feature exists to bound cost, not to multiply it unboundedly).
    const maxMode = body.mode === 'max' && config.bestOfNEnabled && !useStructured;
    const candidateCount = maxMode
      ? Math.max(1, Math.min(body.candidates ?? config.bestOfN, 8))
      : 0;

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
      system: estimateTokens(systemPrompt),
      context: Math.max(estimateTokens(ragUserPrompt) - queryTokens, 0),
      messages:
        historyMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0) + queryTokens,
    };

    // Second guard: now that the retrieved context exists, check what will actually be sent. The
    // first guard cannot see this — a 150-document enumeration adds far more than the user typed, so
    // a request that passed there can still fail to fit. Prompt plus reserved output must leave room
    // in the window. Tool definitions (~1K) are not counted; they are noise at this scale.
    const promptTokens = inputTokens.system + inputTokens.context + inputTokens.messages;
    if (promptTokens + maxTokens > config.maxContextTokens) {
      console.log(
        `[chat] 400 - Prompt too large: ~${promptTokens} prompt + ${maxTokens} reserved output > ${config.maxContextTokens}`,
      );
      chainObs.update({ level: 'ERROR', statusMessage: 'Prompt exceeds context window' });
      chainObs.end();
      return reply.status(400).send({
        error: {
          message:
            `Prompt too large: ~${promptTokens} tokens of system prompt + retrieved context + conversation, ` +
            `plus ${maxTokens} reserved for the answer, exceed the ${config.maxContextTokens} token context window. ` +
            `Ask a narrower question, or lower LLM_MAX_OUTPUT_TOKENS.`,
          type: 'invalid_request_error',
        },
      });
    }

    const genObs = chainObs.startObservation(
      'llm-generation',
      {
        input: { messages: llmMessages, system: systemPrompt },
        model: turnModelId,
        modelParameters: { maxTokens },
      },
      { asType: 'generation' },
    );

    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let llmError: Error | null = null;
    try {
      if (useStructured) {
        const schema = queryCategory === 'enumeration' ? EnumResultSchema : ComparisonResultSchema;
        const result = streamObject({
          model: getProvider().chatModel(turnModelId),
          system: systemPrompt,
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

        const [usage, finishReason] = await Promise.all([result.usage, result.finishReason]);
        const answerText = JSON.stringify(lastObject ?? {});
        // Structured mode has no tool loop: a single step, no tool definitions in the prompt, so the
        // only way it stops early is running out of output tokens.
        if (finishReason === 'length') {
          console.warn(`[chat] Structured output truncated at maxOutputTokens=${maxTokens}`);
        }
        const basis = measureTurn(
          { ...inputTokens, toolDefs: 0, reasoning: 0, answer: estimateTokens(answerText) },
          {
            replay: [],
            toolCallTokens: 0,
          },
        );
        const resolved = resolveUsage(usage, usage, basis);
        const breakdown = buildBreakdown(basis, resolved);
        const finishData = JSON.stringify({
          type: 'finish',
          stopReason: finishReason === 'length' ? 'output-limit' : 'completed',
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
        const tools = await getAgentTools(packageScope);
        const toolDefTokens = measureToolDefTokens(tools);
        // Progressive tool disclosure: past the threshold, the first step exposes only the
        // built-ins plus trigger-matched plugins (`prepareStep.activeTools` narrows what the
        // model sees, never what it can execute). Undefined keeps full disclosure — the
        // no-op path when the registry fits or disclosure is disabled.
        const disclosureMeta = getToolDisclosureMeta(packageScope);

        if (maxMode) {
          // Best-of-N: N parallel candidate agent loops + one synthesis call. Retrieval, the RAG
          // prompt, the tool registry and the disclosure metadata are all shared — only the
          // temperature/seed per candidate differ. Candidate tool steps stream as progress;
          // the judge's text/reasoning deltas are the final answer.
          const shaperBudgetTokens =
            Math.floor(config.maxContextTokens * config.toolContextBudgetRatio) -
            inputTokens.system -
            toolDefTokens -
            maxTokens;
          const onEvent = (event: Record<string, unknown>) => {
            reply.raw.write(JSON.stringify(event) + '\n');
            (reply.raw as unknown as { flush?: () => void }).flush?.();
          };
          const result = await runBestOfN({
            model: getProvider().chatModel(turnModelId),
            judgeModel: getProvider().chatModel(judgeModelId),
            systemPrompt,
            llmMessages,
            query,
            retrievedContext: results,
            tools,
            candidateCount,
            temperatures: config.bestOfNTemperatures,
            seedBase: config.bestOfNSeedBase,
            maxSteps: config.bestOfNMaxSteps,
            maxOutputTokens: maxTokens,
            inputTokens,
            toolDefTokens,
            shaperBudgetTokens,
            disclosureMeta,
            disclosureThreshold: config.toolDisclosureThreshold,
            onEvent,
            startObservation: (name: string, input?: unknown) => {
              // One generation observation per candidate and one for the judge, so N runs do not
              // collapse into a single telemetry blob. The cast widens the update patch type to
              // the `Record<string, unknown>` the orchestrator speaks.
              const obs = chainObs.startObservation(name, { input }, { asType: 'generation' });
              return {
                update: (patch: Record<string, unknown>) => obs.update(patch),
                end: () => obs.end(),
              };
            },
          });
          const agg = aggregateBestOfN(result.perCandidate, result.judge, result.answer);
          genObs.update({
            output: result.answer.slice(0, 500),
            usageDetails: {
              inputTokens: agg.promptTokens,
              outputTokens: agg.completionTokens,
              totalTokens: agg.promptTokens + agg.completionTokens,
            },
          });
          chainObs.otelSpan.setAttribute('langfuse.trace.output', result.answer.slice(0, 500));
          const finishData = JSON.stringify({
            type: 'finish',
            stopReason: result.stopReason,
            usage: {
              promptTokens: agg.promptTokens,
              completionTokens: agg.completionTokens,
              contextTokens: agg.contextTokens,
              maxContextTokens: config.maxContextTokens,
              estimated: agg.estimated,
              breakdown: agg.breakdown,
            },
          });
          reply.raw.write(finishData + '\n');
          (reply.raw as unknown as { flush?: () => void }).flush?.();
        } else {
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
          // Tool execution time, reported by the SDK and keyed by tool call, so the UI can show it
          // without the timing ever entering the model's context.
          const toolDurations = new Map<string, number>();
          const result = streamText({
            model: getProvider().chatModel(turnModelId),
            system: systemPrompt,
            messages: llmMessages,
            maxOutputTokens: maxTokens,
            ...(tools
              ? {
                  tools,
                  stopWhen: stepCountIs(100),
                  prepareStep: ({
                    messages,
                    stepNumber,
                  }: {
                    messages: Record<string, unknown>[];
                    stepNumber: number;
                  }) => {
                    // The annotation above is the shaper's own message type, so no cast is needed;
                    // it is also contravariantly compatible with the SDK's `ModelMessage[]` (every
                    // ModelMessage is a Record<string, unknown>).
                    const shaped = shaper.prepare(messages);
                    // `stepNumber` is 0-based: the first LLM call is 0, later steps see the full
                    // registry again so a mid-loop tool is never locked out.
                    const active = selectActiveTools(
                      disclosureMeta,
                      query,
                      stepNumber,
                      config.toolDisclosureThreshold,
                    );
                    if (active && process.env.DEBUG_DISCLOSURE === '1') {
                      console.log(
                        `[disclosure] step=${stepNumber} active=${active.length}/${disclosureMeta?.allNames.length} tools exposed`,
                      );
                    }
                    if (active) return { ...shaped, activeTools: active } as never;
                    return shaped as never;
                  },
                  experimental_onToolCallFinish: ({ toolCall, durationMs }) => {
                    // The SDK reports fractional milliseconds; the UI only ever shows whole ones.
                    toolDurations.set(toolCall.toolCallId, Math.round(durationMs));
                  },
                  // Models carry coding-agent priors and invent `grep` / `cat` / `ls`. Remap the
                  // unambiguous ones instead of spending a step on NoSuchToolError.
                  experimental_repairToolCall: repairToolCall,
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
          let toolFailureCount = 0;
          // Execution time per tool call, filled by `experimental_onToolCallFinish` above. Measuring
          // the gap between the `tool-call` and `tool-result` stream parts instead would report the
          // flush interval, not the work — the SDK can emit both back to back once a tool has already
          // finished, which showed up as 0ms for calls that actually took tens of ms.
          const durationOf = (id: string | undefined): number | undefined => {
            if (!id) return undefined;
            const ms = toolDurations.get(id);
            toolDurations.delete(id);
            return ms;
          };
          for await (const part of result.fullStream) {
            const p = part as {
              type: string;
              text?: string;
              textDelta?: string;
              delta?: string;
              error?: unknown;
              toolName?: string;
              toolCallId?: string;
              input?: unknown;
              output?: unknown;
            };
            if (process.env.DEBUG_AGENT === '1') {
              console.log(
                `[agent-stream] type=${p.type} toolName=${p.toolName ?? ''} hasText=${!!(p.text ?? p.textDelta ?? p.delta)}`,
              );
            }
            if (p.type === 'reasoning-delta' || p.type === 'reasoning') {
              const delta = p.text ?? p.textDelta ?? p.delta ?? '';
              if (delta) {
                reasoningText += delta;
                reply.raw.write(
                  JSON.stringify({ type: 'reasoning-delta', textDelta: delta }) + '\n',
                );
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
              reply.raw.write(
                JSON.stringify({ type: 'tool-step', toolName: p.toolName, summary }) + '\n',
              );
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            } else if (p.type === 'tool-result') {
              // The runtime envelope turns thrown tools into ordinary results carrying `error`, so
              // success has to be read off the output shape rather than the stream part type.
              const failed = isToolFailure(p.output);
              if (failed) toolFailureCount++;
              reply.raw.write(
                JSON.stringify({
                  type: 'tool-step',
                  toolName: p.toolName,
                  done: true,
                  ok: !failed,
                  durationMs: durationOf(p.toolCallId),
                  summary: summarizeToolResult(p.toolName, p.output),
                }) + '\n',
              );
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            } else if (p.type === 'tool-error') {
              // Failures that never reach `execute` — schema validation, unknown tool name. The model
              // still receives them as tool results, so this must close the UI's trace line and must
              // NOT throw: only a stream-level `error` may end the response.
              toolFailureCount++;
              const message = p.error instanceof Error ? p.error.message : String(p.error);
              console.warn(`[chat] tool-error ${p.toolName ?? '?'} — ${message}`);
              reply.raw.write(
                JSON.stringify({
                  type: 'tool-step',
                  toolName: p.toolName,
                  done: true,
                  ok: false,
                  durationMs: durationOf(p.toolCallId),
                  // The SDK's message appends the full tool inventory, which is useful to the model but
                  // just noise in a one-line trace entry.
                  summary: message.split('. Available tools:')[0],
                }) + '\n',
              );
              (reply.raw as unknown as { flush?: () => void }).flush?.();
            } else if (p.type === 'error') {
              throw p.error;
            }
          }

          const finishReason = await result.finishReason;
          if (toolCallCount > 0) {
            console.log(
              `[chat] Agent used ${toolCallCount} tool call(s)` +
                (toolFailureCount > 0 ? ` (${toolFailureCount} failed)` : '') +
                ` | finishReason=${finishReason} | answerLen=${answerText.length}`,
            );
          }

          // Why the loop ended, reported as a field on `finish` rather than as an `error` event: the
          // UI owns the wording (it is fully localized) and `error` stays reserved for a stream that
          // actually broke. `output-limit` was previously invisible — the answer just stopped.
          let stopReason: 'completed' | 'step-limit' | 'output-limit' = 'completed';
          if (finishReason === 'tool-calls' && answerText.trim().length === 0) {
            stopReason = 'step-limit';
            console.warn('[chat] Agent step limit reached without a final answer');
            chainObs.update({ level: 'ERROR', statusMessage: 'Agent step limit reached' });
          } else if (finishReason === 'length') {
            stopReason = 'output-limit';
            console.warn(`[chat] Output truncated at maxOutputTokens=${maxTokens}`);
            chainObs.update({ level: 'WARNING', statusMessage: 'Output token limit reached' });
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
            stopReason,
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
        console.log(
          `[chat] FAILED | ${elapsed}ms | mode=${useStructured ? 'structured' : maxMode ? 'max' : 'text'} | error=${llmError.message}`,
        );
      } else {
        console.log(
          `[chat] COMPLETED | total=${elapsed}ms | mode=${useStructured ? 'structured' : maxMode ? 'max' : 'text'}`,
        );
      }
    }
  });
}
