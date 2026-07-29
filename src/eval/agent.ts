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
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
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
  | { type: 'finish'; stopReason?: string; usage?: { promptTokens?: number; contextTokens?: number; breakdown?: { steps?: number } } }
  | { type: 'error'; error?: string }
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
}

const NOT_FOUND_MARKERS =
  /(not found|no data|does not exist|could not find|未找到|不存在|没有找到|没有.{0,4}数据|无法找到)/i;

/** Drive one turn through the real route and collect everything the NDJSON stream reveals. */
async function runTurn(
  app: Awaited<ReturnType<typeof buildApp>>,
  query: string,
  id: string,
): Promise<TurnObservation> {
  const startedAt = Date.now();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-session-id': `eval-${id}` },
    payload: { model: 'rwr-agent', stream: true, messages: [{ role: 'user', content: query }] },
  });

  const observation: TurnObservation = {
    answer: '',
    reasoning: '',
    toolCalls: [],
    steps: 0,
    stopReason: 'unknown',
    failedTools: 0,
    duplicateRejections: 0,
    promptTokens: 0,
    contextTokens: 0,
    latencyMs: Date.now() - startedAt,
    streamError: null,
  };

  if (response.statusCode !== 200) {
    observation.streamError = `HTTP ${response.statusCode}: ${response.body.slice(0, 200)}`;
    return observation;
  }

  for (const line of response.body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }
    switch (event.type) {
      case 'text-delta':
        observation.answer += 'textDelta' in event ? (event.textDelta ?? '') : '';
        break;
      case 'reasoning-delta':
        observation.reasoning += 'textDelta' in event ? (event.textDelta ?? '') : '';
        break;
      case 'tool-step': {
        const step = event as ToolStep;
        // Only the closing line carries the outcome; the opening one would double-count.
        if (!step.done) break;
        observation.toolCalls.push(step);
        if (step.ok === false) observation.failedTools++;
        if (step.summary === 'duplicate_call') observation.duplicateRejections++;
        break;
      }
      case 'finish': {
        if (!('usage' in event)) break;
        observation.stopReason = event.stopReason ?? 'unknown';
        observation.steps = event.usage?.breakdown?.steps ?? 0;
        observation.promptTokens = event.usage?.promptTokens ?? 0;
        observation.contextTokens = event.usage?.contextTokens ?? 0;
        break;
      }
      case 'error':
        observation.streamError = ('error' in event ? event.error : null) ?? 'unknown stream error';
        break;
    }
  }
  return observation;
}

function assess(evalCase: AgentEvalCase, obs: TurnObservation): string[] {
  const failures: string[] = [];
  const called = new Set(obs.toolCalls.map((t) => t.toolName));

  if (obs.streamError) failures.push(`stream error: ${obs.streamError}`);
  if (obs.answer.trim().length === 0) failures.push('no answer text produced');
  if (obs.stopReason !== 'completed') failures.push(`stopReason=${obs.stopReason}`);

  for (const tool of evalCase.expectedTools ?? []) {
    if (!called.has(tool)) failures.push(`never called ${tool} (called: ${[...called].join(', ') || 'none'})`);
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
  // Repetition is always a defect: the guard already refused the call, so a rejection means the model
  // burned a step. One is a stumble worth reporting, and the escalation should stop it there.
  if (obs.duplicateRejections > 1) {
    failures.push(`${obs.duplicateRejections} duplicate calls rejected — the loop is thrashing`);
  }
  return failures;
}

async function main(): Promise<void> {
  if (!config.llmApiKey) {
    console.error(c('\nLLM_API_KEY is not set — this eval drives the real model and cannot run without it.\n', 'red'));
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
  let passed = 0;
  const rows: string[] = [];

  try {
    for (const [i, evalCase] of cases.entries()) {
      process.stdout.write(`  [${i + 1}/${cases.length}] ${evalCase.id.padEnd(28)} `);
      const obs = await runTurn(app, evalCase.query, evalCase.id);
      const failures = assess(evalCase, obs);
      const ok = failures.length === 0;
      if (ok) passed++;

      const tools = obs.toolCalls.map((t) => `${t.toolName}${t.ok === false ? '✕' : ''}`).join(' → ') || 'none';
      console.log(
        `${ok ? c('PASS', 'green') : c('FAIL', 'red')}  ` +
          c(`${obs.steps} steps · ${obs.toolCalls.length} calls · ${(obs.latencyMs / 1000).toFixed(1)}s · ${obs.promptTokens} in`, 'dim'),
      );
      console.log(c(`        tools: ${tools}`, 'dim'));
      for (const f of failures) console.log(`        ${c('✕', 'red')} ${f}`);
      rows.push(
        [evalCase.id, ok ? 'PASS' : 'FAIL', obs.steps, obs.toolCalls.length, obs.promptTokens, obs.contextTokens, failures.join('; ')].join('\t'),
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
