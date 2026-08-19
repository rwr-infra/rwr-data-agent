/**
 * The shipped `skills.d/` files, checked as data rather than as code.
 *
 * `skills.test.ts` covers the loader against synthetic fixtures. This covers the four few-shot
 * playbooks that ship with the repo: they load without error, they stay well inside the body cap, and
 * their triggers actually fire on the phrasings they were written for — in both languages, since a
 * trigger list that only matches Chinese is a silent half-failure nothing reports.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadSkills, selectSkills, type Skill } from '@rwr/agent-core';

const dir = path.join(import.meta.dirname, '../../skills.d');
const FEWSHOT = [
  'fewshot-inheritance',
  'fewshot-enumeration',
  'fewshot-comparison',
  'fewshot-reverse-lookup',
];

const loaded = await loadSkills({ dir });
const byName = new Map(loaded.skills.map((s) => [s.name, s] as const));
const fired = (query: string): string[] => selectSkills(loaded.skills, query).map((s) => s.name);

describe('shipped skills.d', () => {
  it('loads every few-shot playbook with no error entry', () => {
    for (const name of FEWSHOT) {
      expect(byName.has(name), `${name} did not load`).toBe(true);
    }
    expect(loaded.entries.filter((e) => e.error)).toEqual([]);
  });

  it('keeps each body far below the 16 000-char cap', () => {
    for (const name of FEWSHOT) {
      const skill = byName.get(name) as Skill;
      expect(skill.body.length).toBeGreaterThan(200);
      expect(skill.body.length).toBeLessThan(4000);
    }
  });

  // The measured failure mode: a skill that restates the built-in playbooks costs tokens on every
  // matching turn and pushed one eval case from 5 steps to 7. These files carry examples only, so
  // they must not contain procedural instructions of their own.
  it('carries examples, not a second copy of the built-in rules', () => {
    for (const name of FEWSHOT) {
      const body = (byName.get(name) as Skill).body;
      expect(body).not.toMatch(/^\s*\d+\.\s+(先|首先|Call|Resolve|Use )/m);
      expect(body).not.toMatch(/^\s*(Thought|Action|Observation):/m);
      expect(body).toMatch(/格式样例|以本轮/);
    }
  });
});

describe('few-shot triggers', () => {
  it('fires the inheritance playbook in both languages', () => {
    expect(fired('gkw_g36.weapon 继承自哪个文件？列出完整继承链')).toContain('fewshot-inheritance');
    expect(fired('What does gkw_m4a1.weapon inherit from? Show the parent chain.')).toContain(
      'fewshot-inheritance',
    );
  });

  it('fires the enumeration playbook on list questions', () => {
    expect(fired('GFL_Castling 有哪些支援呼叫')).toContain('fewshot-enumeration');
    expect(fired('list all assault rifles')).toContain('fewshot-enumeration');
  });

  it('fires the comparison playbook on ranking questions', () => {
    expect(fired('G36 和 M4A1 有什么区别')).toContain('fewshot-comparison');
    expect(fired('G36 vs M4A1 difference in fire rate')).toContain('fewshot-comparison');
  });

  it('fires the reverse-lookup playbook on "what points at this"', () => {
    expect(fired('谁使用了 bullet.projectile')).toContain('fewshot-reverse-lookup');
    expect(fired('who uses bullet.projectile')).toContain('fewshot-reverse-lookup');
  });

  it('stays out of a plain detail question', () => {
    expect(fired('G36 的伤害是多少')).toEqual([]);
    expect(fired('what is the magazine size of the G36')).toEqual([]);
  });

  // Substring matching has no way to exclude, and this phrasing is genuinely both. Pinned rather than
  // fixed: both bodies are ~1K chars, so the overlap costs little and the alternative — triggers
  // narrow enough to never overlap — would make each playbook miss its own question.
  it('fires enumeration AND reverse-lookup on "有哪些武器引用了 X", by design', () => {
    expect(fired('有哪些武器引用了 bullet.projectile？').sort()).toEqual([
      'fewshot-enumeration',
      'fewshot-reverse-lookup',
    ]);
  });
});
