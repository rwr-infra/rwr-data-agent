import * as fs from 'fs/promises';
import * as path from 'path';

export interface UpgradeMapping {
  carryItemKey: string;
  pidName: string;
  sourceWeapons: string[];
  upgradedWeapons: string[];
  englishName: string;
  chineseName: string;
}

export interface UpgradeIndex {
  version: number;
  built_at: string;
  mod: string;
  mappings: UpgradeMapping[];
  /** Reverse lookup: Chinese name (lowercase) → carry_item key */
  cnNameIndex: Record<string, string>;
  /** Reverse lookup: English name (lowercase) → carry_item key */
  enNameIndex: Record<string, string>;
  /** Reverse lookup: carry_item key → mapping index */
  keyIndex: Record<string, number>;
}

let upgradeIndexCache: UpgradeIndex | null = null;
let upgradeIndexPath = '';

function configureUpgradeIndex(gPath?: string): void {
  upgradeIndexPath = gPath ?? path.resolve('./output/upgrade-index.json');
}

/**
 * Build the upgrade mapping index by parsing:
 * 1. ItemDropEvent.as — upgrade() calls + giveDigimindItem calls (carry_item → weapon)
 * 2. exchange.carry_item — carry_item key → English name
 * 3. GFL_alltext.xml (cn) — English name → Chinese name
 */
export async function buildUpgradeIndex(sourceDir: string, modName: string): Promise<UpgradeIndex> {
  const mappings: UpgradeMapping[] = [];

  // Step 1: Parse ItemDropEvent.as for upgrade() and giveDigimindItem() calls
  const itemDropPath = await findFile(sourceDir, 'ItemDropEvent.as');
  const upgradeCalls: { pidName: string; carryItemKey: string }[] = [];
  const digimindCalls: { pidName: string; weaponKey: string; sourceWeaponKey: string }[] = [];

  if (itemDropPath) {
    const content = await fs.readFile(itemDropPath, 'utf-8');
    const lines = content.split('\n');

    // Match: upgrade(cId, pId, "g41", "upgrade_g41.carry_item", ...)
    const upgradeRe = /upgrade\(\s*cId\s*,\s*pId\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = upgradeRe.exec(content)) !== null) {
      upgradeCalls.push({ pidName: m[1], carryItemKey: m[2] });
    }

    // Match: giveDigimindItem(cId, pId, "gkw_g41_only.weapon", normalizeWeaponKey(itemKey), "g41")
    // The pidName is the last quoted arg, weaponKey is the 3rd arg
    const digimindRe = /giveDigimindItem\(\s*cId\s*,\s*pId\s*,\s*"([^"]+)"\s*,\s*[^,]+,\s*"([^"]+)"/g;
    while ((m = digimindRe.exec(content)) !== null) {
      digimindCalls.push({ weaponKey: m[1], sourceWeaponKey: '', pidName: m[2] });
    }

    // Match: else if ( (checkQueue(pId,"g41") ...) && (itemKey=="gkw_g41.weapon" || ...)){
    // followed by giveDigimindItem with the upgraded weapon
    const blockRe = /checkQueue\(pId\s*,\s*"([^"]+)"\)[^{]*?\(itemKey==?"([^"]+)"/g;
    while ((m = blockRe.exec(content)) !== null) {
      // These map pidName → source weapon keys
      const pid = m[1];
      const srcWeapon = m[2];
      const existing = digimindCalls.find((d) => d.pidName === pid);
      if (existing && !existing.sourceWeaponKey) {
        existing.sourceWeaponKey = srcWeapon;
      }
    }

    // Also collect all source weapons per pidName from checkQueue+itemKey patterns
    const sourceWeaponsByPid: Record<string, string[]> = {};
    const sourceRe = /checkQueue\(pId\s*,\s*"([^"]+)"\)[^{]*?itemKey==?"([^"]+)"/g;
    while ((m = sourceRe.exec(content)) !== null) {
      const pid = m[1];
      const weapon = m[2];
      if (!sourceWeaponsByPid[pid]) sourceWeaponsByPid[pid] = [];
      if (!sourceWeaponsByPid[pid].includes(weapon)) sourceWeaponsByPid[pid].push(weapon);
    }
    // Also match itemKey=="X" || itemKey=="Y" patterns
    const altRe = /itemKey==?"([^"]+)"/g;
    // This is too broad; we rely on the checkQueue context above

    // Build mappings from upgrade calls
    for (const uc of upgradeCalls) {
      const upgradedWeapons = digimindCalls
        .filter((d) => d.pidName === uc.pidName)
        .map((d) => d.weaponKey);
      const sourceWeapons = sourceWeaponsByPid[uc.pidName] ?? [];
      mappings.push({
        carryItemKey: uc.carryItemKey,
        pidName: uc.pidName,
        sourceWeapons,
        upgradedWeapons,
        englishName: '',
        chineseName: '',
      });
    }
  }

  // Step 2: Parse exchange.carry_item for carry_item key → English name
  const exchangePath = await findFile(sourceDir, 'exchange.carry_item');
  if (exchangePath) {
    const content = await fs.readFile(exchangePath, 'utf-8');
    const itemRe = /<carry_item\s+name="([^"]+)"\s+key="([^"]+)"/g;
    let m: RegExpExecArray | null;
    const nameByKey: Record<string, string> = {};
    while ((m = itemRe.exec(content)) !== null) {
      nameByKey[m[2]] = m[1];
    }
    for (const mapping of mappings) {
      mapping.englishName = nameByKey[mapping.carryItemKey] ?? '';
    }
  }

  // Step 3: Parse GFL_alltext.xml (cn) for English → Chinese name
  const alltextCnPath = path.join(sourceDir, 'languages', 'cn', 'GFL_alltext.xml');
  try {
    const content = await fs.readFile(alltextCnPath, 'utf-8');
    const textRe = /<text\s+key="([^"]+)"\s+text="([^"]+)"/g;
    let m: RegExpExecArray | null;
    const cnByEn: Record<string, string> = {};
    while ((m = textRe.exec(content)) !== null) {
      cnByEn[m[1]] = m[2];
    }
    for (const mapping of mappings) {
      if (mapping.englishName && cnByEn[mapping.englishName]) {
        mapping.chineseName = cnByEn[mapping.englishName];
      }
    }
  } catch {}

  // Build reverse indices
  const cnNameIndex: Record<string, string> = {};
  const enNameIndex: Record<string, string> = {};
  const keyIndex: Record<string, number> = {};
  mappings.forEach((mapping, i) => {
    if (mapping.chineseName) cnNameIndex[mapping.chineseName.toLowerCase()] = mapping.carryItemKey;
    if (mapping.englishName) enNameIndex[mapping.englishName.toLowerCase()] = mapping.carryItemKey;
    keyIndex[mapping.carryItemKey] = i;
    // Also index by pidName for fuzzy matching
    keyIndex[mapping.pidName] = i;
  });

  return {
    version: 1,
    built_at: new Date().toISOString(),
    mod: modName,
    mappings,
    cnNameIndex,
    enNameIndex,
    keyIndex,
  };
}

