import type { SearchResult } from '../types/index.js';

export interface EvalCase {
  id: string;
  query: string;
  expectedKeys: string[];
  expectedType: string | null;
  category: string;
  notes: string;
}

export type FailureReason =
  | 'data_missing'
  | 'intent_wrong'
  | 'candidate_missing'
  | 'rerank_wrong'
  | 'label_issue'
  | 'low_confidence'
  | 'none';

export interface EvalResult {
  id: string;
  query: string;
  category: string;
  returnedKeys: string[];
  expectedKeys: string[];
  recallAtK: number;
  recallAt1: number;
  recallAt10: number;
  recallAt20: number;
  precisionAtK: number;
  mrrAt10: number;
  ndcgAt10: number;
  typeCorrect: boolean;
  emptyResult: boolean;
  latencyMs: number;
  passed: boolean;
  failureReason: FailureReason;
}

export interface BucketStats {
  count: number;
  recallAt5: number;
  precisionAt5: number;
  mrrAt10: number;
  ndcgAt10: number;
  passed: number;
  failed: number;
  emptyResultRate: number;
}

export interface EvalSummary {
  totalCases: number;
  passed: number;
  failed: number;
  recallAt5: number;
  recallAt1: number;
  recallAt10: number;
  recallAt20: number;
  precisionAt5: number;
  mrrAt10: number;
  ndcgAt10: number;
  exactKeyHitRate: number;
  emptyResultRate: number;
  p50Latency: number;
  p95Latency: number;
  typeAccuracy: number;
  byCategory: Record<string, { passed: number; total: number }>;
  buckets: Record<string, BucketStats>;
  failureReasons: Record<FailureReason, number>;
  results: EvalResult[];
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\.weapon$|\.vehicle$|\.projectile$|\.call$|\.carry_item$|\.xml$|\.character$/, '')
    .replace(/^gkw_/, '')
    .replace(/[_-]/g, '');
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

