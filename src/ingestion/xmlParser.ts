import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { RWRDocument } from '../types/index.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: true,
  alwaysCreateTextNode: false,
});

// ---------------------------------------------------------------------------
// Inheritance resolution: RWR XML files use file="parent.file" to inherit
// from a parent. This resolves the chain recursively and merges content.
// ---------------------------------------------------------------------------

const REPLACE_KEYS = new Set([
  'specification', 'stance', 'modifier', 'target_factors',
  'capacity', 'commonness', 'inventory', 'hud_icon', 'model',
  'shield', 'weak_hand_hold', 'next_in_chain',
]);

const APPEND_KEYS = new Set([
  'tag', 'animation', 'sound', 'effect',
]);

const MAX_INHERITANCE_DEPTH = 10;

const callIncludeCache = new Map<string, unknown[]>();

async function expandCallIncludes(
  calls: unknown[],
  sourceDir: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<unknown[]> {
  if (depth >= MAX_INHERITANCE_DEPTH) return calls;

  const expanded: unknown[] = [];
  for (const c of calls) {
    const attrs = (c ?? {}) as Record<string, unknown>;
    const refFile = attrs['@_file'] as string | undefined;

    if (refFile && Object.keys(attrs).filter((k) => !k.startsWith('@_') && k !== '#text').length === 0) {
      const refPath = path.resolve(sourceDir, refFile);
      if (visited.has(refPath)) continue;
      visited.add(refPath);

      let includedCalls: unknown[];
      if (callIncludeCache.has(refPath)) {
        includedCalls = callIncludeCache.get(refPath)!;
      } else {
        try {
          const content = await fs.readFile(refPath, 'utf-8');
          const parsed = parser.parse(content);
          includedCalls = ensureArray(parsed.calls?.call);
          callIncludeCache.set(refPath, includedCalls);
        } catch {
          callIncludeCache.set(refPath, []);
          includedCalls = [];
        }
      }

      const subExpanded = await expandCallIncludes(includedCalls, path.dirname(refPath), depth + 1, visited);
      expanded.push(...subExpanded);
    } else {
      expanded.push(c);
    }
  }

  return expanded;
}

function deepMergeWithParent(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parent };

  for (const [key, childVal] of Object.entries(child)) {
    if (key === '@_file') continue;

    if (key.startsWith('@_')) {
      result[key] = childVal;
      continue;
    }

    if (APPEND_KEYS.has(key)) {
      const parentArr = ensureArray(result[key]);
      const childArr = ensureArray(childVal);
      result[key] = [...parentArr, ...childArr];
      continue;
    }

    if (REPLACE_KEYS.has(key)) {
      result[key] = childVal;
      continue;
    }

    if (result[key] === undefined) {
      result[key] = childVal;
    } else {
      result[key] = childVal;
    }
  }

  return result;
}

const parentFileCache = new Map<string, Record<string, unknown> | null>();

