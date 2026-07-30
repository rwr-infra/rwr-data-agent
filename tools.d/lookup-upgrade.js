/**
 * Weapon upgrade chain lookup for the GFL_Castling mod.
 *
 * Mod-specific, so it lives here rather than in the core tool set. Reference
 * implementation of the plugin contract — see types/tool-plugin.d.ts.
 *
 * Chain: localized name → upgrade carry_item → source weapons → upgraded weapons.
 * Sources, all inside the package directory:
 *   1. ItemDropEvent.as     — upgrade() / giveDigimindItem() calls
 *   2. exchange.carry_item  — carry_item key → English name
 *   3. languages/cn/GFL_alltext.xml — English name → Chinese name
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const INDEX_VERSION = 2;

/** @param {string} dir @param {string} filename */
async function findFile(dir, filename) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return undefined;
}

/** Packages that ship GFL_alltext.xml — this tool is meaningless anywhere else. */
async function findCastlingRoots(dataDir) {
  const roots = [];
  const candidates = [dataDir];
  try {
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(dataDir, entry.name));
    }
  } catch {
    return roots;
  }
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, 'languages', 'cn', 'GFL_alltext.xml'));
      roots.push(dir);
    } catch {
      /* not a Castling-style package */
    }
  }
  return roots;
}

