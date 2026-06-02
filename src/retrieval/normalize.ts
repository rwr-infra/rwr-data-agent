const KEY_SUFFIX_RE = /\.(weapon|vehicle|projectile|call|carry_item|xml|character)$/i;

const COMMON_WEAPON_ALIASES: Record<string, string[]> = {
  'ak47': ['ak-47', 'ak_47', 'gkw_ak47.weapon', 'ak47.weapon'],
  'ak74': ['ak-74', 'ak_74', 'gkw_ak74.weapon'],
  'm4a1': ['m4a1', 'gkw_m4a1.weapon', 'm4a1.weapon', 'm4'],
  'g36': ['g36', 'gkw_g36.weapon', 'g36.weapon', 'hk g36'],
  'hk416': ['hk-416', 'hk_416', 'gkw_hk416.weapon', 'hk416.weapon'],
  'mp5': ['mp-5', 'mp_5', 'gkw_mp5.weapon', 'mp5.weapon'],
  'p90': ['p90', 'p-90', 'gkw_p90.weapon', 'fn p90'],
  'spas12': ['spas-12', 'spas_12', 'gkw_spas12.weapon', 'spas 12'],
  'm82a1': ['m82a1', 'm82-a1', 'gkw_m82a1.weapon', 'barrett'],
  'desert_eagle': ['desert eagle', 'deagle', '沙鹰', 'gkw_desert_eagle.weapon', 'desert_eagle.weapon'],
  'vector': ['vector', 'kriss vector', 'gkw_vector.weapon'],
  'svd': ['svd', 'gkw_svd.weapon', 'dragunov'],
  'kar98k': ['kar98k', 'kar-98k', 'kar98', 'gkw_kar98k.weapon', 'kar 98k'],
};

const VEHICLE_ALIASES: Record<string, string[]> = {
  't14_gk': ['t14', 't-14', 't14_gk.vehicle', 'armata'],
  'rubber_airboat': ['airboat', 'rubber_airboat.vehicle', 'rubber boat'],
  'm1a1_base': ['m1a1', 'm1a1_base.vehicle', 'abrams'],
};

const CARRY_ITEM_ALIASES: Record<string, string[]> = {
  'bp_t6': ['bp_t6', 'bp-t6', 'bp_t6.carry_item', 't6 armor', 't6护甲'],
  'vest_40hp': ['vest_40hp', 'vest-40hp', 'vest_40hp.carry_item', '40hp vest'],
};

const CALL_ALIASES: Record<string, string[]> = {
  'martina': ['martina.call', 'martina'],
  'chiara': ['chiara.call', 'chiara'],
  'pierre': ['pierre.call', 'pierre'],
};

const ALL_ALIASES: Record<string, string[]> = {
  ...COMMON_WEAPON_ALIASES,
  ...VEHICLE_ALIASES,
  ...CARRY_ITEM_ALIASES,
  ...CALL_ALIASES,
};

// Dynamic alias index built lazily from the DB (keys + localized names), merged under the
// curated aliases above so the hand-tuned entries still win. Populated by search.ts; until
// then matching falls back to the curated set only. A10 — replaces hand-maintained coverage.
let dynamicAliases: Record<string, string[]> = {};
let dynamicAliasesLoaded = false;

export function setDynamicAliases(map: Record<string, string[]>): void {
  dynamicAliases = map;
  dynamicAliasesLoaded = true;
}

function getAliasIndex(): Record<string, string[]> {
  return dynamicAliasesLoaded ? { ...dynamicAliases, ...ALL_ALIASES } : ALL_ALIASES;
}

export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(KEY_SUFFIX_RE, '')
    .replace(/^gkw_/, '')
    .replace(/[_-]/g, '')
    .trim();
}

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[\u3000]/g, ' ')
    .replace(/[，。！？；：""''（）【】《》、]/g, ' ')
    .replace(/[_-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEntityMentions(query: string): string[] {
  const mentions: string[] = [];
  const normalized = query.toLowerCase();

  for (const [canonical, aliases] of Object.entries(getAliasIndex())) {
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase().replace(/[_-]/g, '');
      const normalizedQuery = normalized.replace(/[_-]/g, '');
      if (normalizedQuery.includes(normalizedAlias) || normalizedAlias.includes(normalizedQuery.replace(/\s/g, ''))) {
        mentions.push(canonical);
        break;
      }
    }
  }

  const keyPattern = /([a-zA-Z0-9_]+)\.(weapon|vehicle|projectile|call|carry_item|xml|character)\b/g;
  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(query)) !== null) {
    const key = match[0];
    const canonical = normalizeKey(key);
    if (!mentions.includes(canonical)) {
      mentions.push(canonical);
    }
  }

  const modelPattern = /\b([a-zA-Z]+[-]?\d+[a-zA-Z]*|[a-zA-Z]*\d+[a-zA-Z]+[-]?\d*)\b/g;
  let modelMatch: RegExpExecArray | null;
  while ((modelMatch = modelPattern.exec(query)) !== null) {
    const model = modelMatch[1].toLowerCase().replace(/[_-]/g, '');
    if (model.length >= 3 && !mentions.includes(model)) {
      for (const [canonical, aliases] of Object.entries(getAliasIndex())) {
        const normalizedAliases = aliases.map((a) => a.toLowerCase().replace(/[_-]/g, ''));
        if (normalizedAliases.some((a) => a.includes(model) || model.includes(a))) {
          if (!mentions.includes(canonical)) {
            mentions.push(canonical);
          }
          break;
        }
      }
    }
  }

  return [...new Set(mentions)];
}

export function matchAlias(normalizedQuery: string): { canonical: string; confidence: number }[] {
  const matches: { canonical: string; confidence: number }[] = [];
  const queryNorm = normalizedQuery.replace(/[_\-\s]/g, '');

  for (const [canonical, aliases] of Object.entries(getAliasIndex())) {
    for (const alias of aliases) {
      const aliasNorm = alias.toLowerCase().replace(/[_\-\s]/g, '');
      if (queryNorm === aliasNorm) {
        matches.push({ canonical, confidence: 1.0 });
        break;
      }
      if (queryNorm.includes(aliasNorm) && aliasNorm.length >= 3) {
        matches.push({ canonical, confidence: 0.8 });
        break;
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

export function generateNormalizedVariants(key: string): string[] {
  const variants = new Set<string>();
  const lower = key.toLowerCase();

  variants.add(lower);
  variants.add(lower.replace(/[_-]/g, ''));
  variants.add(lower.replace(/[_-]/g, ' '));

  const withoutSuffix = lower.replace(KEY_SUFFIX_RE, '');
  variants.add(withoutSuffix);
  variants.add(withoutSuffix.replace(/^gkw_/, ''));
  variants.add(withoutSuffix.replace(/^gkw_/, '').replace(/[_-]/g, ''));
  variants.add(withoutSuffix.replace(/^gkw_/, '').replace(/[_-]/g, ' '));

  return [...variants].filter((v) => v.length > 0);
}
