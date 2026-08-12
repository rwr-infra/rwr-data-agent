import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkills, selectSkills, type Skill } from '@rwr/agent-core';

let dir: string;

async function write(file: string, body: string) {
  await fs.writeFile(path.join(dir, file), body, 'utf8');
}

const load = () => loadSkills({ dir });

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwr-skills-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadSkills — discovery', () => {
  it('treats a missing directory as no skills, not an error', async () => {
    const loaded = await loadSkills({ dir: path.join(dir, 'nope') });
    expect(loaded).toEqual({ skills: [], entries: [] });
  });

  it('loads a skill and strips its frontmatter', async () => {
    await write(
      'upgrades.md',
      `---
name: castling-upgrades
triggers: [升级, upgrade]
---
Always resolve the base weapon first.`,
    );

    const { skills, entries } = await load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('castling-upgrades');
    expect(skills[0].body).toBe('Always resolve the base weapon first.');
    expect(entries[0].error).toBeUndefined();
  });

  it('accepts a dash list for triggers and normalizes them', async () => {
    await write(
      'x.md',
      `---
name: dashed
triggers:
  - "  Upgrade  "
  - 升级
---
body`,
    );

    const { skills, entries } = await load();
    // Quotes are stripped on the dash branch too — having it on one branch and not the other is
    // exactly the split-brain a hand-rolled parser invites.
    expect(skills[0].triggers).toEqual(['upgrade', '升级']);
    // The author's spelling survives on the inventory entry: someone debugging why their skill did
    // not fire needs to see their own file, not a lowercased copy of it.
    expect(entries[0].triggers).toEqual(['  Upgrade  ', '升级']);
  });

  it('falls back to the filename when no name is declared', async () => {
    await write('fallback-name.md', `---\ntriggers: [x]\n---\nbody`);
    const { skills } = await load();
    expect(skills[0].name).toBe('fallback-name');
  });

  it('skips files that are not skills', async () => {
    await write('_draft.md', `---\ntriggers: [x]\n---\nbody`);
    await write('.hidden.md', `---\ntriggers: [x]\n---\nbody`);
    await write('notes.txt', 'not a skill');
    await write('real.md', `---\ntriggers: [x]\n---\nbody`);

    const { skills } = await load();
    expect(skills.map((s) => s.name)).toEqual(['real']);
  });
});

describe('loadSkills — validation', () => {
  /**
   * The asymmetry with plugin tools is the point. Hiding a tool costs the model an option it can
   * ask for on a later step; an always-on skill is paid for in *every* turn's context. So "no
   * triggers" is a configuration error here, not an always-on skill.
   */
  it('rejects a skill with no triggers', async () => {
    await write('always.md', `---\nname: always\n---\nbody`);
    const { skills, entries } = await load();

    expect(skills).toEqual([]);
    expect(entries[0].error).toContain('at least one trigger');
  });

  /**
   * A trigger list that is non-empty on paper and empty after normalization is the worst of both:
   * the file loads, so nothing reports a problem, and the skill can never be selected. Rejecting it
   * is what keeps the rule above from having a silent hole.
   */
  it('rejects triggers that survive parsing but not normalization', async () => {
    await write('blank-dash.md', `---\nname: blank-dash\ntriggers:\n  - ""\n  - '   '\n---\nbody`);
    const { skills, entries } = await load();

    expect(skills).toEqual([]);
    expect(entries[0].error).toContain('at least one trigger');
  });

  it('rejects an empty body', async () => {
    await write('empty.md', `---\nname: empty\ntriggers: [x]\n---\n`);
    const { skills, entries } = await load();
    expect(skills).toEqual([]);
    expect(entries[0].error).toContain('no body');
  });

  /**
   * A skill body is injected verbatim into the system prompt of every matching turn, and the chat
   * route rejects an oversized prompt with a 400. Capping at load time trades one unusable playbook
   * for a working server, and says which file on `GET /v1/tools`.
   */
  it('rejects an oversized body', async () => {
    await write('huge.md', `---\nname: huge\ntriggers: [x]\n---\n${'a'.repeat(16_001)}`);
    const { skills, entries } = await load();

    expect(skills).toEqual([]);
    expect(entries[0].error).toContain('over the 16000 limit');
  });

  it('rejects an invalid name', async () => {
    await write('bad.md', `---\nname: "not a valid name"\ntriggers: [x]\n---\nbody`);
    const { entries } = await load();
    expect(entries[0].error).toContain('invalid skill name');
  });

  it('refuses a duplicate name and keeps the first', async () => {
    await write('a-first.md', `---\nname: dupe\ntriggers: [x]\n---\nfirst`);
    await write('b-second.md', `---\nname: dupe\ntriggers: [y]\n---\nsecond`);

    const { skills, entries } = await load();
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe('first');
    expect(entries[1].error).toContain('duplicate skill name');
  });

  // One malformed file must not take the others down.
  it('isolates a broken skill from the working ones', async () => {
    await write('a-broken.md', `---\nname: broken\n---\nno triggers`);
    await write('b-fine.md', `---\nname: survivor\ntriggers: [x]\n---\nbody`);

    const { skills, entries } = await load();
    expect(skills.map((s) => s.name)).toEqual(['survivor']);
    expect(entries[0].error).toBeTruthy();
    expect(entries[1].error).toBeUndefined();
  });

  // Frontmatter is optional in the format, but a file without it has no triggers and so is invalid.
  it('rejects a plain markdown file with no frontmatter', async () => {
    await write('plain.md', 'just some prose');
    const { skills, entries } = await load();
    expect(skills).toEqual([]);
    expect(entries[0].error).toContain('at least one trigger');
  });
});

describe('selectSkills', () => {
  const skill = (name: string, triggers: string[]): Skill => ({
    name,
    triggers,
    body: `body of ${name}`,
    file: `${name}.md`,
  });
  const all = [skill('upgrades', ['升级', 'upgrade']), skill('scripts', ['angelscript'])];

  it('matches case-insensitively, CJK included', () => {
    expect(selectSkills(all, 'G36 的升级链是什么').map((s) => s.name)).toEqual(['upgrades']);
    expect(selectSkills(all, 'What is the UPGRADE chain?').map((s) => s.name)).toEqual([
      'upgrades',
    ]);
  });

  it('returns nothing when no trigger hits', () => {
    expect(selectSkills(all, 'G36 的伤害是多少')).toEqual([]);
  });

  it('can match several at once, in load order', () => {
    expect(selectSkills(all, 'upgrade paths in angelscript').map((s) => s.name)).toEqual([
      'upgrades',
      'scripts',
    ]);
  });
});
