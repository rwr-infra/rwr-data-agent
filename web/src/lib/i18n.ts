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
  searching: string;
  generating: string;
  defaultTag: string;
  ctxOver: string;
  reqFailed: string;
  netError: string;
  metaFormat: (ttfb: string | number, total: number, inp: string | number, out: string | number) => string;
  langLabel: string;
  retry: string;
  copyText: string;
  copyMarkdown: string;
  copied: string;
  recall: string;
  recallConfirm: string;
  recallConfirmBtn: string;
  recallCancelBtn: string;
  retryFailed: string;
  sessions: string;
  newSession: string;
  deleteSession: string;
  deleteConfirm: string;
  searchSessions: string;
  noSessions: string;
  untitledSession: string;
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
    searching: '搜索中',
    generating: '生成中',
    defaultTag: '(默认)',
    ctxOver: '上下文已达上限，请刷新页面开始新对话',
    reqFailed: '请求失败: ',
    netError: '网络错误: ',
    metaFormat: (ttfb, total, inp, out) =>
      `TTFB ${ttfb}ms · 总耗时 ${total}ms · 输入 ${inp} tokens · 输出 ${out} tokens`,
    langLabel: 'EN',
    retry: '重试',
    copyText: '复制文本',
    copyMarkdown: '复制 Markdown',
    copied: '已复制',
    recall: '撤回',
    recallConfirm: '撤回此消息及后续对话？',
    recallConfirmBtn: '确认撤回',
    recallCancelBtn: '取消',
    retryFailed: '重试失败，请再次尝试',
    sessions: '会话',
    newSession: '新建对话',
    deleteSession: '删除会话',
    deleteConfirm: '确定删除此会话？',
    searchSessions: '搜索会话...',
    noSessions: '暂无会话',
    untitledSession: '未命名会话',
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
    searching: 'Searching',
    generating: 'Generating',
    defaultTag: '(Default)',
    ctxOver: 'Context limit reached, please refresh to start a new conversation',
    reqFailed: 'Request failed: ',
    netError: 'Network error: ',
    metaFormat: (ttfb, total, inp, out) =>
      `TTFB ${ttfb}ms · Total ${total}ms · In ${inp} tokens · Out ${out} tokens`,
    langLabel: '中文',
    retry: 'Retry',
    copyText: 'Copy text',
    copyMarkdown: 'Copy Markdown',
    copied: 'Copied',
    recall: 'Recall',
    recallConfirm: 'Recall this message and following conversation?',
    recallConfirmBtn: 'Confirm',
    recallCancelBtn: 'Cancel',
    retryFailed: 'Retry failed, please try again',
    sessions: 'Sessions',
    newSession: 'New Chat',
    deleteSession: 'Delete',
    deleteConfirm: 'Delete this session?',
    searchSessions: 'Search sessions...',
    noSessions: 'No sessions yet',
    untitledSession: 'Untitled session',
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