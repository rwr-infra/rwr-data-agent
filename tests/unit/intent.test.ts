import { describe, expect, it } from 'vitest';
import {
  classifyQuery,
  extractExactKey,
  isMetaQuery,
  isReverseLookup,
  retrievalTopK,
} from '../../src/retrieval/intent.js';

describe('classifyQuery', () => {
  it('classifies enumerations', () => {
    expect(classifyQuery('有哪些武器')).toBe('enumeration');
    expect(classifyQuery('列出所有 K309 的变体')).toBe('enumeration');
    expect(classifyQuery('list all weapons')).toBe('enumeration');
    expect(classifyQuery('what are the available factions')).toBe('enumeration');
  });

  // Both of these used to match ENUMERATION_PATTERNS, which dragged 150 documents into the prompt
  // and — with response_format json_object — answered a detail question against the enum schema.
  // An enumeration ends at the *category*; a detail question keeps going into a named entity.
  it('does not treat detail questions as enumerations', () => {
    expect(classifyQuery('G36 的类型是什么')).toBe('specific');
    expect(classifyQuery('What are the specs of HK416?')).toBe('specific');
  });

  it('classifies comparisons only when something is actually ranked', () => {
    expect(classifyQuery('G36 和 AK47 的区别')).toBe('comparison');
    expect(classifyQuery('G36 vs AK47')).toBe('comparison');
    expect(classifyQuery('哪个武器伤害更高')).toBe('comparison');
    expect(classifyQuery('G36 和 AK47 相比怎么样')).toBe('comparison');
  });

  // A bare 哪个 is not a comparison. This one used to be, which answered a file-location question
  // against the comparison schema.
  it('does not treat a bare 哪个 as a comparison', () => {
    expect(classifyQuery('gkw_g36 定义在哪个文件')).toBe('source');
  });

  it('classifies graph-answered intents', () => {
    expect(classifyQuery('g36 的继承链')).toBe('inheritance');
    expect(classifyQuery('what does gkw_g36 inherit from')).toBe('inheritance');
    expect(classifyQuery('这个源文件在哪里')).toBe('source');
    expect(classifyQuery('ItemDropEvent.as 里有什么函数签名')).toBe('script');
  });

  // Enumeration and comparison are about the *shape of the answer*, so they win over the
  // graph-intent patterns even when the question also mentions inheritance.
  it('lets answer shape win over graph intent', () => {
    expect(classifyQuery('有哪些武器继承自 base_primary')).toBe('enumeration');
  });

  it('falls back to specific', () => {
    expect(classifyQuery('G36 的伤害是多少')).toBe('specific');
  });
});

describe('extractExactKey', () => {
  it('extracts a key that dominates the query', () => {
    expect(extractExactKey('gkw_g36.weapon')).toBe('gkw_g36.weapon');
    expect(extractExactKey('查询 gkw_g36.weapon')).toBe('gkw_g36.weapon');
    expect(extractExactKey('bullet.projectile')).toBe('bullet.projectile');
  });

  // A full key inside a long sentence is a hint, not an instruction — the sentence may be asking
  // something the key alone cannot answer, so the normal retrieval path has to run.
  it('returns null when the key does not dominate', () => {
    expect(extractExactKey('有哪些武器引用了 bullet.projectile 这个弹药')).toBeNull();
  });

  it('returns null without a recognised node-type suffix', () => {
    expect(extractExactKey('hk416')).toBeNull();
    expect(extractExactKey('gkw_g36.unknown_type')).toBeNull();
  });
});

describe('isReverseLookup', () => {
  it('spots "what points at this"', () => {
    expect(isReverseLookup('有哪些武器引用了 bullet.projectile')).toBe(true);
    expect(isReverseLookup('哪些文件使用 base_weapon')).toBe(true);
    expect(isReverseLookup('这个 projectile 被谁引用')).toBe(true);
    expect(isReverseLookup('什么武器用了 5.56 弹药')).toBe(true);
    expect(isReverseLookup('what references bullet.projectile')).toBe(true);
    expect(isReverseLookup('which weapons use this projectile')).toBe(true);
  });

  /**
   * Order is the whole trick: a forward lookup puts the interrogative *after* the verb. Matching on
   * the verb alone would drag "G36 使用什么弹药" onto `findReferences`, which answers the opposite
   * question.
   */
  it('does not match a forward lookup', () => {
    expect(isReverseLookup('G36 使用什么弹药')).toBe(false);
    expect(isReverseLookup('gkw_g36 用了哪个 projectile 文件')).toBe(false);
    expect(isReverseLookup('G36 使用的弹药有哪些')).toBe(false);
  });

  it('does not match an ordinary enumeration or detail question', () => {
    expect(isReverseLookup('有哪些武器')).toBe(false);
    expect(isReverseLookup('哪些武器伤害最高')).toBe(false);
    expect(isReverseLookup('G36 的伤害是多少')).toBe(false);
  });
});

describe('retrievalTopK', () => {
  it('gives enumeration the breadth and graph intents the floor', () => {
    expect(retrievalTopK('enumeration', false)).toBe(150);
    expect(retrievalTopK('inheritance', false)).toBe(12);
    expect(retrievalTopK('source', false)).toBe(12);
    expect(retrievalTopK('script', false)).toBe(12);
    expect(retrievalTopK('specific', false)).toBe(30);
    expect(retrievalTopK('comparison', false)).toBe(30);
  });

  it('lets an exact key override every category', () => {
    expect(retrievalTopK('enumeration', true)).toBe(5);
    expect(retrievalTopK('specific', true)).toBe(5);
  });

  /**
   * A reverse lookup classifies as `enumeration` — its answer *is* a list — but `findReferences`
   * returns that list whole, so retrieving 150 documents of prose only inflates every step. This is
   * the measured 890K-token / 20-step case.
   */
  it('gives a reverse lookup the graph-intent breadth, not enumeration breadth', () => {
    expect(retrievalTopK('enumeration', false, true)).toBe(12);
    expect(retrievalTopK('enumeration', false, false)).toBe(150);
    // An exact key is still narrower.
    expect(retrievalTopK('enumeration', true, true)).toBe(5);
  });
});

describe('isMetaQuery', () => {
  it('detects questions about the bot', () => {
    expect(isMetaQuery('你是谁')).toBe(true);
    expect(isMetaQuery('你能做什么')).toBe(true);
    expect(isMetaQuery('who are you')).toBe(true);
  });

  it('rejects data questions and anything long', () => {
    expect(isMetaQuery('G36 的伤害是多少')).toBe(false);
    expect(isMetaQuery('你是谁'.repeat(20))).toBe(false);
  });
});
