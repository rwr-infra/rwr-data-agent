/**
 * Cheap regex intent classification. Its whole job is to pick how much retrieval a question needs
 * before any LLM call happens — a question answered from the entity graph does not need 30 documents
 * of prose in its prompt, and a bare key needs almost none.
 */
export type QueryCategory =
  | 'enumeration'
  | 'comparison'
  | 'inheritance'
  | 'source'
  | 'script'
  | 'specific';

/**
 * The answer is a list.
 *
 * Two patterns were deliberately narrowed, because both matched detail questions and dragged 150
 * documents into the prompt — and, with `response_format: json_object`, answered them against the
 * enumeration schema:
 * - `是什么` is gone entirely: "X 的类型是什么" is a definition question.
 * - bare `what are` is gone: "What are the specs of HK416?" is a detail question. An enumeration ends
 *   at the *category* it is asking about ("what are the weapons"); a detail question keeps going into
 *   a named entity ("... the specs of HK416").
 */
const ENUMERATION_PATTERNS =
  /有哪些|列出|所有|全部|list all|enumerate|show all|what are (?:all|the different|the available)|what \w+ are (?:there|available)|what are the \w+\s*\??$/i;

/**
 * The answer ranks two or more things. Split in three because a bare `哪个` ("which") is not a
 * comparison — it made "定义在哪个文件" a comparison, which then answered a file-location question
 * against the comparison schema. `哪个` only counts when a ranking word follows it.
 */
const COMPARISON_WORDS = /对比|比较|区别|差异|\bvs\b|versus|\bbetter\b|difference between|compared (?:to|with)/i;
const COMPARISON_RANKING = /哪(?:个|把|款|种|一个)[^，。？?！!]{0,8}(?:高|低|好|强|弱|大|小|快|慢|多|少|远|近|准|优|厉害)/;
const COMPARISON_PAIR = /和[^，。？?]{1,16}(?:相比|比起来|做对比|比一比)/;
/** Answered by walking `extends` edges, so the graph tools carry the answer, not the prose. */
const INHERITANCE_PATTERNS = /继承|父类|基类|基础文件|父文件|派生|模板|继承链|inherit|extends|parent file|base file|derive/i;
/** Wants a file location or the raw definition — resolve the entity, then read the file. */
const SOURCE_PATTERNS = /源码|源文件|原始文件|哪个文件|文件在哪|定义在哪|哪里定义|source file|raw file|which file|defined in|file path/i;
/** AngelScript questions are served by the symbol index, not by full-text prose. */
const SCRIPT_PATTERNS = /angelscript|\.as\b|脚本|游戏模式|game mode|script|函数签名|hook/i;

/**
 * Node types that terminate a key. A query that is essentially one of these keys can skip query
 * rewriting and broad retrieval — the key is already unambiguous.
 */
const KEY_SUFFIXES =
  'weapon|soldier|faction|script_chunk|projectile|vehicle|call|character|carry_item|resource';
const KEY_TOKEN = new RegExp(`\\b[A-Za-z0-9][A-Za-z0-9_.\\-]*\\.(?:${KEY_SUFFIXES})\\b`);

export function classifyQuery(query: string): QueryCategory {
  // Enumeration and comparison are about the *shape of the answer*, so they win: "有哪些武器继承自 X"
  // still has to enumerate, even though it mentions inheritance.
  if (ENUMERATION_PATTERNS.test(query)) return 'enumeration';
  if (COMPARISON_WORDS.test(query) || COMPARISON_RANKING.test(query) || COMPARISON_PAIR.test(query)) {
    return 'comparison';
  }
  if (SCRIPT_PATTERNS.test(query)) return 'script';
  if (INHERITANCE_PATTERNS.test(query)) return 'inheritance';
  if (SOURCE_PATTERNS.test(query)) return 'source';
  return 'specific';
}

/**
 * The key a question is essentially *about*, when it is essentially about one key.
 *
 * Requires the key to dominate the query — a full key inside a long sentence is a hint, not an
 * instruction, and the sentence may be asking something the key alone cannot answer. Returns null
 * when there is no such key, in which case the normal retrieval path runs.
 */
export function extractExactKey(query: string): string | null {
  const trimmed = query.trim();
  const match = KEY_TOKEN.exec(trimmed);
  if (!match) return null;
  // "gkw_g36.weapon" or "查询 gkw_g36.weapon" — but not a whole paragraph mentioning it in passing.
  const remainder = trimmed.replace(match[0], '').trim();
  return remainder.length <= 12 ? match[0] : null;
}

/**
 * How many documents to retrieve up front, per intent.
 *
 * Enumeration needs breadth because the listing *is* the answer. Inheritance, source and script
 * questions only need enough context to resolve which entity is meant — the answer then comes from
 * the graph tools, so retrieving 30 documents of prose just inflates every step of the tool loop.
 */
export function retrievalTopK(category: QueryCategory, exactKey: boolean): number {
  if (exactKey) return 5;
  switch (category) {
    case 'enumeration':
      return 150;
    case 'inheritance':
    case 'source':
    case 'script':
      return 12;
    default:
      return 30;
  }
}

const META_PATTERNS = /^(你是谁|你有什么能力|你好|你叫什么|介绍一下你自己|你是什么|who are you|what can you do|hello|hi\b|what are you|tell me about yourself|你的功能|你能做什么|你能干什么|你能帮什么)/i;

export function isMetaQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length > 50) return false;
  return META_PATTERNS.test(trimmed);
}
