/**
 * Agent tool-loop evaluation.
 *
 * `npm run eval` checks retrieval ranking and never calls an LLM. This one drives the real
 * `POST /v1/chat/completions` and asserts on the *loop*: which tools were reached for, whether the
 * answer cites the evidence, and whether it converged instead of thrashing.
 *
 * It runs the app in-process via `app.inject()` — no separate server, no port, no network. It does
 * spend real LLM quota, and a tool loop is non-deterministic, so assertions are deliberately
 * "at least this" rather than exact sequences: locking a step order in would produce a test that is
 * red for reasons that are not regressions.
 *
 * **Exception: cases that steer or stop.** `inject()` hands back the whole body once the stream is
 * over, so there is no moment during the turn at which the side channel could be called, and no way
 * to learn the `turnId` in time. Those cases — and only those — run against a real listener on an
 * ephemeral loopback port, read incrementally, exactly as the browser does.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { whenIndexesReady } from '../indexing/bootstrap.js';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};
const c = (text: string, color: keyof typeof COLORS) => `${COLORS[color]}${text}${COLORS.reset}`;

export interface AgentEvalCase {
  id: string;
  query: string;
  category: string;
  notes: string;
  /** 'max' drives the request through the best-of-N path (N candidates + judge). */
  mode?: 'max';
  /** Tools that must appear among the calls. Empty means "no requirement". */
  expectedTools?: string[];
  /** Entity keys the answer text must mention. */
  expectedKeys?: string[];
  /** Regex the answer must match at least once — used for "cites a file path". */
  expectedFilePattern?: string;
  /** The answer must admit the item is missing rather than inventing values. */
  expectNotFound?: boolean;
  /** Upper bound on LLM round trips for this question. */
  maxSteps?: number;
  /**
   * Mid-stream steering. Sent once, after this many tool calls have closed — waiting for one is what
   * puts the injection past a complete tool-result block, which is where it has to land.
   * Declaring it switches this case onto the real-listener path.
   */
  steer?: { afterToolSteps: number; message: string };
  /** Mid-stream hard stop, after this many tool calls have closed. Also uses the listener path. */
  stopAfterToolSteps?: number;
  /** Expected `finish.stopReason`. Defaults to `completed`; a stop case expects `stopped`. */
  expectStopReason?: string;
}

interface ToolStep {
  toolName: string;
  ok?: boolean;
  durationMs?: number;
  summary?: string;
  done?: boolean;
}

/** The NDJSON line shapes this harness reads. Mirrors what routes/chat.ts writes. */
type StreamEvent =
  | { type: 'text-delta' | 'reasoning-delta'; textDelta?: string }
  | ({ type: 'tool-step' } & ToolStep)
  // Best-of-N candidate tool activity uses the same shape as `tool-step` plus a candidate index;
  // counting it here is what makes `expectedTools` enforceable on max-mode cases.
  | ({ type: 'candidate-step' } & ToolStep)
  | {
      type: 'finish';
      stopReason?: string;
      usage?: {
        promptTokens?: number;
        contextTokens?: number;
        breakdown?: { steps?: number; candidates?: number; perCandidate?: unknown[] };
      };
    }
  | { type: 'error'; error?: string }
  | { type: 'turn-start'; turnId?: string }
  | { type: 'steer-applied'; message?: string; step?: number }
  | { type: string };

interface TurnObservation {
  answer: string;
  reasoning: string;
  toolCalls: ToolStep[];
  steps: number;
  stopReason: string;
  failedTools: number;
  duplicateRejections: number;
  promptTokens: number;
  contextTokens: number;
  latencyMs: number;
  streamError: string | null;
  /** Best-of-N turns only: candidate count from finish.usage.breakdown. */
  breakdownCandidates?: number;
  perCandidateCount?: number;
  /** `steer-applied` frames seen — one per accepted instruction, not per step. */
  steerApplied: number;
  /** HTTP status the side-channel call returned, when the case made one. */
  sideChannelStatus?: number;
}

const NOT_FOUND_MARKERS =
  /(not found|no data|does not exist|could not find|未找到|不存在|没有找到|没有.{0,4}数据|无法找到)/i;

function emptyObservation(latencyMs: number): TurnObservation {
  return {
    answer: '',
    reasoning: '',
    toolCalls: [],
    steps: 0,
    stopReason: 'unknown',
    failedTools: 0,
    duplicateRejections: 0,
    promptTokens: 0,
    contextTokens: 0,
    latencyMs,
    streamError: null,
    steerApplied: 0,
  };
}

/** Fold one NDJSON line into the observation. Returns the parsed event so a caller reading the
 *  stream live can react to it (that is how the side channel knows when to fire). */
