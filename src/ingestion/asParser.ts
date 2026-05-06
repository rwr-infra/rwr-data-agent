import * as fs from 'fs/promises';
import * as path from 'path';
import type { RWRDocument } from '../types/index.js';

interface ParsedSoldier {
  key: string;
  stats: Record<string, string | number>;
  weapons: string[];
  behaviors: string[];
}

function extractSoldierBlocks(text: string): ParsedSoldier[] {
  const blocks: ParsedSoldier[] = [];
  const blockRegex = /<(\w+)>\s*([\s\S]*?)\s*<\/\w+>/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const key = match[1];
    const body = match[2];
    const stats: Record<string, string | number> = {};
    const weapons: string[] = [];
    const behaviors: string[] = [];

    const lines = body.split('\n');
    let inBehavior = false;
    let behaviorLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      if (trimmed === 'behavior {') {
        inBehavior = true;
        behaviorLines = [];
        continue;
      }
      if (inBehavior) {
        if (trimmed === '}') {
          behaviors.push(behaviorLines.join('\n'));
          inBehavior = false;
        } else {
          behaviorLines.push(trimmed);
        }
        continue;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const k = parts[0];
        const v = parts[1];
        if (k === 'weapon') {
          weapons.push(v);
        } else {
          const num = Number(v);
          stats[k] = Number.isNaN(num) ? v : num;
        }
      }
    }

    blocks.push({ key, stats, weapons, behaviors });
  }
  return blocks;
}

function describeSoldierStats(stats: Record<string, string | number>): string {
  const parts: string[] = [];

  const xp = stats.xp;
  if (xp !== undefined) parts.push(`This soldier requires ${xp} experience points.`);

  const health = stats.health;
  if (health !== undefined) parts.push(`Its base health is ${health}.`);

  const accuracy = stats.accuracy;
  if (accuracy !== undefined) parts.push(`Its accuracy rating is ${accuracy}.`);

  const shooting = stats.shooting;
  if (shooting !== undefined) parts.push(`Its shooting skill is ${shooting}.`);

  const running = stats.running;
  if (running !== undefined) parts.push(`Its running speed factor is ${running}.`);

  const detecting = stats.detecting;
  if (detecting !== undefined) parts.push(`Its detection skill is ${detecting}.`);

  const stamina = stats.stamina;
  if (stamina !== undefined) parts.push(`Its stamina is ${stamina}.`);

  const carrying = stats.carrying;
  if (carrying !== undefined) parts.push(`Its carrying capacity factor is ${carrying}.`);

  return parts.join(' ');
}

function soldierToText(s: ParsedSoldier): string {
  const description = describeSoldierStats(s.stats);

  const rawLines: string[] = [`Soldier class: ${s.key}`];
  if (Object.keys(s.stats).length) {
    rawLines.push('Stats:');
    for (const [k, v] of Object.entries(s.stats)) {
      rawLines.push(`  ${k}: ${v}`);
    }
  }
  if (s.weapons.length) {
    rawLines.push(`Weapons: ${s.weapons.join(', ')}`);
  }
  if (s.behaviors.length) {
    rawLines.push(`Behaviors:\n${s.behaviors.join('\n')}`);
  }
  const raw = rawLines.join('\n');

  const sections: string[] = [];
  if (description) sections.push(`Description: ${description}`);
  if (raw) sections.push(`Raw Data:\n${raw}`);
  return sections.join('\n\n');
}

export async function parseAngelScriptFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const base = path.basename(filePath, '.as');

  const soldiers = extractSoldierBlocks(content);
  if (soldiers.length > 0) {
    return soldiers.map((s) => ({
      doc_id: '',
      type: 'soldier' as const,
      key: s.key,
      content: soldierToText(s),
      metadata: {
        mod_name: modName,
        file_path: filePath,
        ...s.stats,
        weapons: s.weapons,
      },
    }));
  }

  // Fallback: treat entire file as a script chunk
  return [{
    doc_id: '',
    type: 'script_chunk' as const,
    key: base,
    content: `AngelScript file: ${base}\n\n${content}`,
    metadata: {
      mod_name: modName,
      file_path: filePath,
    },
  }];
}
