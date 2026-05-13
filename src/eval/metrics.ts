import type { SearchResult } from '../types/index.js';

export interface EvalCase {
  id: string;
  query: string;
  expectedKeys: string[];
  expectedType: string | null;
  category: string;
  notes: string;
}

export interface EvalResult {
  id: string;
  query: string;
  category: string;
  returnedKeys: string[];
  expectedKeys: string[];
  recallAtK: number;
  precisionAtK: number;
  typeCorrect: boolean;
  emptyResult: boolean;
  latencyMs: number;
  passed: boolean;
}

export interface EvalSummary {
  totalCases: number;
  passed: number;
  failed: number;
  recallAt5: number;
  precisionAt5: number;
  exactKeyHitRate: number;
  emptyResultRate: number;
  p95Latency: number;
  byCategory: Record<string, { passed: number; total: number }>;
  results: EvalResult[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\.weapon$|\.vehicle$|\.projectile$|\.call$|\.carry_item$|\.xml$/, '');
}

function keyMatches(actual: string, expected: string): boolean {
  const a = normalizeKey(actual);
  const e = normalizeKey(expected);
  return a.includes(e) || e.includes(a);
}

export function recallAtK(actualKeys: string[], expectedKeys: string[], k: number): number {
  if (expectedKeys.length === 0) return 1.0;
  const topK = actualKeys.slice(0, k);
  const hits = expectedKeys.filter((ek) =>
    topK.some((ak) => keyMatches(ak, ek)),
  );
  return hits.length / expectedKeys.length;
}

export function precisionAtK(actualKeys: string[], expectedKeys: string[], k: number): number {
  if (expectedKeys.length === 0) return actualKeys.length === 0 ? 1.0 : 0.0;
  const topK = actualKeys.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((ak) =>
    expectedKeys.some((ek) => keyMatches(ak, ek)),
  );
  return hits.length / topK.length;
}

export function evaluateCase(
  evalCase: EvalCase,
  results: SearchResult[],
  latencyMs: number,
): EvalResult {
  const K = 5;
  const returnedKeys = results.map((r) => r.key);
  const rAtK = recallAtK(returnedKeys, evalCase.expectedKeys, K);
  const pAtK = precisionAtK(returnedKeys, evalCase.expectedKeys, K);

  const typeCorrect = evalCase.expectedType === null
    ? true
    : results.length === 0 || results.some((r) => r.type === evalCase.expectedType);

  const emptyResult = results.length === 0;

  const passed = rAtK >= 0.5 && (evalCase.expectedKeys.length === 0 ? emptyResult : !emptyResult) && typeCorrect;

  return {
    id: evalCase.id,
    query: evalCase.query,
    category: evalCase.category,
    returnedKeys,
    expectedKeys: evalCase.expectedKeys,
    recallAtK: rAtK,
    precisionAtK: pAtK,
    typeCorrect,
    emptyResult,
    latencyMs,
    passed,
  };
}

export function summarizeResults(results: EvalResult[]): EvalSummary {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95Idx = Math.floor(latencies.length * 0.95);
  const p95Latency = latencies[Math.min(p95Idx, latencies.length - 1)] ?? 0;

  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.passed) byCategory[r.category].passed++;
  }

  const exactKeyCases = results.filter((r) => r.category === 'exact-key');
  const exactKeyHits = exactKeyCases.filter((r) => r.recallAtK === 1.0).length;

  return {
    totalCases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    recallAt5: results.reduce((sum, r) => sum + r.recallAtK, 0) / results.length,
    precisionAt5: results.reduce((sum, r) => sum + r.precisionAtK, 0) / results.length,
    exactKeyHitRate: exactKeyCases.length > 0 ? exactKeyHits / exactKeyCases.length : 1.0,
    emptyResultRate: results.filter((r) => r.emptyResult).length / results.length,
    p95Latency,
    byCategory,
    results,
  };
}