export function mrrAtK(actualKeys: string[], expectedKeys: string[], k: number): number {
  if (expectedKeys.length === 0) return 1.0;
  const topK = actualKeys.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (expectedKeys.some((ek) => keyMatches(topK[i], ek))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function ndcgAtK(actualKeys: string[], expectedKeys: string[], k: number): number {
  if (expectedKeys.length === 0) return 1.0;
  const topK = actualKeys.slice(0, k);

  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = expectedKeys.some((ek) => keyMatches(topK[i], ek)) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }

  const idealHits = Math.min(expectedKeys.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

function classifyFailure(
  evalCase: EvalCase,
  results: SearchResult[],
  recallAtKVal: number,
): FailureReason {
  if (evalCase.expectedKeys.length === 0) {
    return results.length > 0 ? 'low_confidence' : 'none';
  }

  if (results.length === 0) return 'candidate_missing';

  if (recallAtKVal === 0) {
    const hasExpectedType = results.some((r) => r.type === evalCase.expectedType);
    if (!hasExpectedType && evalCase.expectedType !== null) return 'intent_wrong';
    return 'candidate_missing';
  }

  if (recallAtKVal < 1.0) {
    return 'rerank_wrong';
  }

  return 'none';
}

export function evaluateCase(
  evalCase: EvalCase,
  results: SearchResult[],
  latencyMs: number,
): EvalResult {
  const K = 5;
  const returnedKeys = results.map((r) => r.key);
  const rAtK = recallAtK(returnedKeys, evalCase.expectedKeys, K);
  const rAt1 = recallAtK(returnedKeys, evalCase.expectedKeys, 1);
  const rAt10 = recallAtK(returnedKeys, evalCase.expectedKeys, 10);
  const rAt20 = recallAtK(returnedKeys, evalCase.expectedKeys, 20);
  const pAtK = precisionAtK(returnedKeys, evalCase.expectedKeys, K);
  const mrr = mrrAtK(returnedKeys, evalCase.expectedKeys, 10);
  const ndcg = ndcgAtK(returnedKeys, evalCase.expectedKeys, 10);

  const typeCorrect = evalCase.expectedType === null
    ? true
    : results.length === 0 || results.some((r) => r.type === evalCase.expectedType);

  const emptyResult = results.length === 0;

  const passed = rAtK >= 0.5 && (evalCase.expectedKeys.length === 0 ? emptyResult : !emptyResult) && typeCorrect;

  const failureReason = classifyFailure(evalCase, results, rAtK);

  return {
    id: evalCase.id,
    query: evalCase.query,
    category: evalCase.category,
    returnedKeys,
    expectedKeys: evalCase.expectedKeys,
    recallAtK: rAtK,
    recallAt1: rAt1,
    recallAt10: rAt10,
    recallAt20: rAt20,
    precisionAtK: pAtK,
    mrrAt10: mrr,
    ndcgAt10: ndcg,
    typeCorrect,
    emptyResult,
    latencyMs,
    passed,
    failureReason,
  };
}

function computeBucketStats(results: EvalResult[]): BucketStats {
  const count = results.length;
  if (count === 0) {
    return { count: 0, recallAt5: 0, precisionAt5: 0, mrrAt10: 0, ndcgAt10: 0, passed: 0, failed: 0, emptyResultRate: 0 };
  }
  return {
    count,
    recallAt5: results.reduce((s, r) => s + r.recallAtK, 0) / count,
    precisionAt5: results.reduce((s, r) => s + r.precisionAtK, 0) / count,
    mrrAt10: results.reduce((s, r) => s + r.mrrAt10, 0) / count,
    ndcgAt10: results.reduce((s, r) => s + r.ndcgAt10, 0) / count,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    emptyResultRate: results.filter((r) => r.emptyResult).length / count,
  };
}

export function summarizeResults(results: EvalResult[]): EvalSummary {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50Idx = Math.floor(latencies.length * 0.5);
  const p95Idx = Math.floor(latencies.length * 0.95);
  const p50Latency = latencies[Math.min(p50Idx, latencies.length - 1)] ?? 0;
  const p95Latency = latencies[Math.min(p95Idx, latencies.length - 1)] ?? 0;

  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.passed) byCategory[r.category].passed++;
  }

  const exactKeyCases = results.filter((r) => r.category === 'exact-key');
  const exactKeyHits = exactKeyCases.filter((r) => r.recallAtK === 1.0).length;

  const typeCorrectCases = results.filter((r) => r.typeCorrect).length;

  const failureReasons: Record<FailureReason, number> = {
    data_missing: 0,
    intent_wrong: 0,
    candidate_missing: 0,
    rerank_wrong: 0,
    label_issue: 0,
    low_confidence: 0,
    none: 0,
  };
  for (const r of results) {
    failureReasons[r.failureReason]++;
  }

  const buckets: Record<string, BucketStats> = {};
  const categoryBuckets = groupByFallback(results, (r: EvalResult) => r.category);
  for (const [cat, catResults] of Object.entries(categoryBuckets)) {
    buckets[cat] = computeBucketStats(catResults);
  }

  const langBucket = groupByFallback(results, (r: EvalResult) => detectLanguage(r.query));
  for (const [lang, langResults] of Object.entries(langBucket)) {
    buckets[`lang:${lang}`] = computeBucketStats(langResults);
  }

  const lenBucket = groupByFallback(results, (r: EvalResult) => r.query.length <= 10 ? 'short' : r.query.length <= 30 ? 'medium' : 'long');
  for (const [len, lenResults] of Object.entries(lenBucket)) {
    buckets[`len:${len}`] = computeBucketStats(lenResults);
  }

  const n = results.length;
  return {
    totalCases: n,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    recallAt5: results.reduce((sum, r) => sum + r.recallAtK, 0) / n,
    recallAt1: results.reduce((sum, r) => sum + r.recallAt1, 0) / n,
    recallAt10: results.reduce((sum, r) => sum + r.recallAt10, 0) / n,
    recallAt20: results.reduce((sum, r) => sum + r.recallAt20, 0) / n,
    precisionAt5: results.reduce((sum, r) => sum + r.precisionAtK, 0) / n,
    mrrAt10: results.reduce((sum, r) => sum + r.mrrAt10, 0) / n,
    ndcgAt10: results.reduce((sum, r) => sum + r.ndcgAt10, 0) / n,
    exactKeyHitRate: exactKeyCases.length > 0 ? exactKeyHits / exactKeyCases.length : 1.0,
    emptyResultRate: results.filter((r) => r.emptyResult).length / n,
    p50Latency,
    p95Latency,
    typeAccuracy: n > 0 ? typeCorrectCases / n : 1.0,
    byCategory,
    buckets,
    failureReasons,
    results,
  };
}

function groupByFallback<T>(arr: T[], keyFn: ((item: T) => string) | string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = typeof keyFn === 'function' ? keyFn(item) : (item as Record<string, unknown>)[keyFn] as string;
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

function detectLanguage(query: string): string {
  const hasCJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(query);
  const hasLatin = /[a-zA-Z]/.test(query);
  if (hasCJK && hasLatin) return 'mixed';
  if (hasCJK) return 'zh';
  return 'en';
}
