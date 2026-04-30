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

function soldierToText(s: ParsedSoldier): string {
  const lines: string[] = [`Soldier class: ${s.key}`];
  if (Object.keys(s.stats).length) {
    lines.push('Stats:');
    for (const [k, v] of Object.entries(s.stats)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  if (s.weapons.length) {
    lines.push(`Weapons: ${s.weapons.join(', ')}`);
  }
  if (s.behaviors.length) {
    lines.push(`Behaviors:\n${s.behaviors.join('\n')}`);
  }
  return lines.join('\n');
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
