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
      const mrrStr = `MRR=${formatPercent(result.mrrAt10)}`;
      const latencyStr = `${latencyMs}ms`;
      console.log(`${statusIcon(result.passed)}  ${recallStr}  ${mrrStr}  ${latencyStr}  ${colorize(`(${result.returnedKeys.length} hits)`, 'dim')}`);
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
        recallAt1: 0,
        recallAt10: 0,
        recallAt20: 0,
        precisionAtK: 0,
        mrrAt10: 0,
        ndcgAt10: 0,
        typeCorrect: false,
        emptyResult: true,
        latencyMs,
        passed: false,
        failureReason: 'candidate_missing',
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
  console.log(`  Recall@1:        ${colorize(formatPercent(summary.recallAt1), metricColor(summary.recallAt1, 0.8))}  (target ≥ 80%)`);
  console.log(`  Recall@5:        ${colorize(formatPercent(summary.recallAt5), metricColor(summary.recallAt5, 0.9))}  (target ≥ 90%)`);
  console.log(`  Recall@10:       ${colorize(formatPercent(summary.recallAt10), metricColor(summary.recallAt10, 0.95))}  (target ≥ 95%)`);
  console.log(`  Recall@20:       ${colorize(formatPercent(summary.recallAt20), metricColor(summary.recallAt20, 0.95))}  (target ≥ 95%)`);
  console.log(`  Precision@5:     ${colorize(formatPercent(summary.precisionAt5), metricColor(summary.precisionAt5, 0.7))}  (target ≥ 70%)`);
  console.log(`  MRR@10:          ${colorize(formatPercent(summary.mrrAt10), metricColor(summary.mrrAt10, 0.8))}  (target ≥ 80%)`);
  console.log(`  NDCG@10:         ${colorize(formatPercent(summary.ndcgAt10), metricColor(summary.ndcgAt10, 0.8))}  (target ≥ 80%)`);
  console.log(`  Exact Key Hit:   ${colorize(formatPercent(summary.exactKeyHitRate), metricColor(summary.exactKeyHitRate, 1.0))}  (target = 100%)`);
  console.log(`  Type Accuracy:   ${colorize(formatPercent(summary.typeAccuracy), metricColor(summary.typeAccuracy, 0.95))}  (target ≥ 95%)`);
  console.log(`  Empty Result %:  ${colorize(formatPercent(summary.emptyResultRate), summary.emptyResultRate <= 0.05 ? 'green' : 'yellow')}  (target ≤ 5%)`);
  console.log(`  P50 Latency:     ${colorize(`${summary.p50Latency}ms`, 'dim')}`);
  console.log(`  P95 Latency:     ${colorize(`${summary.p95Latency}ms`, metricColor(800 - summary.p95Latency, 0))}  (target ≤ 800ms)`);

  console.log(colorize('\n  ── By Category ──', 'cyan'));
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    const rate = stats.total > 0 ? stats.passed / stats.total : 0;
    const bar = rate >= 0.8 ? colorize(`${stats.passed}/${stats.total}`, 'green') : colorize(`${stats.passed}/${stats.total}`, 'yellow');
    const catBucket = summary.buckets[cat];
    const mrrStr = catBucket ? ` MRR=${formatPercent(catBucket.mrrAt10)}` : '';
    console.log(`    ${cat.padEnd(20)} ${bar}${mrrStr}`);
  }

  const bucketCategories = Object.keys(summary.buckets).filter((k) => k.startsWith('lang:') || k.startsWith('len:'));
  if (bucketCategories.length > 0) {
    console.log(colorize('\n  ── Buckets ──', 'cyan'));
    for (const bucketKey of bucketCategories) {
      const b = summary.buckets[bucketKey];
      console.log(`    ${bucketKey.padEnd(20)} n=${String(b.count).padEnd(4)} R@5=${formatPercent(b.recallAt5).padEnd(7)} MRR=${formatPercent(b.mrrAt10).padEnd(7)} NDCG=${formatPercent(b.ndcgAt10)}`);
    }
  }

  const nonZeroReasons = Object.entries(summary.failureReasons).filter(([, v]) => v > 0);
  if (nonZeroReasons.length > 0) {
    console.log(colorize('\n  ── Failure Reasons ──', 'yellow'));
    for (const [reason, count] of nonZeroReasons) {
      console.log(`    ${reason.padEnd(20)} ${count}`);
    }
  }

  const failedCases = summary.results.filter((r) => !r.passed);
  if (failedCases.length > 0) {
    console.log(colorize('\n  ── Failed Cases ──', 'red'));
    for (const r of failedCases) {
      const reasonTag = r.failureReason !== 'none' ? colorize(` [${r.failureReason}]`, 'yellow') : '';
      console.log(`    ${colorize(r.id, 'red')}: R@5=${formatPercent(r.recallAtK)} MRR=${formatPercent(r.mrrAt10)} returned=[${r.returnedKeys.slice(0, 3).join(', ')}] expected=[${r.expectedKeys.join(', ')}]${reasonTag}`);
    }
  }

  console.log(colorize('\n════════════════════════════════════════\n', 'bold'));
}

runEval().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
