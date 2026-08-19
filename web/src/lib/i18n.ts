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
  exCompare: string;
  exSearch: string;
  exTrace: string;
  placeholder: string;
  send: string;
  thinking: string;
  searching: string;
  generating: string;
  reasoning: string;
  toolRunning: string;
  toolFailed: string;
  toolResult: string;
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
  roundsLabel: string;
  roundsHint: (max: number) => string;
  roundsOver: (max: number) => string;
  stopStepLimit: string;
  stopOutputLimit: string;
  streamInterrupted: string;
  /**
   * Rendered when a `steer-applied` frame arrives. The composer has no Steer button — a running turn
   * is exclusive — but `POST /v1/chat/steer` stays a public side channel, so the frame is still
   * shown when some other client uses it.
   */
  steerApplied: (message: string) => string;
  /** Mid-stream hard stop. */
  stopTurn: string;
  stopTurnHint: string;
  stopStopped: string;
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
  resetAll: string;
  resetHint: string;
  resetConfirm: string;
  resetConfirmBtn: string;
  maxMode: string;
  maxModeHint: string;
  runningCandidates: (n: number) => string;
  synthesizing: string;
  candidateN: (n: number) => string;
  candidatesTitle: string;
  disagreement: string;
  fallbackNote: string;
  reflectionPass: string;
  revisionNote: string;
  /** Wording for one reflection finding code. The backend sends an open set of codes, so an unknown
   *  one falls back to the code itself rather than rendering as blank. */
  reflectionIssue: (code: string) => string;
  modelLabel: string;
  modelSwitchHint: string;
  aiDisclaimer: string;
}

