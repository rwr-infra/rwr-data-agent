export type Lang = 'zh' | 'en';

function formatMs(ms: string | number): string {
  if (typeof ms === 'string') return ms;
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m${rs}s`;
}

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
  reasoning: string;
  tokenBreakdown: string;
  bdInput: string;
  bdOutput: string;
  bdSystem: string;
  bdToolDefs: string;
  bdContext: string;
  bdMessages: string;
  bdToolResults: string;
  bdCacheRead: string;
  bdReasoning: string;
  bdToolCalls: string;
  bdAnswer: string;
  bdSteps: (n: number) => string;
  bdStepsHint: (n: number) => string;
  ctxLabel: string;
  ctxHint: string;
  stopStepLimit: string;
  stopOutputLimit: string;
  allPackages: string;
  ctxOver: string;
  reqFailed: string;
  netError: string;
  metaFormat: (ttfb: string | number, total: number, inp: string | number, out: string | number, steps?: number) => string;
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
    reasoning: '思考过程',
    tokenBreakdown: 'Token 去向',
    bdInput: '输入',
    bdOutput: '输出',
    bdSystem: '系统提示',
    bdToolDefs: '工具定义',
    bdContext: '检索上下文',
    bdMessages: '对话消息',
    bdToolResults: '工具结果',
    bdCacheRead: '缓存命中',
    bdReasoning: '思考',
    bdToolCalls: '工具调用',
    bdAnswer: '回答',
    bdSteps: (n) => `${n} 步 LLM 调用`,
    bdStepsHint: (n) => `工具循环共 ${n} 步，固定部分每步重发一次`,
    ctxLabel: '上下文',
    ctxHint: '下一次请求要携带的输入量。工具调用记录不跨轮，不计入。',
    stopStepLimit: '⚠ 工具调用已达步数上限，模型未产出最终答案。请缩小问题范围或换用更具体的关键词重试。',
    stopOutputLimit: '⚠ 回答已达输出 token 上限被截断。可提高 LLM_MAX_OUTPUT_TOKENS，或把问题拆成几次提问。',
    allPackages: '全部数据包',
    ctxOver: '上下文已达上限，请刷新页面开始新对话',
    reqFailed: '请求失败: ',
    netError: '网络错误: ',
    // A tool loop re-sends the prompt every step, so In/Out are cumulative spend across the turn —
    // labelled "累计" there to distinguish them from the context bar, which shows window occupancy.
    metaFormat: (ttfb, total, inp, out, steps) =>
      `TTFB ${formatMs(ttfb)} · 总耗时 ${formatMs(total)} · ${steps && steps > 1 ? '累计输入' : '输入'} ${inp} tokens · ` +
      `${steps && steps > 1 ? '累计输出' : '输出'} ${out} tokens` +
      (steps && steps > 1 ? ` · ${steps} 步` : ''),
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
    reasoning: 'Reasoning',
    tokenBreakdown: 'Token usage',
    bdInput: 'Input',
    bdOutput: 'Output',
    bdSystem: 'System prompt',
    bdToolDefs: 'Tool definitions',
    bdContext: 'Context',
    bdMessages: 'Messages',
    bdToolResults: 'Tool results',
    bdCacheRead: 'Cache read',
    bdReasoning: 'Reasoning',
    bdToolCalls: 'Tool calls',
    bdAnswer: 'Answer',
    bdSteps: (n) => `${n} LLM step${n === 1 ? '' : 's'}`,
    bdStepsHint: (n) => `Tool loop ran ${n} steps; the fixed parts are re-sent on each`,
    ctxLabel: 'Context',
    ctxHint: 'Input the next request will carry. Tool call records do not survive the turn and are excluded.',
    stopStepLimit: '⚠ Hit the tool-call step limit without producing a final answer. Narrow the question or retry with more specific terms.',
    stopOutputLimit: '⚠ Answer was cut off at the output token limit. Raise LLM_MAX_OUTPUT_TOKENS, or split the question into several turns.',
    allPackages: 'All packages',
    ctxOver: 'Context limit reached, please refresh to start a new conversation',
    reqFailed: 'Request failed: ',
    netError: 'Network error: ',
    metaFormat: (ttfb, total, inp, out, steps) =>
      `TTFB ${formatMs(ttfb)} · Total ${formatMs(total)} · ${steps && steps > 1 ? 'In (all steps)' : 'In'} ${inp} tokens · ` +
      `${steps && steps > 1 ? 'Out (all steps)' : 'Out'} ${out} tokens` +
      (steps && steps > 1 ? ` · ${steps} steps` : ''),
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