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

const ENTITY_KEY_PATTERN = /`([a-zA-Z0-9_]+\.(?:weapon|vehicle|projectile|call|carry_item|xml))`/g;

function extractEntityKeys(text: string): string[] {
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = ENTITY_KEY_PATTERN.exec(text)) !== null) {
    keys.push(match[1]);
  }
  return [...new Set(keys)];
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

  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  if (lastAssistant) {
    const entityKeys = extractEntityKeys(lastAssistant.content);
    if (entityKeys.length > 0) {
      parts.push(entityKeys.slice(0, 5).join(' '));
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