async function resolveInheritance(
  element: Record<string, unknown>,
  sourceDir: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<Record<string, unknown>> {
  const parentFile = element['@_file'] as string | undefined;
  if (!parentFile || depth >= MAX_INHERITANCE_DEPTH) return element;

  const parentPath = path.resolve(sourceDir, parentFile);
  if (visited.has(parentPath)) return element;
  visited.add(parentPath);

  let parentParsed: Record<string, unknown> | null;
  if (parentFileCache.has(parentPath)) {
    parentParsed = parentFileCache.get(parentPath)!;
  } else {
    try {
      const content = await fs.readFile(parentPath, 'utf-8');
      const parsed = parser.parse(content);
      parentParsed = extractRootElement(parsed);
      parentFileCache.set(parentPath, parentParsed);
    } catch {
      parentFileCache.set(parentPath, null);
      parentParsed = null;
    }
  }

  if (!parentParsed) return element;

  const parentDir = path.dirname(parentPath);
  const resolvedParent = await resolveInheritance(parentParsed, parentDir, depth + 1, visited);
  return deepMergeWithParent(resolvedParent, element);
}

function extractRootElement(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) return {};

  const obj = parsed as Record<string, unknown>;

  const weapons = obj['weapons'] as Record<string, unknown> | undefined;
  if (weapons?.['weapon']) {
    const weaponArr = ensureArray(weapons['weapon']);
    if (weaponArr.length > 0) return (weaponArr[0] ?? {}) as Record<string, unknown>;
  }
  if (obj['weapon']) return obj['weapon'] as Record<string, unknown>;
  const carryItems = obj['carry_items'] as Record<string, unknown> | undefined;
  if (carryItems?.['carry_item']) {
    const items = ensureArray(carryItems['carry_item']);
    if (items.length > 0) return (items[0] ?? {}) as Record<string, unknown>;
  }
  if (obj['carry_item']) return obj['carry_item'] as Record<string, unknown>;
  const projectiles = obj['projectiles'] as Record<string, unknown> | undefined;
  if (projectiles?.['projectile']) {
    const projArr = ensureArray(projectiles['projectile']);
    if (projArr.length > 0) return (projArr[0] ?? {}) as Record<string, unknown>;
  }
  if (obj['projectile']) return obj['projectile'] as Record<string, unknown>;

  return obj;
}

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

