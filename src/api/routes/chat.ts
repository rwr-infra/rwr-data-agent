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
  isReverseLookup,
  retrievalTopK,
} from '../../retrieval/intent.js';
import { EnumResultSchema, ComparisonResultSchema } from '../../types/schemas.js';
import { getSummary, generateSummary, shouldGenerateSummary } from '../../memory/summarizer.js';
import { getAgentTools as loadAgentTools, getToolDisclosureMeta } from '../../agent/toolDefs.js';
import { getActiveSkills } from '../../agent/skills.js';
import { createToolTranscriptShaper } from '../../agent/toolTranscript.js';
import { selectActiveTools } from '../../agent/toolSelection.js';
import { isToolFailure, repairToolCall } from '../../agent/toolRuntime.js';
import { createTurn, endTurn, PROTOCOL_VERSION } from '@rwr/agent-core';
import {
  aggregateBestOfN,
  applyReflection,
  buildBreakdown,
  estimateTokens,
  measureToolCallTokens,
  measureToolDefTokens,
  measureTurn,
  resolveUsage,
} from '../tokenAccounting.js';
import { runBestOfN, summarizeToolInput, summarizeToolResult } from '../../agent/synthesize.js';
import { buildReflectionTranscript, runReflection, shouldReflect } from '../../agent/reflect.js';
import type { ReflectionRunResult } from '../../agent/reflect.js';
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

    // Conversation-length cap. Counted off the messages the client replays, so it bounds a single
    // thread rather than a client's request rate — the whole history is re-sent every turn, and the
    // tool loop re-sends it once per step, so an endless thread is the expensive failure mode here.
    // `MAX_CONVERSATION_ROUNDS=0` disables it.
    if (config.maxConversationRounds > 0 && historyRounds > config.maxConversationRounds) {
      console.log(
        `[chat] 400 - Conversation too long: ${historyRounds} rounds > ${config.maxConversationRounds}`,
      );
      return reply.status(400).send({
        error: {
          message:
            `Conversation limit reached: this thread is ${historyRounds} rounds long and the server allows ` +
            `${config.maxConversationRounds}. Start a new conversation to continue.`,
          type: 'invalid_request_error',
          // `code` is the OpenAI-shaped machine-readable field; the two counters are additive, so a
          // client can render "20/20" without parsing the message.
          code: 'conversation_limit_exceeded',
          rounds: historyRounds,
          max_rounds: config.maxConversationRounds,
        },
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
        // "有哪些武器引用了 bullet.projectile" reads as an enumeration but is answered whole by a
        // single `findReferences` call, so it gets the graph-intent breadth rather than 150 docs.
        const reverseLookup = isReverseLookup(query);
        const topK = retrievalTopK(queryCategory, exactKey !== null, reverseLookup);
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
          `[chat] Search returned ${results.length} result(s) in ${Date.now() - startTime}ms (topK=${topK}, intent=${queryCategory}${reverseLookup ? '/reverse' : ''}${packageScope ? `, mod=${packageScope}` : ''})`,
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
    // Operator playbooks whose triggers this question hit. Never throws — a broken skills directory
    // degrades to "no skills" rather than failing the turn.
    const activeSkills = await getActiveSkills(query);
    if (activeSkills.length > 0) {
      console.log(`[chat] Skills applied: ${activeSkills.map((s) => s.name).join(', ')}`);
    }
    const systemPrompt = buildSystemPrompt(packageScope, activeSkills);

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
    // Same rule for the reflection checker: pinned only when REFLECTION_MODEL was set explicitly.
    const reflectionModelId = config.reflectionModelExplicit ? config.reflectionModel : turnModelId;

    console.log(`[chat] LLM request | model=${turnModelId} | history=${historyMessages.length}`);

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
    // Coerce the candidate count to a finite integer before clamping: a non-numeric
    // `body.candidates` (or a garbage BEST_OF_N, now guarded in config) must not become NaN —
    // `Array.from({ length: NaN })` runs zero candidates and silently answers nothing.
    // The configured default goes through the same 1..8 clamp as a request-supplied count: the cap
    // exists to bound cost, and `BEST_OF_N=100` with an unparseable `body.candidates` would
    // otherwise reach the fallback branch un-clamped and start 100 parallel loops.
    const configuredCandidates = Math.max(1, Math.min(config.bestOfN, 8));
    const requestedCandidates = Math.trunc(Number(body.candidates ?? configuredCandidates));
    const candidateCount = maxMode
      ? Number.isFinite(requestedCandidates)
        ? Math.max(1, Math.min(requestedCandidates, 8))
        : configuredCandidates
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

    // No `Connection` header: connection-specific fields are forbidden in HTTP/2 (RFC 9113 §8.2.2),
    // and a proxy that forwards one verbatim makes the whole response malformed to the browser.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    // The client is gone as soon as the socket closes — a closed tab, a proxy that reset the stream.
    // Without this the tool loop runs to its 100-step cap generating an answer nobody will read.
    const abort = new AbortController();
    // Registered so `POST /v1/chat/steer` and `/v1/chat/stop` can reach this turn while it streams.
    // Released in the `finally` below; the registry's TTL sweep only covers a crash that skips it.
    const turn = createTurn(abort);
    let clientGone = false;
    const onClientGone = () => {
      if (clientGone) return;
      clientGone = true;
      abort.abort();
    };
    // `reply.raw`, not `request.raw`: the incoming request closes as soon as its body has been read,
    // measurably while the response is still streaming, so guarding on that would abort every healthy
    // turn the moment it started. The response's own 'close' fires either once the body was flushed
    // (`writableFinished`) or when the connection died under it — exactly the distinction needed.
    // `writableEnded` is not enough: it only means `end()` was called, not that anything got out.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) onClientGone();
    });
    // A raw stream gets none of Fastify's error handling: an unhandled 'error' on a destroyed socket
    // is an uncaught exception, which would take the process — and every other live stream — down.
    reply.raw.on('error', onClientGone);

    /** Write one NDJSON event line, unless the socket is already gone. */
    const emit = (event: Record<string, unknown>) => {
      if (clientGone || reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(JSON.stringify(event) + '\n');
      (reply.raw as unknown as { flush?: () => void }).flush?.();
    };

    // Heartbeat, so a silent phase never looks like a dead upstream to whatever sits in front of the
    // app (see `streamHeartbeatMs`). The first ping goes out immediately: it also forces a buffering
    // proxy to commit the response head instead of holding it until the first real delta. Disabling
    // the heartbeat suppresses that one too — `0` means a stream carrying nothing but real events.
    // First line out: the turn's id, which is the key for the steer/stop side channel. It also
    // commits the response head at a buffering proxy, the job the first heartbeat ping used to do
    // alone — and it goes out even when the heartbeat is disabled.
    emit({ type: 'turn-start', turnId: turn.id, protocolVersion: PROTOCOL_VERSION });

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (config.streamHeartbeatMs > 0) {
      heartbeat = setInterval(() => emit({ type: 'ping' }), config.streamHeartbeatMs);
    }

    /**
     * Reflect on a finished answer, emit what it found, and hand the run back so the caller can fold
     * its spend into `finish`. Returns undefined when the turn did not qualify or the call failed — in
     * both cases nothing was emitted and the turn finishes exactly as it would have.
     *
     * Shared by the single path and max mode. It lives here rather than inside either branch because
     * both need the same events in the same order, and because `runBestOfN`'s contract — never throw,
     * always let the route write a normal `finish` — should not grow a second responsibility.
     *
     * Not applied to structured output: a zod schema already constrains that shape, and its content is
     * assembled from the retrieved context rather than narrated, so there is no prose to check.
     */
    const reflectAndEmit = async (input: {
      answer: string;
      stopReason: 'completed' | 'step-limit' | 'output-limit' | 'stopped';
      toolFailureCount: number;
      toolTranscript: ReturnType<typeof buildReflectionTranscript>;
    }): Promise<ReflectionRunResult | undefined> => {
      const triggers = shouldReflect({
        enabled: config.reflectionEnabled,
        toolFailureCount: input.toolFailureCount,
        stopReason: input.stopReason,
        intent: queryCategory,
        hasAnswer: input.answer.trim().length > 0,
        stoppedByUser: turn.stoppedByUser(),
        clientGone,
      });
      if (!triggers) return undefined;

      // Announced before the call, not after: this phase emits nothing else for up to a minute, and a
      // client with no way to label it shows a finished answer under a live stop button.
      emit({ type: 'reflection-start', trigger: triggers });

      const reflection = await runReflection({
        model: getProvider().chatModel(reflectionModelId),
        query,
        answer: input.answer,
        retrievedContext: results,
        toolTranscript: input.toolTranscript,
        packageScope,
        intent: queryCategory,
        triggers,
        maxOutputTokens: maxTokens,
        // Not the shaper's budget, which is the whole window minus the fixed parts (~340K by default)
        // and would therefore trim nothing. Reflection re-sends the answer, the context and the
        // transcript for a check the user is already waiting on, so it gets the retrieval budget —
        // the same order as the context block it carries. Measured: at the shaper's budget the call
        // reached the origin's response timeout and was skipped.
        budgetTokens: config.contextBudgetTokens,
        abortSignal: abort.signal,
        startObservation: (name: string, obsInput?: unknown) => {
          const obs = chainObs.startObservation(
            name,
            { input: obsInput },
            { asType: 'generation' },
          );
          return {
            update: (patch: Record<string, unknown>) => obs.update(patch),
            end: () => obs.end(),
          };
        },
      });
      if (!reflection) return undefined;

      emit({
        type: 'reflection',
        verdict: reflection.verdict,
        issues: reflection.issues,
        trigger: triggers,
      });
      if (reflection.revisedAnswer) {
        emit({ type: 'revision', text: reflection.revisedAnswer });
      }
      return reflection;
    };

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
          abortSignal: abort.signal,
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
          emit({ type: 'json-delta', jsonDelta: chunk });
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
        emit({
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
            abortSignal: abort.signal,
            onEvent: emit,
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
          // The judge merges the drafts, it does not verify them against the evidence, so a synthesis
          // carries the same risks a single answer does. Every candidate's transcript goes in, tagged
          // with its index: reflection selects this turn partly on a failed candidate call, so it has
          // to be able to see that call. The prompt's own budget trims the merged list if N loops
          // made it long.
          // `runBestOfN` never throws, so a user stop does not reach the handler's catch (whose
          // `stopped` branch only ever sees structured mode) — the candidates just abort, the
          // orchestrator falls back to the best draft, and `completed` would go out for a turn the
          // user cut short. The registry is the authority on that, same as the single path.
          const stopReason = turn.stoppedByUser() ? 'stopped' : result.stopReason;
          const reflection = await reflectAndEmit({
            answer: result.answer,
            stopReason,
            toolFailureCount: result.perCandidate.reduce((n, c) => n + c.toolFailures, 0),
            toolTranscript: result.perCandidate.flatMap((c) => c.toolTranscript),
          });
          const finalUsage = reflection
            ? applyReflection(
                agg,
                agg.breakdown,
                reflection.accounting,
                reflection.revisedAnswer
                  ? {
                      originalAnswerTokens: estimateTokens(result.answer),
                      revisedAnswerTokens: estimateTokens(reflection.revisedAnswer),
                    }
                  : undefined,
              )
            : { ...agg, breakdown: agg.breakdown };
          emit({
            type: 'finish',
            stopReason,
            usage: {
              promptTokens: finalUsage.promptTokens,
              completionTokens: finalUsage.completionTokens,
              contextTokens: finalUsage.contextTokens,
              maxContextTokens: config.maxContextTokens,
              estimated: finalUsage.estimated,
              breakdown: finalUsage.breakdown,
            },
          });
        } else {
          // Tool results are replayed in full; the shaper only sheds them if a step's prompt would
          // otherwise overflow the window. The system prompt, tool definitions and the output
          // reservation ride alongside `messages`, so they come off the budget first.
          const shaperBudgetTokens =
            Math.floor(config.maxContextTokens * config.toolContextBudgetRatio) -
            inputTokens.system -
            toolDefTokens -
            maxTokens;
          const shaper = createToolTranscriptShaper({
            budgetTokens: shaperBudgetTokens,
            shedTargetTokens: config.toolShedResultTokens,
          });
          // Tool execution time, reported by the SDK and keyed by tool call, so the UI can show it
          // without the timing ever entering the model's context.
          const toolDurations = new Map<string, number>();
          // How many steering messages the stream has already announced. Injection is sticky —
          // every message is re-appended on every later step — so this is what keeps the UI from
          // getting one `steer-applied` per step for the same instruction.
          let announcedSteering = 0;
          const result = streamText({
            model: getProvider().chatModel(turnModelId),
            system: systemPrompt,
            messages: llmMessages,
            maxOutputTokens: maxTokens,
            abortSignal: abort.signal,
            ...(tools
              ? {
                  tools,
                  stopWhen: stepCountIs(config.maxToolSteps),
                  prepareStep: ({
                    messages,
                    stepNumber,
                  }: {
                    messages: Record<string, unknown>[];
                    stepNumber: number;
                  }) => {
                    // Steering the user sent mid-stream, appended after the whole replayed
                    // transcript — so it lands past a complete tool-result block and never leaves
                    // an assistant tool-call dangling.
                    //
                    // Re-appended in full on EVERY step, not drained once: the SDK rebuilds
                    // `messages` from the original input plus its own accumulated response, so a
                    // `prepareStep` rewrite only reaches that one outgoing request. Injecting once
                    // leaves the instruction alive only if the provider happens to echo the model's
                    // reasoning back — measured, see the spike in adr/0002.
                    const steering = turn.steering();
                    const withSteering =
                      steering.length > 0
                        ? [...messages, ...steering.map((content) => ({ role: 'user', content }))]
                        : messages;
                    for (let i = announcedSteering; i < steering.length; i++) {
                      emit({
                        type: 'steer-applied',
                        turnId: turn.id,
                        step: stepNumber,
                        message: steering[i],
                      });
                    }
                    announcedSteering = steering.length;

                    // The annotation above is the shaper's own message type, so no cast is needed;
                    // it is also contravariantly compatible with the SDK's `ModelMessage[]` (every
                    // ModelMessage is a Record<string, unknown>).
                    const shaped = shaper.prepare(withSteering);
                    // `prepare` reports "nothing to rewrite" as `{}`, which would make the SDK fall
                    // back to its own message list and silently drop the steering just appended.
                    // Once there is any, the messages have to be handed over explicitly.
                    const stepState =
                      steering.length > 0 ? { messages: shaped.messages ?? withSteering } : shaped;
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
                    if (active) return { ...stepState, activeTools: active } as never;
                    return stepState as never;
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
          // `/v1/chat/stop` aborts the same controller a client disconnect uses, so the two have to
          // be told apart: a user stop keeps everything generated so far and finishes the stream
          // normally, while a disconnect has nobody left to finish it for.
          //
          // An abort does NOT reliably throw out of `fullStream` — measured, the SDK ends the
          // iterator gracefully with `finishReason: 'other'` instead. So the throw is handled *and*
          // the registry is consulted afterwards; relying on the catch alone reported a stopped
          // turn as `completed`.
          let streamThrew = false;
          try {
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
                  emit({ type: 'reasoning-delta', textDelta: delta });
                }
              } else if (p.type === 'text-delta' || p.type === 'text') {
                const delta = p.text ?? p.textDelta ?? p.delta ?? '';
                if (delta) {
                  answerText += delta;
                  emit({ type: 'text-delta', textDelta: delta });
                }
              } else if (p.type === 'tool-call') {
                toolCallCount++;
                const summary = summarizeToolInput(p.toolName, p.input);
                emit({
                  type: 'tool-step',
                  toolCallId: p.toolCallId,
                  toolName: p.toolName,
                  summary,
                });
              } else if (p.type === 'tool-result') {
                // The runtime envelope turns thrown tools into ordinary results carrying `error`, so
                // success has to be read off the output shape rather than the stream part type.
                const failed = isToolFailure(p.output);
                if (failed) toolFailureCount++;
                emit({
                  type: 'tool-step',
                  toolCallId: p.toolCallId,
                  toolName: p.toolName,
                  done: true,
                  ok: !failed,
                  durationMs: durationOf(p.toolCallId),
                  summary: summarizeToolResult(p.toolName, p.output),
                });
              } else if (p.type === 'tool-error') {
                // Failures that never reach `execute` — schema validation, unknown tool name. The model
                // still receives them as tool results, so this must close the UI's trace line and must
                // NOT throw: only a stream-level `error` may end the response.
                toolFailureCount++;
                const message = p.error instanceof Error ? p.error.message : String(p.error);
                console.warn(`[chat] tool-error ${p.toolName ?? '?'} — ${message}`);
                emit({
                  type: 'tool-step',
                  toolCallId: p.toolCallId,
                  toolName: p.toolName,
                  done: true,
                  ok: false,
                  durationMs: durationOf(p.toolCallId),
                  // The SDK's message appends the full tool inventory, which is useful to the model but
                  // just noise in a one-line trace entry.
                  summary: message.split('. Available tools:')[0],
                });
              } else if (p.type === 'error') {
                throw p.error;
              }
            }
          } catch (err) {
            // Only a user stop is swallowed here. Anything else — including a client disconnect —
            // still belongs to the outer handler.
            if (!turn.stoppedByUser()) throw err;
            streamThrew = true;
          }

          const stoppedByUser = turn.stoppedByUser();
          if (stoppedByUser) {
            console.log(
              `[chat] turn=${turn.id} stopped by user after ${toolCallCount} tool call(s)`,
            );
          }

          // Only a stream that actually threw leaves the SDK's promises rejected; one that ended
          // gracefully still has real usage to report, and throwing it away would mark a perfectly
          // measured turn as estimated.
          const finishReason = streamThrew ? 'stop' : await result.finishReason;
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
          let stopReason: 'completed' | 'step-limit' | 'output-limit' | 'stopped' = 'completed';
          if (stoppedByUser) {
            stopReason = 'stopped';
          } else if (finishReason === 'tool-calls' && answerText.trim().length === 0) {
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
          const [totalUsage, lastStepUsage, stepResults] = streamThrew
            ? ([undefined, undefined, []] as const)
            : await Promise.all([result.totalUsage, result.usage, result.steps]);
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
          // After the answer, before `finish`: the reflection events belong to this turn, so they have
          // to land while the stream is still open, and their spend has to reach the same `finish` the
          // client reads its usage from.
          const reflection = await reflectAndEmit({
            answer: answerText,
            stopReason,
            toolFailureCount,
            toolTranscript: buildReflectionTranscript(stepResults),
          });
          const finalUsage = reflection
            ? applyReflection(
                resolved,
                breakdown,
                reflection.accounting,
                reflection.revisedAnswer
                  ? {
                      originalAnswerTokens: estimateTokens(answerText),
                      revisedAnswerTokens: estimateTokens(reflection.revisedAnswer),
                    }
                  : undefined,
              )
            : { ...resolved, breakdown };
          emit({
            type: 'finish',
            stopReason,
            usage: {
              promptTokens: finalUsage.promptTokens,
              completionTokens: finalUsage.completionTokens,
              contextTokens: finalUsage.contextTokens,
              maxContextTokens: config.maxContextTokens,
              estimated: finalUsage.estimated,
              breakdown: finalUsage.breakdown,
            },
          });
        }
      }
    } catch (err) {
      llmError = err as Error;
      // A client that walked away aborts the SDK stream, which lands here as an AbortError. That is
      // not a failure of the turn and there is nobody left to send an `error` frame to.
      if (clientGone) {
        console.warn(`[chat] Client disconnected mid-stream, generation aborted`);
      } else if (turn.stoppedByUser()) {
        // The text path finishes a stopped turn itself, with a `finish` carrying `stopped`. Reaching
        // here means structured or max mode was aborted instead — there is no partial object or
        // synthesised answer worth salvaging, but the client asked for this, so it is not an error.
        console.log(`[chat] turn=${turn.id} stopped by user`);
        emit({ type: 'finish', stopReason: 'stopped' });
      } else {
        console.error(`[chat] LLM stream error: ${llmError.message}`);
        emit({ type: 'error', error: llmError.message });
      }
    } finally {
      // Before anything that can throw: a leaked entry keeps an AbortController (and the closure
      // behind it) alive until the registry's TTL sweep, and answers steer requests for a turn that
      // is already over.
      endTurn(turn.id);
      if (heartbeat) clearInterval(heartbeat);
      genObs.end();
      chainObs.end();
      if (config.langfuseEnabled) {
        await flushLangfuse();
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      const elapsed = Date.now() - startTime;
      if (clientGone) {
        console.log(
          `[chat] ABORTED | ${elapsed}ms | mode=${useStructured ? 'structured' : maxMode ? 'max' : 'text'} | client disconnected`,
        );
      } else if (llmError) {
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