function absorb(line: string, obs: TurnObservation): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: StreamEvent;
  try {
    event = JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
  switch (event.type) {
    case 'text-delta':
      obs.answer += 'textDelta' in event ? (event.textDelta ?? '') : '';
      break;
    case 'reasoning-delta':
      obs.reasoning += 'textDelta' in event ? (event.textDelta ?? '') : '';
      break;
    case 'steer-applied':
      obs.steerApplied++;
      break;
    case 'tool-step':
    case 'candidate-step': {
      const step = event as ToolStep;
      // Only the closing line carries the outcome; the opening one would double-count.
      if (!step.done) break;
      obs.toolCalls.push(step);
      if (step.ok === false) obs.failedTools++;
      if (step.summary === 'duplicate_call') obs.duplicateRejections++;
      break;
    }
    case 'finish': {
      if (!('usage' in event)) {
        // A stopped turn on the structured/max path finishes without a usage block.
        if ('stopReason' in event) obs.stopReason = event.stopReason ?? 'unknown';
        break;
      }
      obs.stopReason = event.stopReason ?? 'unknown';
      obs.steps = event.usage?.breakdown?.steps ?? 0;
      obs.promptTokens = event.usage?.promptTokens ?? 0;
      obs.contextTokens = event.usage?.contextTokens ?? 0;
      obs.breakdownCandidates = event.usage?.breakdown?.candidates;
      obs.perCandidateCount = event.usage?.breakdown?.perCandidate?.length;
      break;
    }
    case 'error':
      obs.streamError = ('error' in event ? event.error : null) ?? 'unknown stream error';
      break;
  }
  return event;
}

function requestBody(query: string, mode?: 'max') {
  return {
    model: 'rwr-agent',
    stream: true,
    messages: [{ role: 'user', content: query }],
    ...(mode ? { mode } : {}),
  };
}

/** Drive one turn through the real route and collect everything the NDJSON stream reveals. */
async function runTurn(
  app: Awaited<ReturnType<typeof buildApp>>,
  query: string,
  id: string,
  mode?: 'max',
): Promise<TurnObservation> {
  const startedAt = Date.now();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-session-id': `eval-${id}` },
    payload: requestBody(query, mode),
  });

  const observation = emptyObservation(Date.now() - startedAt);
  if (response.statusCode !== 200) {
    observation.streamError = `HTTP ${response.statusCode}: ${response.body.slice(0, 200)}`;
    return observation;
  }
  for (const line of response.body.split('\n')) absorb(line, observation);
  return observation;
}

/**
 * Same turn, but read incrementally off a real listener so the side channel can be called *during*
 * it. Only cases that steer or stop take this path — `inject()` cannot express "do something while
 * the stream is open", and the `turnId` those calls need arrives on the stream itself.
 */