async function findFile(sourceDir: string, filename: string): Promise<string | undefined> {
  async function searchDir(dir: string): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat;
    try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const found = await searchDir(fullPath);
        if (found) return found;
      } else if (entry === filename) {
        return fullPath;
      }
    }
    return undefined;
  }
  return searchDir(sourceDir);
}

async function loadUpgradeIndex(): Promise<UpgradeIndex> {
  if (upgradeIndexCache) return upgradeIndexCache;
  configureUpgradeIndex();
  try {
    const raw = await fs.readFile(upgradeIndexPath, 'utf-8');
    upgradeIndexCache = JSON.parse(raw) as UpgradeIndex;
  } catch {
    throw new Error(`Upgrade index not found at ${upgradeIndexPath}. Run "npm run build:graph" first.`);
  }
  return upgradeIndexCache;
}

/** Save the upgrade index to JSON. */
export async function saveUpgradeIndex(index: UpgradeIndex, outputPath?: string): Promise<void> {
  const outPath = outputPath ?? path.resolve('./output/upgrade-index.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(index, null, 2), 'utf-8');
}

export interface UpgradeLookupResult {
  query: string;
  found: boolean;
  mapping?: UpgradeMapping;
}

/**
 * Look up weapon upgrade info by Chinese name, English name, carry_item key, or weapon key.
 * Traces the full chain: localized name → carry_item → source weapons → upgraded weapons.
 */
export async function lookupUpgrade(query: string): Promise<UpgradeLookupResult> {
  const index = await loadUpgradeIndex();
  const lower = query.toLowerCase().trim();

  // Try Chinese name index (exact + fuzzy)
  if (index.cnNameIndex[lower]) {
    const key = index.cnNameIndex[lower];
    return { query, found: true, mapping: index.mappings[index.keyIndex[key]] };
  }
  // Fuzzy Chinese match — check shared character overlap for partial queries
  for (const [cnName, key] of Object.entries(index.cnNameIndex)) {
    if (cnName.includes(lower) || lower.includes(cnName)) {
      return { query, found: true, mapping: index.mappings[index.keyIndex[key]] };
    }
  }
  // Character-level fuzzy: count shared CJK characters, match if >50% of query chars found
  const queryChars = new Set(lower.replace(/[^\u4e00-\u9fff]/g, '').split(''));
  if (queryChars.size >= 2) {
    let bestMatch: { key: string; overlap: number } | null = null;
    for (const [cnName, key] of Object.entries(index.cnNameIndex)) {
      const nameChars = new Set(cnName.replace(/[^\u4e00-\u9fff]/g, '').split(''));
      let overlap = 0;
      for (const ch of queryChars) if (nameChars.has(ch)) overlap++;
      const ratio = overlap / queryChars.size;
      if (ratio >= 0.6 && (!bestMatch || overlap > bestMatch.overlap)) {
        bestMatch = { key, overlap };
      }
    }
    if (bestMatch) {
      return { query, found: true, mapping: index.mappings[index.keyIndex[bestMatch.key]] };
    }
  }

  // Try English name index
  if (index.enNameIndex[lower]) {
    const key = index.enNameIndex[lower];
    return { query, found: true, mapping: index.mappings[index.keyIndex[key]] };
  }
  for (const [enName, key] of Object.entries(index.enNameIndex)) {
    if (enName.includes(lower) || lower.includes(enName)) {
      return { query, found: true, mapping: index.mappings[index.keyIndex[key]] };
    }
  }

  // Try carry_item key index
  if (index.keyIndex[query.trim()]) {
    return { query, found: true, mapping: index.mappings[index.keyIndex[query.trim()]] };
  }

  // Try matching by weapon key in source/upgraded weapons
  for (const mapping of index.mappings) {
    const allWeapons = [...mapping.sourceWeapons, ...mapping.upgradedWeapons];
    if (allWeapons.some((w) => w.toLowerCase().includes(lower))) {
      return { query, found: true, mapping };
    }
  }

  return { query, found: false };
}

export { configureUpgradeIndex };
