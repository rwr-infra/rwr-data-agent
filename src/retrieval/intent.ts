export type QueryCategory = 'enumeration' | 'comparison' | 'specific' | 'unknown';

const ENUMERATION_PATTERNS = /有哪些|列出|所有|全部|是什么|what are|list all|enumerate|show all/i;
const COMPARISON_PATTERNS = /对比|比较|vs|versus|哪个|哪把|哪个好|和.*比|compared|better|difference|which is|which one|区别/i;

export function classifyQuery(query: string): QueryCategory {
  if (ENUMERATION_PATTERNS.test(query)) return 'enumeration';
  if (COMPARISON_PATTERNS.test(query)) return 'comparison';
  return 'specific';
}

export function isEnumerationQuery(query: string): boolean {
  return classifyQuery(query) === 'enumeration';
}

export function isComparisonQuery(query: string): boolean {
  return classifyQuery(query) === 'comparison';
}

export function shouldUseStructuredOutput(query: string, responseFormat?: string): boolean {
  if (responseFormat === 'json_object') return true;
  const category = classifyQuery(query);
  return category === 'enumeration' || category === 'comparison';
}
