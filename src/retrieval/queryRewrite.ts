export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SummaryContext {
  summary: string;
  mentionedEntities: string[];
  currentTopic: string;
}

const BILINGUAL_MAP: Record<string, string[]> = {
  '武器': ['weapon'],
  '枪': ['weapon', 'gun'],
  '步枪': ['weapon', 'rifle'],
  '冲锋枪': ['weapon', 'submachine gun', 'smg'],
  '狙击': ['weapon', 'sniper', 'sniper rifle'],
  '霰弹枪': ['weapon', 'shotgun'],
  '手枪': ['weapon', 'pistol'],
  '机枪': ['weapon', 'machine gun'],
  '火箭筒': ['weapon', 'rocket launcher'],
  '榴弹': ['grenade', 'projectile', 'explosive'],
  '手雷': ['grenade', 'projectile'],
  '伤害': ['damage'],
  '射速': ['rpm', 'rate of fire'],
  '射程': ['range'],
  '弹匣': ['magazine', 'magazine_size'],
  '载具': ['vehicle'],
  '坦克': ['vehicle', 'tank'],
  '吉普': ['vehicle', 'jeep'],
  '装甲车': ['vehicle', 'apc'],
  '船': ['vehicle', 'boat'],
  '飞机': ['vehicle', 'plane', 'aircraft'],
  '士兵': ['soldier'],
  '兵种': ['soldier', 'class'],
  '阵营': ['faction'],
  '派系': ['faction'],
  '护甲': ['armor', 'vest', 'carry_item'],
  '防弹衣': ['armor', 'vest', 'carry_item'],
  '外骨骼': ['exosuit', 'exoframe', 'carry_item'],
  '呼叫': ['call', 'airstrike', 'reinforcement'],
  '空袭': ['call', 'airstrike'],
  '支援': ['call', 'reinforcement'],
  '道具': ['carry_item', 'item', 'gear'],
  '装备': ['carry_item', 'gear', 'equipment'],
  '投掷物': ['projectile', 'grenade'],
  '角色': ['character'],
  '等级': ['class'],
  '属性': ['specification'],
  '规格': ['specification'],
};

function expandWithSynonyms(query: string): string {
  const extras: string[] = [];

  for (const [cn, enTerms] of Object.entries(BILINGUAL_MAP)) {
    if (query.includes(cn)) {
      for (const term of enTerms) {
        if (!query.toLowerCase().includes(term.toLowerCase())) {
          extras.push(term);
        }
      }
    }
    for (const term of enTerms) {
      if (query.toLowerCase().includes(term.toLowerCase()) && !query.includes(cn)) {
        extras.push(cn);
        break;
      }
    }
  }

  if (extras.length === 0) return query;
  const uniqueExtras = [...new Set(extras)].slice(0, 5);
  return `${query} ${uniqueExtras.join(' ')}`;
}

export function expandQuery(query: string): string {
  return expandWithSynonyms(query);
}

const ENTITY_KEY_PATTERN = /`([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))`/g;
const ENTITY_KEY_BOLD_PATTERN = /\*\*([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))\*\*/g;
const ENTITY_KEY_PLAIN_PATTERN = /\b([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))\b/g;

function extractEntityKeys(text: string): string[] {
  const keys: string[] = [];
  let match: RegExpExecArray | null;

  const backtick = /`([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))`/g;
  while ((match = backtick.exec(text)) !== null) {
    keys.push(match[1]);
  }

  const bold = /\*\*([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))\*\*/g;
  while ((match = bold.exec(text)) !== null) {
    keys.push(match[1]);
  }

  if (keys.length === 0) {
    const plain = /\b([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml|character))\b/g;
    while ((match = plain.exec(text)) !== null) {
      keys.push(match[1]);
    }
  }

  return [...new Set(keys)];
}

function extractMentionedItemNames(text: string): string[] {
  const names: string[] = [];

  const boldNames = /\*\*([^*]+)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = boldNames.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length >= 2 && name.length <= 50 && /[a-zA-Z0-9]/.test(name)) {
      names.push(name);
    }
  }

  return [...new Set(names)].slice(0, 10);
}

export function buildSearchQuery(currentQuery: string, history: HistoryMessage[], summary?: SummaryContext): string {
  const parts: string[] = [];

  if (summary) {
    if (summary.summary) {
      parts.push(summary.summary.slice(0, 150));
    }
    if (summary.mentionedEntities.length > 0) {
      parts.push(summary.mentionedEntities.slice(0, 5).join(' '));
    }
  }

  if (history.length === 0 && parts.length > 0) {
    parts.push(currentQuery);
    const seen = new Set<string>();
    return parts.filter(p => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    }).join(' ');
  }

  if (history.length === 0) return currentQuery;

  const recentUserQueries = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content.trim());

  for (const q of recentUserQueries) {
    if (q.length <= 100) {
      parts.push(q);
    } else {
      parts.push(q.slice(0, 80));
    }
  }

  const allEntityKeys: string[] = [];
  const allItemNames: string[] = [];

  const assistantMessages = history.filter(m => m.role === 'assistant');
  for (const msg of assistantMessages) {
    const keys = extractEntityKeys(msg.content);
    allEntityKeys.push(...keys);

    if (keys.length === 0) {
      const names = extractMentionedItemNames(msg.content);
      allItemNames.push(...names);
    }
  }

  const uniqueKeys = [...new Set(allEntityKeys)].slice(0, 10);
  if (uniqueKeys.length > 0) {
    parts.push(uniqueKeys.join(' '));
  } else {
    const uniqueNames = [...new Set(allItemNames)].slice(0, 5);
    if (uniqueNames.length > 0) {
      parts.push(uniqueNames.join(' '));
    }
  }

  parts.push(currentQuery);

  const seen = new Set<string>();
  return parts.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(' ');
}