export type Lang = 'zh' | 'en';

export interface Translations {
  htmlLang: string;
  welcomeTitle: string;
  welcomeDesc: string;
  exWeapons: string;
  exM4a1: string;
  exExact: string;
  placeholder: string;
  send: string;
  thinking: string;
  defaultTag: string;
  ctxOver: string;
  reqFailed: string;
  netError: string;
  metaFormat: (ttfb: string | number, total: number, inp: string | number, out: string | number) => string;
  langLabel: string;
}

const i18n: Record<Lang, Translations> = {
  zh: {
    htmlLang: 'zh-CN',
    welcomeTitle: 'Running With Rifles 数据查询',
    welcomeDesc: '基于 RAG 的游戏数据 AI 助手，支持武器、兵种、载具、阵营等数据查询',
    exWeapons: '有哪些武器？',
    exM4a1: 'M4A1 的属性',
    exExact: '精确查询 M4A1',
    placeholder: '输入查询，如：有哪些武器？',
    send: '发送',
    thinking: '思考中',
    defaultTag: '(默认)',
    ctxOver: '上下文已达上限，请刷新页面开始新对话',
    reqFailed: '请求失败: ',
    netError: '网络错误: ',
    metaFormat: (ttfb, total, inp, out) =>
      `TTFB ${ttfb}ms · 总耗时 ${total}ms · 输入 ${inp} tokens · 输出 ${out} tokens`,
    langLabel: 'EN',
  },
  en: {
    htmlLang: 'en',
    welcomeTitle: 'Running With Rifles Data Query',
    welcomeDesc: 'RAG-based game data AI assistant — weapons, soldiers, vehicles, factions & more',
    exWeapons: 'What weapons?',
    exM4a1: 'M4A1 stats',
    exExact: 'Exact lookup M4A1',
    placeholder: 'Enter query, e.g.: What weapons?',
    send: 'Send',
    thinking: 'Thinking',
    defaultTag: '(Default)',
    ctxOver: 'Context limit reached, please refresh to start a new conversation',
    reqFailed: 'Request failed: ',
    netError: 'Network error: ',
    metaFormat: (ttfb, total, inp, out) =>
      `TTFB ${ttfb}ms · Total ${total}ms · In ${inp} tokens · Out ${out} tokens`,
    langLabel: '中文',
  },
};

const browserLang: Lang = (navigator.language || 'zh').startsWith('zh') ? 'zh' : 'en';

export function getInitialLang(): Lang {
  return (localStorage.getItem('lang') as Lang) || browserLang;
}

export function t(lang: Lang): Translations {
  return i18n[lang];
}

export function toggleLang(lang: Lang): Lang {
  const next: Lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lang', next);
  return next;
}
