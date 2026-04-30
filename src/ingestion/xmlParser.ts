import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { RWRDocument } from '../types/index.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false, // keep strings as strings to avoid losing precision
  trimValues: true,
  alwaysCreateTextNode: false,
});

/**
 * Recursively extract simple key-value text from a parsed XML object.
 * Limits depth to avoid massive nested output from model files.
 */
function extractText(obj: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => extractText(item, depth)).filter(Boolean).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    const lines: string[] = [];
    for (const [k, v] of entries) {
      if (k === '#text') {
        const text = String(v).trim();
        if (text) lines.push(text);
      } else if (k.startsWith('@_')) {
        lines.push(`${k.slice(2)}: ${v}`);
      } else {
        const childText = extractText(v, depth + 1);
        if (childText) {
          lines.push(`${k}:\n  ${childText.replace(/\n/g, '\n  ')}`);
        }
      }
    }
    return lines.join('\n');
  }
  return '';
}

function ensureArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractKey(attrs: Record<string, unknown>, fallback: string): string {
  return (attrs['@_key'] ?? attrs['@_name'] ?? attrs['@_filename'] ?? fallback) as string;
}

function makeDoc(
  type: RWRDocument['type'],
  key: string,
  label: string,
  content: string,
  filePath: string,
  modName: string,
  extraMetadata: Record<string, unknown> = {}
): RWRDocument {
  return {
    doc_id: '',
    type,
    key,
    content: `${label}: ${key}\n${content}`,
    metadata: {
      mod_name: modName,
      file_path: filePath,
      ...extraMetadata,
    },
  };
}

// ---------------------------------------------------------------------------
// Call files (<calls><call>...</call></calls>)
// ---------------------------------------------------------------------------
export async function parseCallFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const calls = ensureArray(parsed.calls?.call);

  return calls.map((c: unknown, i: number) => {
    const attrs = (c ?? {}) as Record<string, unknown>;
    const key = extractKey(attrs, `call_${i}`);
    const text = extractText(c, 0);
    return makeDoc('call', key, 'Call', text, filePath, modName, {
      name: attrs['@_name'],
      initiation_comment1: attrs['@_initiation_comment1'],
    });
  });
}

// ---------------------------------------------------------------------------
// Faction XML files that contain <soldier> definitions
// ---------------------------------------------------------------------------
export async function parseFactionXml(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const docs: RWRDocument[] = [];

  // Extract faction-level metadata (if root is <faction>)
  if (parsed.faction) {
    const factionAttrs = parsed.faction as Record<string, unknown>;
    const factionName = extractKey(factionAttrs, path.basename(filePath, '.xml'));

    // Each <soldier> inside a faction becomes its own document
    const soldiers = ensureArray(factionAttrs['soldier']);
    for (const s of soldiers) {
      const sAttrs = (s ?? {}) as Record<string, unknown>;
      const soldierName = extractKey(sAttrs, 'unknown_soldier');
      const text = extractText(s, 0);
      docs.push(makeDoc('soldier', soldierName, 'Soldier', text, filePath, modName, {
        faction: factionName,
        spawn_score: sAttrs['@_spawn_score'],
        copy_from: sAttrs['@_copy_from'],
        squad_size_xp_cap: sAttrs['@_squad_size_xp_cap'],
      }));
    }

    // If no soldiers found, index the whole faction as a single doc
    if (soldiers.length === 0) {
      const text = extractText(parsed.faction, 0);
      docs.push(makeDoc('faction', factionName, 'Faction', text, filePath, modName));
    }
  }

  // all_factions.xml style: <factions><faction file="..."/></factions>
  if (parsed.factions?.faction) {
    const factions = ensureArray(parsed.factions.faction);
    for (const f of factions) {
      const fAttrs = (f ?? {}) as Record<string, unknown>;
      const factionFile = (fAttrs['@_file'] ?? 'unknown') as string;
      docs.push(makeDoc('faction', factionFile, 'Faction reference', `file: ${factionFile}`, filePath, modName));
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Character files
// ---------------------------------------------------------------------------
export async function parseCharacterFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const text = extractText(parsed, 0);
  const key = path.basename(filePath, '.character');
  return [makeDoc('character', key, 'Character', text, filePath, modName)];
}

// ---------------------------------------------------------------------------
// Generic XML dispatcher
// ---------------------------------------------------------------------------
export async function parseXmlFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const ext = path.extname(filePath).toLowerCase();

  // .call files always use call parser
  if (ext === '.call') {
    return parseCallFile(filePath, modName);
  }

  // .character files
  if (ext === '.character') {
    return parseCharacterFile(filePath, modName);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);

  // If root contains <call> tags (e.g., all_calls.xml)
  if (parsed.calls?.call) {
    return parseCallFile(filePath, modName);
  }

  // If root is <faction> or <factions> (real faction data with soldiers)
  if (parsed.faction || parsed.factions) {
    return parseFactionXml(filePath, modName);
  }

  // If root contains <soldier> directly
  if (parsed.soldier) {
    const soldiers = ensureArray(parsed.soldier);
    return soldiers.map((s: unknown, i: number) => {
      const attrs = (s ?? {}) as Record<string, unknown>;
      const key = extractKey(attrs, `soldier_${i}`);
      const text = extractText(s, 0);
      return makeDoc('soldier', key, 'Soldier', text, filePath, modName);
    });
  }

  // If root contains <weapon> tags
  if (parsed.weapons?.weapon || parsed.weapon) {
    const weapons = ensureArray(parsed.weapons?.weapon ?? parsed.weapon);
    return weapons.map((w: unknown, i: number) => {
      const attrs = (w ?? {}) as Record<string, unknown>;
      const key = extractKey(attrs, `weapon_${i}`);
      const text = extractText(w, 0);
      return makeDoc('weapon', key, 'Weapon', text, filePath, modName, {
        weapon_class: attrs['@_weapon_class'] ?? attrs['@_class'],
      });
    });
  }

  // If root contains <vehicle> tags
  if (parsed.vehicles?.vehicle || parsed.vehicle) {
    const vehicles = ensureArray(parsed.vehicles?.vehicle ?? parsed.vehicle);
    return vehicles.map((v: unknown, i: number) => {
      const attrs = (v ?? {}) as Record<string, unknown>;
      const key = extractKey(attrs, `vehicle_${i}`);
      const text = extractText(v, 0);
      return makeDoc('vehicle', key, 'Vehicle', text, filePath, modName);
    });
  }

  // If root contains <projectile> tags
  if (parsed.projectiles?.projectile || parsed.projectile) {
    const projectiles = ensureArray(parsed.projectiles?.projectile ?? parsed.projectile);
    return projectiles.map((p: unknown, i: number) => {
      const attrs = (p ?? {}) as Record<string, unknown>;
      const key = extractKey(attrs, `projectile_${i}`);
      const text = extractText(p, 0);
      return makeDoc('projectile', key, 'Projectile', text, filePath, modName);
    });
  }

  // Generic fallback: index the whole XML as one document
  const text = extractText(parsed, 0);
  const key = path.basename(filePath, ext);
  return [makeDoc('script_chunk', key, 'XML Document', text, filePath, modName)];
}
