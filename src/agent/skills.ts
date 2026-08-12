import * as fsSync from 'fs';
import {
  createReloadGate,
  loadSkills,
  selectSkills,
  type Skill,
  type SkillEntry,
} from '@rwr/agent-core';
import { config } from '../config/index.js';

/**
 * Skill registry: the same load-cache-watch lifecycle the tool plugins get, over `SKILLS_DIR`.
 *
 * Deliberately mirrors `toolDefs.ts`, down to the generation counter: a change bumps it and the
 * reload happens when the *next* request asks for skills, so an in-flight turn never has its system
 * prompt swapped out from under it. Skills are cheaper to reload than plugins — plain text, no ESM
 * cache to leak — but the timing rule is the same and there is no reason for two mental models.
 */

let cached: Skill[] = [];
let entries: SkillEntry[] = [];
const reload = createReloadGate();
let watching = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function watchSkillsDir(): void {
  if (watching || !config.toolsHotReload) return;
  watching = true;
  try {
    fsSync.watch(config.skillsDir, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log('[skill] Change detected — skills will reload on the next request');
        reload.invalidate();
      }, 300);
    });
  } catch {
    // Directory does not exist (or the platform refuses to watch it) — skills stay static.
    watching = false;
  }
}

/** Every loaded skill, reloading first if the directory changed. */
export async function getSkills(): Promise<Skill[]> {
  if (!reload.isStale()) return cached;

  // Captured before the await, checked after. The watcher can fire while `loadSkills` is reading the
  // directory, and a load that finishes describing the pre-change files must not publish over a
  // newer one that already did — nor mark itself current, which would stop anything reloading.
  const loadingGeneration = reload.begin();
  const result = await loadSkills({ dir: config.skillsDir });
  if (!reload.publish(loadingGeneration)) {
    // One edit out of date, and deliberately not cached: this turn gets these skills, the next
    // request reloads. Skills only add prompt text, so a stale set is a weaker answer, never a wrong
    // tool call.
    console.log('[skill] Directory changed mid-load — this request keeps the pre-change skills');
    return result.skills;
  }
  cached = result.skills;
  entries = result.entries;

  const ok = entries.filter((e) => !e.error);
  if (entries.length > 0) {
    console.log(
      `[skill] ${ok.length} skill(s) loaded from ${config.skillsDir}` +
        (entries.length > ok.length ? ` (${entries.length - ok.length} failed)` : ''),
    );
  }

  watchSkillsDir();
  return cached;
}

/**
 * The skills this question activates. Never throws: a broken skills directory must degrade to "no
 * skills", not to a failed turn — the same policy the tool registry follows.
 */
export async function getActiveSkills(query: string): Promise<Skill[]> {
  try {
    return selectSkills(await getSkills(), query);
  } catch (err) {
    console.warn(`[skill] Skill loading failed (${(err as Error).message}) — continuing without`);
    return [];
  }
}

/** Snapshot for the inventory endpoint. Does not trigger a load. */
export function getSkillInventory(): { skills: SkillEntry[]; skillsDir: string } {
  return { skills: entries, skillsDir: config.skillsDir };
}
