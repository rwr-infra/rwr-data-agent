import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../retrieval/search.js';
import { evaluateCase, summarizeResults } from './metrics.js';
import type { EvalCase, EvalSummary } from './metrics.js';

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

function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function statusIcon(passed: boolean): string {
  return passed ? colorize('PASS', 'green') : colorize('FAIL', 'red');
}

async function loadDataset(): Promise<EvalCase[]> {
  const datasetPath = path.resolve(__dirname, '../../tests/eval/dataset.json');
  const raw = await readFile(datasetPath, 'utf-8');
  return JSON.parse(raw) as EvalCase[];
}

async function runEval(): Promise<void> {
  const dataset = await loadDataset();
  console.log(colorize(`\nRunning ${dataset.length} evaluation cases...\n`, 'bold'));

  const results: Awaited<ReturnType<typeof evaluateCase>>[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const evalCase = dataset[i];
    const label = `[${i + 1}/${dataset.length}] ${evalCase.id}`;
    process.stdout.write(`  ${label.padEnd(45)} `);

    const start = Date.now();
    try {
      const searchResults = await search(evalCase.query, {}, 5);
      const latencyMs = Date.now() - start;
      const result = evaluateCase(evalCase, searchResults, latencyMs);
      results.push(result);

      const recallStr = `R@5=${formatPercent(result.recallAtK)}`;
      const latencyStr = `${latencyMs}ms`;
      console.log(`${statusIcon(result.passed)}  ${recallStr}  ${latencyStr}  ${colorize(`(${result.returnedKeys.length} hits)`, 'dim')}`);
    } catch (err) {
      const latencyMs = Date.now() - start;
      console.log(`${statusIcon(false)}  ERROR: ${(err as Error).message}  ${latencyMs}ms`);
      results.push({
        id: evalCase.id,
        query: evalCase.query,
        category: evalCase.category,
        returnedKeys: [],
        expectedKeys: evalCase.expectedKeys,
        recallAtK: 0,
        precisionAtK: 0,
        typeCorrect: false,
        emptyResult: true,
        latencyMs,
        passed: false,
      });
    }
  }

  const summary = summarizeResults(results);

  printSummary(summary);

  const reportPath = path.resolve(__dirname, `../../tests/eval/report-${Date.now()}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(summary, null, 2));
  console.log(colorize(`\nReport saved to ${reportPath}\n`, 'cyan'));
}

function printSummary(summary: EvalSummary): void {
  console.log(colorize('\n════════════════════════════════════════', 'bold'));
  console.log(colorize('          EVALUATION SUMMARY', 'bold'));
  console.log(colorize('════════════════════════════════════════', 'bold'));

  const metricColor = (value: number, threshold: number) => value >= threshold ? 'green' : 'red';

  console.log(`\n  Total Cases:     ${summary.totalCases}`);
  console.log(`  Passed:          ${colorize(String(summary.passed), 'green')}`);
  console.log(`  Failed:          ${colorize(String(summary.failed), summary.failed > 0 ? 'red' : 'green')}`);

  console.log(colorize('\n  ── Key Metrics ──', 'cyan'));
  console.log(`  Recall@5:        ${colorize(formatPercent(summary.recallAt5), metricColor(summary.recallAt5, 0.9))}  (target ≥ 90%)`);
  console.log(`  Precision@5:     ${colorize(formatPercent(summary.precisionAt5), metricColor(summary.precisionAt5, 0.7))}  (target ≥ 70%)`);
  console.log(`  Exact Key Hit:   ${colorize(formatPercent(summary.exactKeyHitRate), metricColor(summary.exactKeyHitRate, 1.0))}  (target = 100%)`);
  console.log(`  Empty Result %:  ${colorize(formatPercent(summary.emptyResultRate), summary.emptyResultRate <= 0.05 ? 'green' : 'yellow')}  (target ≤ 5%)`);
  console.log(`  P95 Latency:     ${colorize(`${summary.p95Latency}ms`, metricColor(800 - summary.p95Latency, 0))}  (target ≤ 800ms)`);

  console.log(colorize('\n  ── By Category ──', 'cyan'));
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    const rate = stats.total > 0 ? stats.passed / stats.total : 0;
    const bar = rate >= 0.8 ? colorize(`${stats.passed}/${stats.total}`, 'green') : colorize(`${stats.passed}/${stats.total}`, 'yellow');
    console.log(`    ${cat.padEnd(20)} ${bar}`);
  }

  const failedCases = summary.results.filter((r) => !r.passed);
  if (failedCases.length > 0) {
    console.log(colorize('\n  ── Failed Cases ──', 'red'));
    for (const r of failedCases) {
      console.log(`    ${colorize(r.id, 'red')}: R@5=${formatPercent(r.recallAtK)} returned=[${r.returnedKeys.slice(0, 3).join(', ')}] expected=[${r.expectedKeys.join(', ')}]`);
    }
  }

  console.log(colorize('\n════════════════════════════════════════\n', 'bold'));
}

runEval().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