async function buildIndex(sourceDir) {
  const mappings = [];

  // Step 1 — upgrade() and giveDigimindItem() calls
  const itemDropPath = await findFile(sourceDir, 'ItemDropEvent.as');
  if (itemDropPath) {
    const content = await fs.readFile(itemDropPath, 'utf-8');
    const upgradeCalls = [];
    const digimindCalls = [];
    let m;

    // upgrade(cId, pId, "g41", "upgrade_g41.carry_item", ...)
    const upgradeRe = /upgrade\(\s*cId\s*,\s*pId\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
    while ((m = upgradeRe.exec(content)) !== null) {
      upgradeCalls.push({ pidName: m[1], carryItemKey: m[2] });
    }

    // giveDigimindItem(cId, pId, "gkw_g41_only.weapon", normalizeWeaponKey(itemKey), "g41")
    const digimindRe = /giveDigimindItem\(\s*cId\s*,\s*pId\s*,\s*"([^"]+)"\s*,\s*[^,]+,\s*"([^"]+)"/g;
    while ((m = digimindRe.exec(content)) !== null) {
      digimindCalls.push({ weaponKey: m[1], pidName: m[2] });
    }

    // checkQueue(pId,"g41") … itemKey=="gkw_g41.weapon"  → source weapons per pid
    const sourceWeaponsByPid = {};
    const sourceRe = /checkQueue\(pId\s*,\s*"([^"]+)"\)[^{]*?itemKey==?"([^"]+)"/g;
    while ((m = sourceRe.exec(content)) !== null) {
      const [, pid, weapon] = m;
      (sourceWeaponsByPid[pid] ??= []).push(weapon);
    }

    for (const uc of upgradeCalls) {
      mappings.push({
        carryItemKey: uc.carryItemKey,
        pidName: uc.pidName,
        sourceWeapons: [...new Set(sourceWeaponsByPid[uc.pidName] ?? [])],
        upgradedWeapons: digimindCalls.filter((d) => d.pidName === uc.pidName).map((d) => d.weaponKey),
        englishName: '',
        chineseName: '',
      });
    }
  }

  // Step 2 — carry_item key → English name
  const exchangePath = await findFile(sourceDir, 'exchange.carry_item');
  if (exchangePath) {
    const content = await fs.readFile(exchangePath, 'utf-8');
    const nameByKey = {};
    let m;
    const itemRe = /<carry_item\s+name="([^"]+)"\s+key="([^"]+)"/g;
    while ((m = itemRe.exec(content)) !== null) nameByKey[m[2]] = m[1];
    for (const mapping of mappings) mapping.englishName = nameByKey[mapping.carryItemKey] ?? '';
  }

  // Step 3 — English name → Chinese name
  try {
    const content = await fs.readFile(path.join(sourceDir, 'languages', 'cn', 'GFL_alltext.xml'), 'utf-8');
    const cnByEn = {};
    let m;
    const textRe = /<text\s+key="([^"]+)"\s+text="([^"]+)"/g;
    while ((m = textRe.exec(content)) !== null) cnByEn[m[1]] = m[2];
    for (const mapping of mappings) {
      if (mapping.englishName && cnByEn[mapping.englishName]) mapping.chineseName = cnByEn[mapping.englishName];
    }
  } catch {
    /* no cn translations — English names still work */
  }

  const cnNameIndex = {};
  const enNameIndex = {};
  const keyIndex = {};
  mappings.forEach((mapping, i) => {
    if (mapping.chineseName) cnNameIndex[mapping.chineseName.toLowerCase()] = mapping.carryItemKey;
    if (mapping.englishName) enNameIndex[mapping.englishName.toLowerCase()] = mapping.carryItemKey;
    keyIndex[mapping.carryItemKey] = i;
    keyIndex[mapping.pidName] = i;
  });

  return {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    source_dir: sourceDir,
    mappings,
    cnNameIndex,
    enNameIndex,
    keyIndex,
  };
}

/** @type {import('../types/tool-plugin.js').PluginFactory} */
export default function register(host) {
  /** @type {Promise<object|null>|null} */
  let indexPromise = null;

  /**
   * Load the cached index, or build it on demand. Nothing upstream builds this — the
   * plugin owns its own artifact so it works from a cold checkout.
   */
  function getIndex() {
    indexPromise ??= (async () => {
      // Applicability is decided before the cache is read: the cached artifact is Castling's,
      // and serving it to a request scoped to another package is exactly the cross-package
      // answer the scope exists to prevent.
      let roots = await findCastlingRoots(host.config.dataDir);
      if (host.scope) roots = roots.filter((dir) => path.basename(dir) === host.scope);
      if (roots.length === 0) return null;

      const cachePath = path.join(host.config.outputDir, 'upgrade-index.json');
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        if (cached.version === INDEX_VERSION && cached.source_dir === roots[0]) return cached;
      } catch {
        /* no usable cache — build below */
      }

      const index = await buildIndex(roots[0]);
      host.log(`upgrade index: ${index.mappings.length} mappings from ${roots[0]}`);
      try {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify(index), 'utf-8');
      } catch (err) {
        host.log(`upgrade index not cached (${err.message}) — will rebuild next boot`);
      }
      return index;
    })();
    return indexPromise;
  }

  return [
    {
      name: 'lookupUpgrade',
      description:
        'Look up Castling mod weapon upgrade items by Chinese name, English name, carry_item key, or weapon key. ' +
        'Traces the full upgrade chain: localized name → upgrade carry_item → source weapons → upgraded (MOD3) weapons. ' +
        'Use to answer "高性能战术发饰是给哪个武器用的" or "汉阳造的升级配件是什么". ' +
        'Returns the carry_item key, pid name, source weapon keys, and upgraded weapon keys.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The upgrade item name (Chinese or English), carry_item key, or weapon key',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query }) {
        const index = await getIndex();
        // Not a Castling-style package: report it instead of throwing, so the model
        // can fall back to normal retrieval.
        if (!index) {
          return {
            query,
            found: false,
            reason: host.scope
              ? `Package "${host.scope}" is not a Castling-style mod (no languages/cn/GFL_alltext.xml) — this tool has nothing for it. Do not answer from another package.`
              : 'No package with languages/cn/GFL_alltext.xml under DATA_DIR — this tool only covers Castling-style mods.',
          };
        }

        const lower = query.toLowerCase().trim();
        const byKey = (key) => index.mappings[index.keyIndex[key]];

        if (index.cnNameIndex[lower]) return { query, found: true, mapping: byKey(index.cnNameIndex[lower]) };
        for (const [cnName, key] of Object.entries(index.cnNameIndex)) {
          if (cnName.includes(lower) || lower.includes(cnName)) return { query, found: true, mapping: byKey(key) };
        }

        // Character-level fuzzy match for partial Chinese queries.
        const queryChars = new Set(lower.replace(/[^一-鿿]/g, '').split(''));
        if (queryChars.size >= 2) {
          let best = null;
          for (const [cnName, key] of Object.entries(index.cnNameIndex)) {
            const nameChars = new Set(cnName.replace(/[^一-鿿]/g, '').split(''));
            let overlap = 0;
            for (const ch of queryChars) if (nameChars.has(ch)) overlap++;
            if (overlap / queryChars.size >= 0.6 && (!best || overlap > best.overlap)) best = { key, overlap };
          }
          if (best) return { query, found: true, mapping: byKey(best.key) };
        }

        if (index.enNameIndex[lower]) return { query, found: true, mapping: byKey(index.enNameIndex[lower]) };
        for (const [enName, key] of Object.entries(index.enNameIndex)) {
          if (enName.includes(lower) || lower.includes(enName)) return { query, found: true, mapping: byKey(key) };
        }

        const trimmed = query.trim();
        if (index.keyIndex[trimmed] !== undefined) return { query, found: true, mapping: byKey(trimmed) };

        for (const mapping of index.mappings) {
          const all = [...mapping.sourceWeapons, ...mapping.upgradedWeapons];
          if (all.some((w) => w.toLowerCase().includes(lower))) return { query, found: true, mapping };
        }

        return { query, found: false };
      },
    },
  ];
}