function describeWeapon(attrs: Record<string, unknown>, resolved?: Record<string, unknown>): string {
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

  const nextInChain = resolved?.['next_in_chain'] ?? attrs['next_in_chain'];
  if (nextInChain !== undefined) {
    const chainArr = ensureArray(nextInChain as unknown);
    const chainKeys = chainArr
      .map((c: unknown) => ((c as Record<string, unknown>)?.['@_key'] ?? (c as Record<string, unknown>)?.['key']))
      .filter(Boolean) as string[];
    const shareAmmoArr = chainArr
      .map((c: unknown) => ((c as Record<string, unknown>)?.['@_share_ammo'] ?? (c as Record<string, unknown>)?.['share_ammo']))
      .filter(Boolean) as string[];
    if (chainKeys.length > 0) {
      parts.push(`It can switch to the following weapon mode(s): ${chainKeys.join(', ')}. This represents an alternative fire mode such as an underbarrel grenade launcher or a skill variant.`);
    }
    if (shareAmmoArr.length > 0) {
      const anyShare = shareAmmoArr.some((v) => String(v) === '1');
      if (anyShare) {
        parts.push('Some of these modes share ammo with the current weapon.');
      }
    }
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

interface DeathProtection {
  source: string;
  output: string;
  consumesItem: boolean;
}

function extractDeathProtection(resolved?: Record<string, unknown>): DeathProtection[] {
  if (!resolved) return [];
  const modifiers = ensureArray(resolved['modifier']);
  const results: DeathProtection[] = [];
  for (const mod of modifiers) {
    const m = mod as Record<string, unknown>;
    const cls = m['@_class'] ?? '';
    if (
      cls === 'projectile_blast_result' ||
      cls === 'projectile_hit_result' ||
      cls === 'melee_hit_result'
    ) {
      const input = m['@_input_character_state'] ?? '';
      const output = m['@_output_character_state'] ?? '';
      if (input === 'death' && output) {
        const sourceLabel =
          cls === 'projectile_blast_result' ? 'explosion' :
          cls === 'projectile_hit_result' ? 'bullet' :
          'melee';
        results.push({
          source: sourceLabel,
          output: String(output),
          consumesItem: m['@_consumes_item'] === '1',
        });
      }
    }
  }
  return results;
}

function describeCarryItem(attrs: Record<string, unknown>, resolved?: Record<string, unknown>): string {
  const parts: string[] = [];

  const name = getFlatValue(attrs, 'name');
  if (name !== undefined) parts.push(`This carry item is named "${name}".`);

  const slot = getFlatValue(attrs, 'slot');
  if (slot !== undefined) parts.push(`It occupies carry slot ${slot}.`);

  const encumbrance = getFlatValue(attrs, 'inventory.encumbrance');
  if (encumbrance !== undefined) parts.push(`It has an encumbrance of ${encumbrance}.`);

  const price = getFlatValue(attrs, 'inventory.price');
  if (price !== undefined) parts.push(`Its price is ${price}.`);

  const commonness = getFlatValue(attrs, 'commonness.value', 'commonness.@_value');
  if (commonness !== undefined) {
    const c = Number(commonness);
    if (c === 0) {
      parts.push('It cannot be found naturally in the game world (commonness: 0).');
    } else {
      parts.push(`Its spawn commonness is ${commonness}.`);
    }
  }

  const inStock = getFlatValue(attrs, 'commonness.in_stock', 'commonness.@_in_stock');
  if (inStock !== undefined) {
    parts.push(inStock === '1' || inStock === 1 ? 'It is available in stock.' : 'It is not available in stock.');
  }

  const canRespawn = getFlatValue(attrs, 'commonness.can_respawn_with', 'commonness.@_can_respawn_with');
  if (canRespawn !== undefined) {
    parts.push(canRespawn === '1' || canRespawn === 1 ? 'Players can respawn with it.' : 'Players cannot respawn with it.');
  }

  const transformOnConsume = getFlatValue(attrs, 'transform_on_consume');
  if (transformOnConsume !== undefined) {
    const deathProtections = extractDeathProtection(resolved);
    if (deathProtections.length > 0) {
      const hasActive = deathProtections.some((p) => p.output !== 'death');
      if (hasActive) {
        parts.push(`It provides armor protection. When taking a hit that would kill, the damage is mitigated instead (${deathProtections.filter((p) => p.output !== 'death').map((p) => `${p.source}: death→${p.output}`).join('; ')}). On each hit the armor degrades to the next state: "${transformOnConsume}". This chain represents the armor's remaining durability layers.`);
      } else {
        parts.push(`When taking sufficient damage, it transforms into state "${transformOnConsume}" (final layer — death protection has expired).`);
      }
    } else {
      parts.push(`When consumed or used, it transforms into "${transformOnConsume}".`);
    }
  } else {
    const deathProtections = extractDeathProtection(resolved);
    if (deathProtections.length > 0) {
      const active = deathProtections.filter((p) => p.output !== 'death');
      if (active.length > 0) {
        parts.push(`It provides protection: ${active.map((p) => `${p.source}: death→${p.output}`).join('; ')}.`);
      }
    }
  }

  const speedMod = getFlatValue(attrs, 'modifier.speed');
  if (speedMod !== undefined) {
    const v = String(speedMod);
    if (v.startsWith('+') || v.startsWith('-')) {
      parts.push(`It modifies movement speed by ${v}.`);
    } else {
      const num = parseFloat(v);
      if (num > 0) parts.push(`It increases movement speed by ${v}.`);
      else if (num < 0) parts.push(`It decreases movement speed by ${v}.`);
      else parts.push('It does not change movement speed.');
    }
  }

  const hitProbMod = getFlatValue(attrs, 'modifier.hit_success_probability');
  if (hitProbMod !== undefined) {
    const v = String(hitProbMod);
    if (v.startsWith('+') || v.startsWith('-')) {
      parts.push(`It modifies hit probability by ${v}.`);
    } else {
      const num = parseFloat(v);
      if (num > 0) parts.push(`It increases hit probability by ${v}.`);
      else if (num < 0) parts.push(`It decreases hit probability by ${v} (negative = harder to hit).`);
      else parts.push('It does not change hit probability.');
    }
  }

  const detectMod = getFlatValue(attrs, 'modifier.detectability');
  if (detectMod !== undefined) {
    const v = String(detectMod);
    if (v.startsWith('+') || v.startsWith('-')) {
      parts.push(`It modifies detectability by ${v}.`);
    } else {
      const num = parseFloat(v);
      if (num < 0) parts.push(`It reduces detectability by ${Math.abs(num)} (stealth bonus).`);
      else if (num > 0) parts.push(`It increases detectability by ${v}.`);
      else parts.push('It does not change detectability.');
    }
  }

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
  const tags = buildMetadataTags(type, key, extraMetadata);
  const fullContent = `${tags}\n${label}: ${key}\n${content}`;
  return {
    doc_id: '',
    type,
    key,
    content: fullContent,
    metadata: {
      mod_name: modName,
      file_path: filePath,
      ...extraMetadata,
    },
  };
}

function buildMetadataTags(
  type: RWRDocument['type'],
  key: string,
  extraMetadata: Record<string, unknown>,
): string {
  const tags: string[] = [`[Type: ${type}]`, `[Key: ${key}]`];

  const tagMappings: [string, string][] = [
    ['weapon_class', 'Class'],
    ['faction', 'Faction'],
    ['name', 'Name'],
    ['slot', 'Slot'],
  ];

  for (const [metaKey, tagLabel] of tagMappings) {
    const value = extraMetadata[metaKey];
    if (value !== undefined && value !== null && value !== '') {
      tags.push(`[${tagLabel}: ${value}]`);
    }
  }

  return tags.join(' ');
}

// ---------------------------------------------------------------------------
// Call files (<calls><call>...</call></calls>)
// ---------------------------------------------------------------------------
export async function parseCallFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const rawCalls = ensureArray(parsed.calls?.call);
  const sourceDir = path.dirname(filePath);
  const calls = await expandCallIncludes(rawCalls, sourceDir);

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
// Carry item files (<carry_items><carry_item>...</carry_item></carry_items>)
// ---------------------------------------------------------------------------
export async function parseCarryItemFile(filePath: string, modName: string): Promise<RWRDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parser.parse(content);
  const carryItems = ensureArray(parsed.carry_items?.carry_item);
  const sourceDir = path.dirname(filePath);

  const docs: RWRDocument[] = [];
  for (let i = 0; i < carryItems.length; i++) {
    const ci = (carryItems[i] ?? {}) as Record<string, unknown>;
    const resolved = await resolveInheritance(ci, sourceDir);
    const flatAttrs = flattenAttributes(resolved);
    const key = extractKey(ci, `carry_item_${i}`);
    const description = describeCarryItem(flatAttrs, resolved);
    const raw = extractText(resolved, 0);
    docs.push(makeDoc('carry_item', key, 'Carry Item', description, raw, filePath, modName, {
      name: ci['@_name'] ?? resolved['@_name'],
      slot: ci['@_slot'] ?? resolved['@_slot'],
    }));
  }
  return docs;
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
    const sourceDir = path.dirname(filePath);
    const docs: RWRDocument[] = [];
    for (let i = 0; i < weapons.length; i++) {
      const w = (weapons[i] ?? {}) as Record<string, unknown>;
      const resolved = await resolveInheritance(w, sourceDir);
      const flatAttrs = flattenAttributes(resolved);
      const key = extractKey(w, `weapon_${i}`);
      const description = describeWeapon(flatAttrs, resolved);
      const raw = extractText(resolved, 0);
      docs.push(makeDoc('weapon', key, 'Weapon', description, raw, filePath, modName, {
        weapon_class: w['@_weapon_class'] ?? w['@_class'] ?? resolved['@_weapon_class'] ?? resolved['@_class'],
      }));
    }
    return docs;
  }

  // If root contains <carry_item> tags (plural wrapper)
  if (parsed.carry_items?.carry_item) {
    return parseCarryItemFile(filePath, modName);
  }

  // If root is a single <carry_item> (no wrapper)
  if (parsed.carry_item) {
    const sourceDir = path.dirname(filePath);
    const ci = (parsed.carry_item ?? {}) as Record<string, unknown>;
    const resolved = await resolveInheritance(ci, sourceDir);
    const flatAttrs = flattenAttributes(resolved);
    const key = extractKey(ci, path.basename(filePath, ext));
    const description = describeCarryItem(flatAttrs, resolved);
    const raw = extractText(resolved, 0);
    return [makeDoc('carry_item', key, 'Carry Item', description, raw, filePath, modName, {
      name: ci['@_name'] ?? resolved['@_name'],
      slot: ci['@_slot'] ?? resolved['@_slot'],
    })];
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