async function runTurnWithSideChannel(
  base: string,
  evalCase: AgentEvalCase,
): Promise<TurnObservation> {
  const startedAt = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': `eval-${evalCase.id}` },
    body: JSON.stringify(requestBody(evalCase.query, evalCase.mode)),
  });

  const observation = emptyObservation(Date.now() - startedAt);
  if (!res.ok || !res.body) {
    observation.streamError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return observation;
  }

  const trigger = evalCase.steer?.afterToolSteps ?? evalCase.stopAfterToolSteps ?? 0;
  let turnId = '';
  let fired = false;
  // Node's lib types resolve the body's chunk type to `any` here; naming it keeps the read loop
  // out of the unsafe-any rules.
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const event = absorb(line, observation);
      if (event?.type === 'turn-start' && 'turnId' in event) turnId = event.turnId ?? '';
      if (fired || !turnId || observation.toolCalls.length < trigger) continue;

      fired = true;
      const [path, payload] = evalCase.steer
        ? (['steer', { turnId, message: evalCase.steer.message }] as const)
        : (['stop', { turnId }] as const);
      const side = await fetch(`${base}/v1/chat/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      observation.sideChannelStatus = side.status;
    }
  }
  observation.latencyMs = Date.now() - startedAt;
  return observation;
}

function assess(evalCase: AgentEvalCase, obs: TurnObservation): string[] {
  const failures: string[] = [];
  const called = new Set(obs.toolCalls.map((t) => t.toolName));

  const wantStopReason = evalCase.expectStopReason ?? 'completed';

  if (obs.streamError) failures.push(`stream error: ${obs.streamError}`);
  // A turn the case stopped on purpose is expected to be cut short, so an empty answer is not a
  // defect there — the point of the stop is that the rest never gets written.
  if (obs.answer.trim().length === 0 && wantStopReason !== 'stopped') {
    failures.push('no answer text produced');
  }
  if (obs.stopReason !== wantStopReason) {
    failures.push(`stopReason=${obs.stopReason}, expected ${wantStopReason}`);
  }
  if (evalCase.steer || evalCase.stopAfterToolSteps !== undefined) {
    if (obs.sideChannelStatus !== 200) {
      failures.push(`side channel returned ${obs.sideChannelStatus ?? 'nothing'} — expected 200`);
    }
  }
  // The 200 only says the server accepted it; this says the loop actually carried it.
  if (evalCase.steer && obs.steerApplied < 1) {
    failures.push('no steer-applied frame — the instruction never reached the loop');
  }

  for (const tool of evalCase.expectedTools ?? []) {
    if (!called.has(tool))
      failures.push(`never called ${tool} (called: ${[...called].join(', ') || 'none'})`);
  }
  for (const key of evalCase.expectedKeys ?? []) {
    if (!obs.answer.includes(key)) failures.push(`answer omits the key ${key}`);
  }
  if (evalCase.expectedFilePattern && !new RegExp(evalCase.expectedFilePattern).test(obs.answer)) {
    failures.push(`answer does not cite a file matching /${evalCase.expectedFilePattern}/`);
  }
  if (evalCase.expectNotFound && !NOT_FOUND_MARKERS.test(obs.answer)) {
    failures.push('answer does not admit the item is missing — possible fabrication');
  }
  if (evalCase.maxSteps && obs.steps > evalCase.maxSteps) {
    failures.push(`took ${obs.steps} steps, budget was ${evalCase.maxSteps}`);
  }
  // Best-of-N turns must report their candidate fan-out on `finish`, or the client has no idea it
  // was a max-mode run.
  if (evalCase.mode === 'max') {
    if (!obs.breakdownCandidates || obs.breakdownCandidates < 1) {
      failures.push('finish.usage.breakdown.candidates is missing or zero');
    }
    if (!obs.perCandidateCount || obs.perCandidateCount < 1) {
      failures.push('finish.usage.breakdown.perCandidate is missing or empty');
    }
  }
  // Repetition is always a defect: the guard already refused the call, so a rejection means the model
  // burned a step. One is a stumble worth reporting, and the escalation should stop it there.
  if (obs.duplicateRejections > 1) {
    failures.push(`${obs.duplicateRejections} duplicate calls rejected — the loop is thrashing`);
  }
  return failures;
}

async function main(): Promise<void> {
  if (!config.llmApiKey) {
    console.error(
      c(
        '\nLLM_API_KEY is not set — this eval drives the real model and cannot run without it.\n',
        'red',
      ),
    );
    process.exit(1);
  }

  const datasetPath = path.resolve(__dirname, '../../tests/eval/agent-dataset.json');
  const dataset = JSON.parse(await readFile(datasetPath, 'utf-8')) as AgentEvalCase[];
  const only = process.argv[2];
  const cases = only ? dataset.filter((k) => k.id.includes(only)) : dataset;
  if (cases.length === 0) {
    console.error(c(`No case matches "${only}"`, 'red'));
    process.exit(1);
  }

  console.log(c(`\nAgent loop eval — ${cases.length} case(s), real LLM calls\n`, 'bold'));
  const app = await buildApp();
  // `buildApp` no longer waits for the index — the server prioritises opening its port. An eval
  // run wants the opposite, so wait here before issuing the first query.
  await whenIndexesReady();

  // A loopback listener, but only when some selected case actually needs one. Every other case
  // keeps the no-port `inject()` path.
  const needsListener = cases.some((k) => k.steer || k.stopAfterToolSteps !== undefined);
  let base = '';
  if (needsListener) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  let passed = 0;
  const rows: string[] = [];

  try {
    for (const [i, evalCase] of cases.entries()) {
      process.stdout.write(`  [${i + 1}/${cases.length}] ${evalCase.id.padEnd(28)} `);
      const usesSideChannel = evalCase.steer || evalCase.stopAfterToolSteps !== undefined;
      const obs = usesSideChannel
        ? await runTurnWithSideChannel(base, evalCase)
        : await runTurn(app, evalCase.query, evalCase.id, evalCase.mode);
      const failures = assess(evalCase, obs);
      const ok = failures.length === 0;
      if (ok) passed++;

      const tools =
        obs.toolCalls.map((t) => `${t.toolName}${t.ok === false ? '✕' : ''}`).join(' → ') || 'none';
      console.log(
        `${ok ? c('PASS', 'green') : c('FAIL', 'red')}  ` +
          c(
            `${obs.steps} steps · ${obs.toolCalls.length} calls · ${(obs.latencyMs / 1000).toFixed(1)}s · ${obs.promptTokens} in`,
            'dim',
          ),
      );
      console.log(c(`        tools: ${tools}`, 'dim'));
      for (const f of failures) console.log(`        ${c('✕', 'red')} ${f}`);
      rows.push(
        [
          evalCase.id,
          ok ? 'PASS' : 'FAIL',
          obs.steps,
          obs.toolCalls.length,
          obs.promptTokens,
          obs.contextTokens,
          failures.join('; '),
        ].join('\t'),
      );
    }
  } finally {
    await app.close();
  }

  const rate = ((passed / cases.length) * 100).toFixed(0);
  console.log(
    `\n${c('════════════════════════════════════════', 'bold')}\n` +
      `  ${passed}/${cases.length} passed (${rate}%)\n`,
  );
  console.log(c('id\tresult\tsteps\tcalls\tin\tctx\tfailures', 'cyan'));
  for (const row of rows) console.log(c(row, 'dim'));

  process.exit(passed === cases.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(c(`\nAgent eval crashed: ${(err as Error).message}`, 'red'));
  process.exit(1);
});
