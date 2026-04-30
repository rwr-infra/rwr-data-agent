import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { RWRDocument } from '../types/index.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
});

function flattenAttributes(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@_')) {
      result[k.slice(2)] = v;
    } else if (k !== '#text') {
      result[k] = v;
    }
  }
  if ('#text' in (obj as Record<string, unknown>)) {
    result.text = (obj as Record<string, unknown>)['#text'];
  }
  return result;
}

function objectToText(obj: Record<string, unknown>, prefix = ''): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      lines.push(`${prefix}${k}:`);
      lines.push(objectToText(v as Record<string, unknown>, prefix + '  '));
    } else {
      lines.push(`${prefix}${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

export async function parseWeaponFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const weapons = parsed.weapons?.weapon ?? [];
  const items = Array.isArray(weapons) ? weapons : [weapons];

  return items.map((w: unknown, i: number) => {
    const attrs = flattenAttributes(w);
    const key = (attrs.key ?? attrs.name ?? attrs.weapon_key ?? `weapon_${i}`) as string;
    const textContent = objectToText(attrs);
    return {
      doc_id: '',
      type: 'weapon' as const,
      key,
      content: `Weapon: ${key}\n${textContent}`,
      metadata: {
        mod_name: modName,
        file_path: filePath,
        weapon_class: (attrs.weapon_class ?? attrs.class ?? '') as string,
        ...attrs,
      },
    };
  });
}

export async function parseProjectileFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const projectiles = parsed.projectiles?.projectile ?? [];
  const items = Array.isArray(projectiles) ? projectiles : [projectiles];

  return items.map((p: unknown, i: number) => {
    const attrs = flattenAttributes(p);
    const key = (attrs.key ?? attrs.name ?? `projectile_${i}`) as string;
    const textContent = objectToText(attrs);
    return {
      doc_id: '',
      type: 'projectile' as const,
      key,
      content: `Projectile: ${key}\n${textContent}`,
      metadata: {
        mod_name: modName,
        file_path: filePath,
        ...attrs,
      },
    };
  });
}

export async function parseVehicleFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const vehicles = parsed.vehicles?.vehicle ?? [];
  const items = Array.isArray(vehicles) ? vehicles : [vehicles];

  return items.map((v: unknown, i: number) => {
    const attrs = flattenAttributes(v);
    const key = (attrs.key ?? attrs.name ?? `vehicle_${i}`) as string;
    const textContent = objectToText(attrs);
    return {
      doc_id: '',
      type: 'vehicle' as const,
      key,
      content: `Vehicle: ${key}\n${textContent}`,
      metadata: {
        mod_name: modName,
        file_path: filePath,
        ...attrs,
      },
    };
  });
}

export async function parseFactionFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const factions = parsed.factions?.faction ?? [];
  const items = Array.isArray(factions) ? factions : [factions];

  return items.map((f: unknown, i: number) => {
    const attrs = flattenAttributes(f);
    const key = (attrs.key ?? attrs.name ?? `faction_${i}`) as string;
    const textContent = objectToText(attrs);
    return {
      doc_id: '',
      type: 'faction' as const,
      key,
      content: `Faction: ${key}\n${textContent}`,
      metadata: {
        mod_name: modName,
        file_path: filePath,
        ...attrs,
      },
    };
  });
}

export async function parseXmlFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes('weapon')) return parseWeaponFile(filePath, modName);
  if (base.includes('projectile')) return parseProjectileFile(filePath, modName);
  if (base.includes('vehicle')) return parseVehicleFile(filePath, modName);
  if (base.includes('faction')) return parseFactionFile(filePath, modName);
  // Generic XML fallback
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  return [{
    doc_id: '',
    type: 'script_chunk' as const,
    key: path.basename(filePath, '.xml'),
    content: JSON.stringify(parsed, null, 2),
    metadata: { mod_name: modName, file_path: filePath },
  }];
}
