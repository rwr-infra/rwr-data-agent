import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Skills: prompt fragments an operator drops in a directory, injected into the system prompt when
 * the user's question matches their triggers.
 *
 * The third extension point, next to tools and the plugin host. A **tool** is an action the model
 * can take; a **skill** is knowledge about how to act — a playbook for one mod's quirks, a house
 * style for a class of question. Adding one should not mean editing the prompt in the codebase,
 * which is what makes this the main carrier for domain knowledge in a self-hosted deployment.
 *
 * **Triggers are mandatory here, unlike on a plugin tool, and the asymmetry is deliberate.** Hiding
 * a tool from the first step costs the model an option it can still ask for on a later one. Prose
 * has no such recovery: an always-on skill is paid for in every turn's context whether or not it is
 * relevant. So a skill that declares no triggers is a configuration error, not an always-on skill.
 */

export interface Skill {
  name: string;
  /** Normalized (trimmed, lowercased) — the matcher stays a plain substring check. */
  triggers: string[];
  /** Markdown body, frontmatter stripped. Injected verbatim. */
  body: string;
  file: string;
}

/** What an inventory endpoint reports per discovered file, including the ones that failed. */
export interface SkillEntry {
  name: string;
  file: string;
  /** As the author wrote them, not normalized — an inventory nobody can debug is worth little. */
  triggers?: string[];
  loadedAt: string;
  error?: string;
}

export interface LoadedSkills {
  skills: Skill[];
  entries: SkillEntry[];
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * A deliberately tiny frontmatter reader: `key: value` lines, with `triggers` accepting either an
 * inline `[a, b]` list or `- item` lines beneath it.
 *
 * Not YAML, and not trying to be. A dependency to parse six lines of metadata is a poor trade, and
 * a partial YAML implementation that silently mis-parses an author's file is worse than one that
 * only understands two shapes and says so.
 */
/** Strip one layer of surrounding quotes. Applied on **every** branch — having it on the inline
 *  list but not the dash list is exactly the kind of split-brain a hand-rolled parser invites. */
function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(raw: string): { fields: Record<string, string[]>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { fields: {}, body: raw };

  const fields: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const line of match[1].split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      fields[currentKey].push(unquote(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;

    currentKey = pair[1];
    const value = pair[2].trim();
    if (!value) {
      fields[currentKey] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      fields[currentKey] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      fields[currentKey] = [unquote(value)];
    }
  }

  return { fields, body: raw.slice(match[0].length).trim() };
}

function parseSkill(raw: string, file: string): { skill: Skill; rawTriggers: string[] } {
  const { fields, body } = parseFrontmatter(raw);
  const name = fields.name?.[0] ?? path.basename(file, path.extname(file));
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name ${JSON.stringify(name)}`);
  }
  const triggers = fields.triggers ?? [];
  if (triggers.length === 0) {
    throw new Error(
      'needs at least one trigger — a skill without triggers would be injected into every turn. ' +
        'Use `triggers: [word, another]` or a `-` list.',
    );
  }
  if (!body) throw new Error('has no body below the frontmatter');

  return {
    skill: {
      name,
      triggers: triggers.map((t) => t.trim().toLowerCase()).filter(Boolean),
      body,
      file,
    },
    rawTriggers: triggers,
  };
}

/**
 * Load every `.md` skill under `dir`. Failure is per file, same as the plugin loader: a malformed
 * skill is recorded on its entry and skipped, never taking the others down.
 */
export async function loadSkills({ dir }: { dir: string }): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const entries: SkillEntry[] = [];

  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
      .sort();
  } catch {
    return { skills, entries }; // no skills directory — skills are optional
  }

  const seen = new Set<string>();
  for (const file of files) {
    const loadedAt = new Date().toISOString();
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const { skill, rawTriggers } = parseSkill(raw, file);
      if (seen.has(skill.name)) {
        entries.push({ name: skill.name, file, loadedAt, error: 'duplicate skill name — ignored' });
        continue;
      }
      seen.add(skill.name);
      skills.push(skill);
      // `rawTriggers`, not the normalized ones: the inventory is for a human debugging why their
      // skill did not fire, and showing them a lowercased copy of their own file hides typos.
      entries.push({ name: skill.name, file, triggers: rawTriggers, loadedAt });
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[skill] Failed to load ${file}: ${message}`);
      entries.push({ name: path.basename(file, '.md'), file, loadedAt, error: message });
    }
  }

  return { skills, entries };
}

/**
 * Skills whose triggers hit the query, in load order.
 *
 * Same matcher as progressive tool disclosure — case-insensitive substring, which is why CJK works
 * without a segmenter. Deliberately the same: one mental model for "when does my extension fire",
 * and one place a surprise can come from.
 */
export function selectSkills(skills: readonly Skill[], query: string): Skill[] {
  const lower = query.toLowerCase();
  return skills.filter((skill) => skill.triggers.some((t) => lower.includes(t)));
}