const i18n: Record<Lang, Translations> = {
  zh: {
    htmlLang: 'zh-CN',
    welcomeTitle: 'Running With Rifles 数据查询',
    welcomeDesc: '基于 RAG 的游戏数据 AI 助手，支持武器、兵种、载具、阵营等数据查询',
    exCompare: '对比 M4A1 和 AK47 的属性',
    exSearch: '哪些载具可以运兵？',
    exTrace: 'M16A4 继承自哪个模板？',
    placeholder: '输入查询，如：你有什么能力？',
    send: '发送',
    thinking: '思考中',
    searching: '搜索中',
    generating: '生成中',
    reasoning: '思考过程',
    toolRunning: '调用中',
    toolFailed: '调用失败',
    toolResult: '结果',
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
    roundsLabel: '轮次',
    roundsHint: (max) => `单次会话最多 ${max} 轮问答（一问一答为一轮），达到上限后请新建对话`,
    roundsOver: (max) => `本次会话已达 ${max} 轮上限，请新建对话后继续提问`,
    stopStepLimit: '⚠ 工具调用已达步数上限，模型未产出最终答案。请缩小问题范围或换用更具体的关键词重试。',
    stopOutputLimit: '⚠ 回答已达输出 token 上限被截断。可提高 LLM_MAX_OUTPUT_TOKENS，或把问题拆成几次提问。',
    streamInterrupted: '⚠ 连接中断，回答未写完。上面是已收到的部分内容，可点重试重新生成。',
    steerApplied: (message: string) => `↳ 已补充指令：${message}`,
    stopTurn: '停止',
    stopTurnHint: '立即停止本轮，已生成的内容保留',
    stopStopped: '⏹ 已按你的要求停止。上面是停止前生成的内容。',
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
    resetAll: '一键重置',
    resetHint: '清空浏览器本地存储，修复历史会话打不开的问题',
    resetConfirm: '清空全部本地数据（会话记录、数据包选择、语言与主题偏好）并刷新页面？不可撤销。API Token 会保留。',
    resetConfirmBtn: '确认重置',
    maxMode: 'Max 模式',
    maxModeHint: '并行运行 N 路候选答案，再综合归纳出一份最终答案（更全面，更耗时）',
    runningCandidates: (n) => `正在并行运行 ${n} 路候选答案…`,
    synthesizing: '正在归纳候选答案…',
    candidateN: (n) => `候选 ${n}`,
    candidatesTitle: 'N 路候选原文',
    disagreement: '候选答案之间可能存在分歧，以归纳结果为准。',
    fallbackNote: '⚠ 归纳失败，已回退到最佳单路候选答案。',
    reflectionPass: '✓ 自检通过',
    revisionNote: '已自检并修订，后续追问以此版本为准',
    reflectionIssue: (code) =>
      ({
        'missing-citation': '缺少来源文件引用',
        'missing-key': '缺少实体 key',
        'scope-violation': '越出所选 package 范围',
        'count-mismatch': '数量与实际不符',
        'unsupported-claim': '缺少证据支撑的结论',
        'no-answer': '原轮次未给出答案',
        other: '其他问题',
      })[code] ?? code,
    modelLabel: '模型',
    modelSwitchHint: '切换对话使用的模型',
    aiDisclaimer: 'AI 生成内容，仅供参考，可能会犯错，请仔细甄别',
  },
  en: {
    htmlLang: 'en',
    welcomeTitle: 'Running With Rifles Data Query',
    welcomeDesc: 'RAG-based game data AI assistant — weapons, soldiers, vehicles, factions & more',
    exCompare: 'Compare M4A1 and AK47 stats',
    exSearch: 'Which vehicles can carry troops?',
    exTrace: 'What template does M16A4 inherit from?',
    placeholder: 'Enter query, e.g.: What can you do?',
    send: 'Send',
    thinking: 'Thinking',
    searching: 'Searching',
    generating: 'Generating',
    reasoning: 'Reasoning',
    toolRunning: 'Running',
    toolFailed: 'Failed',
    toolResult: 'Result',
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
    roundsLabel: 'Rounds',
    roundsHint: (max) => `A conversation may run ${max} rounds (one question + its answer). Start a new conversation once the cap is reached.`,
    roundsOver: (max) => `This conversation hit the ${max}-round limit — start a new one to keep asking`,
    stopStepLimit: '⚠ Hit the tool-call step limit without producing a final answer. Narrow the question or retry with more specific terms.',
    stopOutputLimit: '⚠ Answer was cut off at the output token limit. Raise LLM_MAX_OUTPUT_TOKENS, or split the question into several turns.',
    streamInterrupted: '⚠ Connection dropped before the answer finished. What arrived is kept above — use retry to regenerate.',
    steerApplied: (message: string) => `↳ Steered: ${message}`,
    stopTurn: 'Stop',
    stopTurnHint: 'Stop this turn now, keeping whatever has been generated',
    stopStopped: '⏹ Stopped as requested. What is above is everything generated before the stop.',
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
    resetAll: 'Reset all',
    resetHint: 'Clear browser local storage to fix sessions that will not open',
    resetConfirm: 'Clear all local data (sessions, package choice, language & theme) and reload? This cannot be undone. The API token is kept.',
    resetConfirmBtn: 'Confirm reset',
    maxMode: 'Max mode',
    maxModeHint: 'Run N candidate answers in parallel, then synthesize one final answer (more thorough, slower)',
    runningCandidates: (n) => `Running ${n} candidates in parallel…`,
    synthesizing: 'Synthesizing candidate answers…',
    candidateN: (n) => `Candidate ${n}`,
    candidatesTitle: 'N candidate drafts',
    disagreement: 'Candidates may disagree; the synthesis is authoritative.',
    fallbackNote: '⚠ Synthesis failed — fell back to the best single candidate.',
    reflectionPass: '✓ Self-check passed',
    revisionNote: 'Self-checked and revised — later questions build on this version',
    reflectionIssue: (code) =>
      ({
        'missing-citation': 'Value stated without a source file',
        'missing-key': 'Entity shown without its key',
        'scope-violation': 'Outside the selected package',
        'count-mismatch': 'Stated count disagrees with the list',
        'unsupported-claim': 'Claim with no supporting evidence',
        'no-answer': 'The turn produced no answer',
        other: 'Other finding',
      })[code] ?? code,
    modelLabel: 'Model',
    modelSwitchHint: 'Switch the model used for this conversation',
    aiDisclaimer: 'AI-generated content — may be wrong. Verify important details.',
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