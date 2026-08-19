import { describe, expect, it } from 'vitest';
import {
  REFLECTION_SYSTEM_PROMPT,
  buildReflectionPrompt,
  type ReflectionToolCallLine,
} from '../../src/retrieval/reflectionPrompt.js';
import { estimateTokens } from '../../src/api/tokenAccounting.js';
import type { SearchResult } from '../../src/types/index.js';

function hit(key: string, content = 'x'.repeat(50)): SearchResult {
  return {
    key,
    type: 'weapon',
    content,
    score: 1,
    metadata: { name: key, mod_name: 'GFL_Castling', file_path: `GFL_Castling/weapons/${key}` },
  } as unknown as SearchResult;
}

function call(name: string, ok = true): ReflectionToolCallLine {
  return { toolName: name, input: `${name} in`, result: ok ? 'done' : 'boom', ok };
}

const minimal = {
  query: 'gkw_g36.weapon 的继承链是什么？',
  answer: '**G36**（`gkw_g36.weapon`）继承自 `two_hands_ar.animation_base`。',
  retrievedContext: [hit('gkw_g36.weapon')],
  toolTranscript: [call('getInheritanceChain')],
  intent: 'inheritance' as const,
  triggers: ['intent-inheritance'],
};

describe('buildReflectionPrompt — content', () => {
  it('carries the question, the answer and the transcript', () => {
    const prompt = buildReflectionPrompt(minimal);
    expect(prompt).toContain(minimal.query);
    expect(prompt).toContain(minimal.answer);
    expect(prompt).toContain('getInheritanceChain');
  });

  it('marks a failed call so the checker cannot read it as evidence', () => {
    const prompt = buildReflectionPrompt({ ...minimal, toolTranscript: [call('getNode', false)] });
    expect(prompt).toContain('FAILED: boom');
  });

  it('adds the scope check only when the turn is scoped to a package', () => {
    expect(buildReflectionPrompt(minimal)).not.toContain('scope-violation');
    const scoped = buildReflectionPrompt({ ...minimal, packageScope: 'GFL_Castling' });
    expect(scoped).toContain('scope-violation');
    expect(scoped).toContain('GFL_Castling');
  });

  it('adds the count check only for enumeration answers', () => {
    expect(buildReflectionPrompt(minimal)).not.toContain('count-mismatch');
    expect(buildReflectionPrompt({ ...minimal, intent: 'enumeration' })).toContain(
      'count-mismatch',
    );
  });

  it('turns an empty answer into the rebuild case instead of a pile of findings', () => {
    const prompt = buildReflectionPrompt({ ...minimal, answer: '' });
    expect(prompt).toContain('no-answer');
    expect(prompt).toContain('ran out of tool steps');
  });

  it('says the context was empty rather than leaving the block blank', () => {
    expect(buildReflectionPrompt({ ...minimal, retrievedContext: [] })).toContain(
      'no retrieved context',
    );
  });

  it('tells the checker not to read an empty transcript as missing evidence', () => {
    const prompt = buildReflectionPrompt({ ...minimal, toolTranscript: [] });
    expect(prompt).toContain('none recorded');
  });

  it('names the signals that selected the turn', () => {
    expect(
      buildReflectionPrompt({ ...minimal, triggers: ['tool-failure', 'step-limit'] }),
    ).toContain('tool-failure, step-limit');
  });

  it('never introduces ReAct-style process labels', () => {
    const prompt = REFLECTION_SYSTEM_PROMPT + buildReflectionPrompt(minimal);
    expect(prompt).not.toMatch(/^\s*(Thought|Action|Observation):/m);
  });
});

describe('buildReflectionPrompt — budget', () => {
  it('leaves everything intact when no budget is given', () => {
    const answer = 'y'.repeat(40_000);
    expect(buildReflectionPrompt({ ...minimal, answer })).toContain(answer);
  });

  it('trims a long answer to fit, and says it trimmed', () => {
    const answer = 'y'.repeat(40_000);
    const prompt = buildReflectionPrompt({ ...minimal, answer, budgetTokens: 2000 });
    expect(prompt).toContain('[answer truncated to fit the review input budget]');
    expect(prompt).not.toContain(answer);
    expect(estimateTokens(prompt)).toBeLessThan(4000);
  });

  it('drops the oldest tool calls first and keeps the newest', () => {
    const many = Array.from({ length: 60 }, (_, i) => call(`tool${i}`));
    const prompt = buildReflectionPrompt({
      ...minimal,
      answer: 'y'.repeat(6000),
      toolTranscript: many,
      budgetTokens: 1600,
    });
    expect(prompt).toContain('earlier call(s) omitted');
    expect(prompt).toContain('tool59');
    expect(prompt).not.toContain('tool0(');
  });

  it('caps the context block by chars even without a token budget', () => {
    const prompt = buildReflectionPrompt({
      ...minimal,
      retrievedContext: Array.from({ length: 200 }, (_, i) => hit(`k${i}.weapon`, 'z'.repeat(600))),
    });
    expect(prompt).toContain('identity only');
  });
});
