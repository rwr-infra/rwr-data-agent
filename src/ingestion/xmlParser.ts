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

// ---------------------------------------------------------------------------
// Flatten XML parsed structure into a single-level attribute map.
// Example: { "@_key": "g36", "specification": { "@_class": "3" } }
//   -> { "key": "g36", "class": "3" }
// ---------------------------------------------------------------------------
function flattenAttributes(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj === null || obj === undefined) return result;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const nested = flattenAttributes(obj[i], `${prefix}`);
      Object.assign(result, nested);
    }
    return result;
  }

  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const keyName = k.startsWith('@_') ? k.slice(2) : k;
      const fullKey = prefix ? `${prefix}.${keyName}` : keyName;

      if (k === '#text') {
        if (String(v).trim()) result[prefix || 'text'] = v;
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        result[fullKey] = v;
      } else if (typeof v === 'object') {
        const nested = flattenAttributes(v, fullKey);
        Object.assign(result, nested);
      }
    }
  }

  return result;
}

function getFlatValue(attrs: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  for (const k of keys) {
    if (k in attrs) {
      const v = attrs[k];
      if (v !== undefined && v !== null && v !== '') return v as string | number;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Description builders — convert structured attributes into natural language
// ---------------------------------------------------------------------------

function describeWeapon(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const weaponClass = getFlatValue(attrs, 'class', 'weapon_class', 'specification.class');
  if (weaponClass !== undefined) parts.push(`This is a weapon of class ${weaponClass}.`);

  const damage = getFlatValue(attrs, 'damage', 'specification.damage');
  if (damage !== undefined) parts.push(`It deals ${damage} base damage per shot.`);

  const magazineSize = getFlatValue(attrs, 'magazine_size', 'specification.magazine_size');
  if (magazineSize !== undefined) parts.push(`It has a magazine capacity of ${magazineSize} rounds.`);

  const rpm = getFlatValue(attrs, 'rpm', 'specification.rpm');
  if (rpm !== undefined) parts.push(`Its rate of fire is ${rpm} rounds per minute.`);

  const range = getFlatValue(attrs, 'range', 'specification.range');
  if (range !== undefined) parts.push(`Its effective range is ${range} meters.`);

  const vehicleDamage = getFlatValue(attrs, 'vehicle_damage', 'specification.vehicle_damage');
  if (vehicleDamage !== undefined) parts.push(`Its vehicle damage multiplier is ${vehicleDamage}.`);

  const suppressFactor = getFlatValue(attrs, 'suppress_factor', 'specification.suppress_factor');
  if (suppressFactor !== undefined) parts.push(`Its suppression factor is ${suppressFactor}.`);

  const recoil = getFlatValue(attrs, 'barrel_offset', 'specification.barrel_offset');
  if (recoil !== undefined) parts.push(`It has a barrel offset of ${recoil}.`);

  const sightRange = getFlatValue(attrs, 'sight_range', 'specification.sight_range');
  if (sightRange !== undefined) parts.push(`Its sight range modifier is ${sightRange}.`);

  const slot = getFlatValue(attrs, 'slot', 'specification.slot');
  if (slot !== undefined) parts.push(`It occupies weapon slot ${slot}.`);

  const carryInBack = getFlatValue(attrs, 'carry_in_back', 'specification.carry_in_back');
  if (carryInBack !== undefined) {
    parts.push(carryInBack === '1' || carryInBack === 1 ? 'It can be carried on the back.' : 'It cannot be carried on the back.');
  }

  return parts.length > 0 ? parts.join(' ') : '';
}

function describeProjectile(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const damage = getFlatValue(attrs, 'damage', 'specification.damage');
  if (damage !== undefined) parts.push(`This projectile deals ${damage} damage on impact.`);

  const timeToLive = getFlatValue(attrs, 'time_to_live', 'specification.time_to_live');
  if (timeToLive !== undefined) parts.push(`It travels for up to ${timeToLive} seconds before expiring.`);

  const speed = getFlatValue(attrs, 'speed', 'specification.speed');
  if (speed !== undefined) parts.push(`Its base speed is ${speed} m/s.`);

  const dragConstant = getFlatValue(attrs, 'drag_constant', 'specification.drag_constant');
  if (dragConstant !== undefined) parts.push(`It has a drag constant of ${dragConstant}, affecting its trajectory.`);

  const blastDamage = getFlatValue(attrs, 'blast_damage', 'specification.blast_damage');
  if (blastDamage !== undefined) parts.push(`Its explosion deals ${blastDamage} blast damage.`);

  const blastRadius = getFlatValue(attrs, 'blast_radius', 'specification.blast_radius');
  if (blastRadius !== undefined) parts.push(`Its blast radius is ${blastRadius} meters.`);

  const bounciness = getFlatValue(attrs, 'bounciness', 'specification.bounciness');
  if (bounciness !== undefined) parts.push(`Its bounciness factor is ${bounciness}.`);

  const hitRadius = getFlatValue(attrs, 'hit_radius', 'specification.hit_radius');
  if (hitRadius !== undefined) parts.push(`Its hit detection radius is ${hitRadius} meters.`);

  const canShootDown = getFlatValue(attrs, 'can_shoot_down', 'specification.can_shoot_down');
  if (canShootDown !== undefined) {
    parts.push(canShootDown === '1' || canShootDown === 1 ? 'It can be shot down by enemy fire.' : 'It cannot be shot down.');
  }

  return parts.length > 0 ? parts.join(' ') : '';
}

function describeVehicle(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const vehicleClass = getFlatValue(attrs, 'class', 'vehicle_class');
  if (vehicleClass !== undefined) parts.push(`This is a class ${vehicleClass} vehicle.`);

  const maxSpeed = getFlatValue(attrs, 'max_speed', 'specification.max_speed');
  if (maxSpeed !== undefined) parts.push(`Its maximum speed is ${maxSpeed} m/s.`);

  const acceleration = getFlatValue(attrs, 'acceleration', 'specification.acceleration');
  if (acceleration !== undefined) parts.push(`Its acceleration is ${acceleration}.`);

  const maxHitpoints = getFlatValue(attrs, 'max_hitpoints', 'specification.max_hitpoints');
  if (maxHitpoints !== undefined) parts.push(`It has ${maxHitpoints} hit points.`);

  const armor = getFlatValue(attrs, 'armor', 'specification.armor');
  if (armor !== undefined) parts.push(`Its armor rating is ${armor}.`);

  const seatCount = getFlatValue(attrs, 'seat_count', 'specification.seat_count');
  if (seatCount !== undefined) parts.push(`It can carry ${seatCount} occupants.`);

  const weapon = getFlatValue(attrs, 'weapon', 'specification.weapon');
  if (weapon !== undefined) parts.push(`Its primary weapon is ${weapon}.`);

  const turret = getFlatValue(attrs, 'turret', 'specification.turret');
  if (turret !== undefined) parts.push(`It is equipped with a ${turret} turret.`);

  return parts.length > 0 ? parts.join(' ') : '';
}

function describeSoldier(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const spawnScore = getFlatValue(attrs, 'spawn_score');
  if (spawnScore !== undefined) parts.push(`This soldier has a spawn score of ${spawnScore}.`);

  const squadSizeCap = getFlatValue(attrs, 'squad_size_xp_cap');
  if (squadSizeCap !== undefined) parts.push(`The squad size XP cap for this soldier is ${squadSizeCap}.`);

  const copyFrom = getFlatValue(attrs, 'copy_from');
  if (copyFrom !== undefined) parts.push(`It is based on the soldier template "${copyFrom}".`);

  const faction = getFlatValue(attrs, 'faction');
  if (faction !== undefined) parts.push(`It belongs to the ${faction} faction.`);

  return parts.length > 0 ? parts.join(' ') : '';
}

function describeCall(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const name = getFlatValue(attrs, 'name');
  if (name !== undefined) parts.push(`This call is named "${name}".`);

  const initiationComment = getFlatValue(attrs, 'initiation_comment1');
  if (initiationComment !== undefined) parts.push(`When initiated, the operator says: "${initiationComment}".`);

  const type = getFlatValue(attrs, 'type');
  if (type !== undefined) parts.push(`Its call type is ${type}.`);

  const cooldown = getFlatValue(attrs, 'cooldown');
  if (cooldown !== undefined) parts.push(`It has a cooldown of ${cooldown} seconds.`);

  const cost = getFlatValue(attrs, 'cost');
  if (cost !== undefined) parts.push(`It costs ${cost} to call.`);

  return parts.length > 0 ? parts.join(' ') : '';
}

function describeCharacter(attrs: Record<string, unknown>): string {
  const parts: string[] = [];

  const name = getFlatValue(attrs, 'name');
  if (name !== undefined) parts.push(`Character name: ${name}.`);

  const faction = getFlatValue(attrs, 'faction');
  if (faction !== undefined) parts.push(`Faction: ${faction}.`);

  const appearance = getFlatValue(attrs, 'appearance');
  if (appearance !== undefined) parts.push(`Appearance variant: ${appearance}.`);

  return parts.length > 0 ? parts.join(' ') : '';
}

// ---------------------------------------------------------------------------
// Build final document content: natural language description + raw data
// ---------------------------------------------------------------------------
function buildContent(
  description: string,
  rawData: string
): string {
  const sections: string[] = [];
  if (description.trim()) {
    sections.push(`Description: ${description.trim()}`);
  }
  if (rawData.trim()) {
    sections.push(`Raw Data:\n${rawData.trim()}`);
  }
  return sections.join('\n\n');
}

function makeDoc(
  type: RWRDocument['type'],
  key: string,
  label: string,
  description: string,
  rawData: string,
  filePath: string,
  modName: string,
  extraMetadata: Record<string, unknown> = {}
): RWRDocument {
  const content = buildContent(description, rawData);
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
    const flatAttrs = flattenAttributes(c);
    const key = extractKey(attrs, `call_${i}`);
    const description = describeCall(flatAttrs);
    const raw = extractText(c, 0);
    return makeDoc('call', key, 'Call', description, raw, filePath, modName, {
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
      const flatAttrs = flattenAttributes(s);
      const soldierName = extractKey(sAttrs, 'unknown_soldier');
      const description = describeSoldier(flatAttrs);
      const raw = extractText(s, 0);
      docs.push(makeDoc('soldier', soldierName, 'Soldier', description, raw, filePath, modName, {
        faction: factionName,
        spawn_score: sAttrs['@_spawn_score'],
        copy_from: sAttrs['@_copy_from'],
        squad_size_xp_cap: sAttrs['@_squad_size_xp_cap'],
      }));
    }

    // If no soldiers found, index the whole faction as a single doc
    if (soldiers.length === 0) {
      const flatAttrs = flattenAttributes(parsed.faction);
      const description = describeSoldier(flatAttrs);
      const raw = extractText(parsed.faction, 0);
      docs.push(makeDoc('faction', factionName, 'Faction', description, raw, filePath, modName));
    }
  }

  // all_factions.xml style: <factions><faction file="..."/></factions>
  if (parsed.factions?.faction) {
    const factions = ensureArray(parsed.factions.faction);
    for (const f of factions) {
      const fAttrs = (f ?? {}) as Record<string, unknown>;
      const factionFile = (fAttrs['@_file'] ?? 'unknown') as string;
      docs.push(makeDoc('faction', factionFile, 'Faction reference', '', `file: ${factionFile}`, filePath, modName));
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
  const flatAttrs = flattenAttributes(parsed);
  const description = describeCharacter(flatAttrs);
  const raw = extractText(parsed, 0);
  const key = path.basename(filePath, '.character');
  return [makeDoc('character', key, 'Character', description, raw, filePath, modName)];
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
      const flatAttrs = flattenAttributes(s);
      const key = extractKey(attrs, `soldier_${i}`);
      const description = describeSoldier(flatAttrs);
      const raw = extractText(s, 0);
      return makeDoc('soldier', key, 'Soldier', description, raw, filePath, modName);
    });
  }

  // If root contains <weapon> tags
  if (parsed.weapons?.weapon || parsed.weapon) {
    const weapons = ensureArray(parsed.weapons?.weapon ?? parsed.weapon);
    return weapons.map((w: unknown, i: number) => {
      const attrs = (w ?? {}) as Record<string, unknown>;
      const flatAttrs = flattenAttributes(w);
      const key = extractKey(attrs, `weapon_${i}`);
      const description = describeWeapon(flatAttrs);
      const raw = extractText(w, 0);
      return makeDoc('weapon', key, 'Weapon', description, raw, filePath, modName, {
        weapon_class: attrs['@_weapon_class'] ?? attrs['@_class'],
      });
    });
  }

  // If root contains <vehicle> tags
  if (parsed.vehicles?.vehicle || parsed.vehicle) {
    const vehicles = ensureArray(parsed.vehicles?.vehicle ?? parsed.vehicle);
    return vehicles.map((v: unknown, i: number) => {
      const attrs = (v ?? {}) as Record<string, unknown>;
      const flatAttrs = flattenAttributes(v);
      const key = extractKey(attrs, `vehicle_${i}`);
      const description = describeVehicle(flatAttrs);
      const raw = extractText(v, 0);
      return makeDoc('vehicle', key, 'Vehicle', description, raw, filePath, modName);
    });
  }

  // If root contains <projectile> tags
  if (parsed.projectiles?.projectile || parsed.projectile) {
    const projectiles = ensureArray(parsed.projectiles?.projectile ?? parsed.projectile);
    return projectiles.map((p: unknown, i: number) => {
      const attrs = (p ?? {}) as Record<string, unknown>;
      const flatAttrs = flattenAttributes(p);
      const key = extractKey(attrs, `projectile_${i}`);
      const description = describeProjectile(flatAttrs);
      const raw = extractText(p, 0);
      return makeDoc('projectile', key, 'Projectile', description, raw, filePath, modName);
    });
  }

  // Generic fallback: index the whole XML as one document
  const flatAttrs = flattenAttributes(parsed);
  const description = `This is an XML configuration file.`;
  const raw = extractText(parsed, 0);
  const key = path.basename(filePath, ext);
  return [makeDoc('script_chunk', key, 'XML Document', description, raw, filePath, modName)];
}
