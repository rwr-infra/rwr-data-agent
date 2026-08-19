<script lang="ts">
  import { onMount } from 'svelte';
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import type { Theme } from './lib/theme.js';
  import { getInitialTheme, toggleTheme } from './lib/theme.js';
  import type { Message, DisplayItem, Session, TokenBreakdown, CandidateView, TurnStat, TurnSegment } from './lib/types.js';
  import { estimateTokens, stripMarkdown } from './lib/utils.js';
  import { authHeaders, captureTokenFromUrl, fetchLimits } from './lib/api.js';
  import { resetLocalState } from './lib/reset.js';
  import * as sessionStore from './lib/sessionStore.js';
  import Header from './components/Header.svelte';
  import Chat from './components/Chat.svelte';
  import Welcome from './components/Welcome.svelte';
  import InputArea from './components/InputArea.svelte';
  import SessionDrawer from './components/SessionDrawer.svelte';

  const LOCAL_CACHE_KEY = 'rwr-data-agent-cache';
  type LocalCache = { selectedMod?: string; maxMode?: boolean };
  function readCache(): LocalCache {
    try { return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || '{}'); } catch { return {}; }
  }
  function writeCache(partial: Partial<LocalCache>) {
    const cache = readCache();
    Object.assign(cache, partial);
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cache));
  }

  let lang: Lang = $state(getInitialLang());
  let theme: Theme = $state(getInitialTheme());
  let tr = $derived(t(lang));
  let history: Message[] = $state([]);
  let displayItems: DisplayItem[] = $state([]);
  let loading = $state(false);
  let thinking = $state(false);
  let streaming = $state(false);
  let showWelcome = $state(true);
  let selectedMod = $state(readCache().selectedMod ?? '');
  // Best-of-N ("Max mode") per-message toggle, persisted like `selectedMod`. `maxModeTotal` is the
  // candidate count while a max run is streaming progress; `judgePhase` is on between the last
  // candidate-close and the first synthesis delta — both drive the thinking indicator text.
  let maxMode = $state(readCache().maxMode === true);
  let maxModeTotal = $state(0);
  let judgePhase = $state(false);
  let contextUsed = $state(0);
  let lastBreakdown = $state<TokenBreakdown | undefined>(undefined);
  // Fallback until the first `finish` event reports the server's own MAX_CONTEXT_TOKENS. Hardcoding
  // it alone would put the gate and the bar's denominator out of step with the server config.
  let maxContext = $state(500000);
  // Conversation-round cap (MAX_CONVERSATION_ROUNDS). Mirrors `maxContext`: a fallback that matches
  // the server default, replaced by the real figure from `GET /v1/limits` at mount. `0` = unlimited,
  // and the indicator hides itself then.
  let maxRounds = $state(20);
  // Until `/v1/limits` answers, `maxRounds` is a guess. Gating on it would reject a valid question
  // on a server configured for more rounds (or for none), so both the gate and the indicator wait.
  let limitsLoaded = $state(false);
  let pendingRecallTurnId: string | null = $state(null);
  // Id of the block still receiving deltas — the streaming caret and the live reasoning header hang
  // off it. Null between blocks (e.g. while a tool runs), which is what stops the caret from
  // blinking on a segment that is already finished.
  let activeBlockId: string | null = $state(null);
  // The running turn's server-side id, from its `turn-start` frame. This is the key the steer/stop
  // side channel needs; it is NOT the client's own `turnId`, which groups display blocks. Null while
  // nothing is running, and against a backend old enough not to announce one — the composer then
  // falls back to its pre-steering behaviour rather than offering a button that would 404.
  let serverTurnId: string | null = $state(null);
  let prefillText = $state('');
  let toast = $state<{ message: string; visible: boolean }>({ message: '', visible: false });
  let toastTimer: ReturnType<typeof setTimeout>;

  let thinkStart = $state(0);
  let elapsed = $state(0);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  let sessions = $state<Session[]>([]);
  let activeSessionId = $state<string | null>(null);
  let drawerOpen = $state(false);
  let resetting = $state(false);

  let nextId = 0;
  function uid(): string { return `m${nextId++}`; }

  // turnIds outlive the page: they are persisted with the session, while `uid()` restarts at m0 on
  // every load — a counter id stored in one run would eventually collide with one minted in the
  // next, and retry / recall / copy would silently operate on two unrelated turns at once.
  function newTurnId(): string {
    return typeof crypto?.randomUUID === 'function'
      ? `t-${crypto.randomUUID()}`
      : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** The display blocks of one stored message — the replayed timeline for assistant messages with
   *  segments, a single bubble otherwise, plus the meta line rebuilt from the attached stats. */
  function messageItems(m: Message, turnId: string): DisplayItem[] {
    const items: DisplayItem[] = [];
    if (m.role === 'assistant' && m.segments?.length) {
      // Replay the recorded timeline: text / reasoning / tool calls in the order they arrived.
      for (const seg of m.segments) {
        if (seg.kind === 'text') {
          items.push({ type: 'message', role: 'ai', content: seg.text, id: uid(), turnId });
        } else if (seg.kind === 'reasoning') {
          items.push({ type: 'reasoning', text: seg.text, id: uid(), turnId });
        } else if (seg.kind === 'reflection') {
          // Only a clean check renders on its own; a revised one is shown by the revision block below
          // it, same as while streaming.
          if (seg.verdict === 'pass') {
            items.push({ type: 'reflection', verdict: 'pass', id: uid(), turnId });
          }
        } else if (seg.kind === 'revision') {
          items.push({
            type: 'revision',
            text: seg.text,
            issues: seg.issues ?? [],
            id: uid(),
            turnId,
          });
        } else {
          items.push({
            type: 'tool-call',
            callId: seg.callId,
            toolName: seg.toolName,
            input: seg.input,
            output: seg.output,
            ok: seg.ok,
            durationMs: seg.durationMs,
            id: uid(),
            turnId,
          });
        }
      }
    } else {
      // User messages, and assistant messages from before segments were recorded.
      items.push({
        type: 'message',
        role: (m.role === 'assistant' ? 'ai' : m.role) as 'user' | 'ai',
        content: m.content,
        id: uid(),
        turnId,
      });
    }

    // Restored turns re-render their meta line (TTFB / total / tokens / steps) from the stats
    // attached to the assistant message, so a reload does not lose the per-turn numbers.
    if (m.role === 'assistant' && m.stats) {
      items.push({
        type: 'meta',
        text: tr.metaFormat(m.stats.ttfb, m.stats.total, m.stats.inTokens, m.stats.outTokens, m.stats.steps),
        id: uid(),
        turnId,
      });
    }
    return items;
  }

  function buildDisplayItems(msgs: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    // Sessions stored before the timeline UI carry no `turnId`. A question and the answer that
    // followed it are one turn, so an id minted for a user message is handed to the assistant
    // message after it — otherwise retry could not find the question to re-send.
    let pendingTurnId: string | null = null;
    for (const m of msgs) {
      if (!m.turnId) {
        m.turnId = m.role === 'user' ? newTurnId() : (pendingTurnId ?? newTurnId());
      }
      if (m.role === 'user') pendingTurnId = m.turnId;
      items.push(...messageItems(m, m.turnId));
    }
    return items;
  }

  /** Drop every assistant-side block of a turn; the user bubble stays. Shared by the retry scrub
   *  and the error rollback so the two can never diverge on what survives. */
  function stripTurnBlocks(items: DisplayItem[], turnId: string): DisplayItem[] {
    return items.filter((it) => it.turnId !== turnId || (it.type === 'message' && it.role === 'user'));
  }

  /** Restore the context bar from the last turn's stats: real context occupancy, server max, and
   *  the breakdown dropdown. Falls back to the historical estimate when the session has none. */
  function applySessionStats(session: Session) {
    const lastStats = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.stats)?.stats;
    lastBreakdown = lastStats?.breakdown;
    if (lastStats?.maxContextTokens) maxContext = lastStats.maxContextTokens;
    contextUsed = lastStats?.contextTokens ?? 0;
  }

  async function saveCurrentSession() {
    // A reset ends in a reload, and reloading fires `visibilitychange`/`beforeunload` — without this
    // gate the in-memory session would be written straight back into the store we just wiped.
    if (resetting) return;
    if (!activeSessionId) return;
    const plainMessages: Message[] = JSON.parse(JSON.stringify(history));
    if (plainMessages.length === 0) return;
    const session: Session = {
      id: activeSessionId,
      title: sessionStore.generateTitle(plainMessages),
      createdAt: sessions.find((s) => s.id === activeSessionId)?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages: plainMessages,
      selectedMod: selectedMod || undefined,
      maxMode: maxMode || undefined,
    };
    await sessionStore.saveSession(session);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
      sessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      sessions = [session, ...sessions];
    }
  }

  async function newSession() {
    await saveCurrentSession();
    const newId = sessionStore.generateId();
    activeSessionId = newId;
    history = [];
    displayItems = [];
    contextUsed = 0;
    lastBreakdown = undefined;
    showWelcome = true;
    drawerOpen = false;
    const emptySession: Session = {
      id: newId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      selectedMod: selectedMod || undefined,
      maxMode: maxMode || undefined,
    };
    await sessionStore.saveSession(emptySession);
    sessions = [emptySession, ...sessions];
  }

  async function selectSession(id: string) {
    if (id === activeSessionId) { drawerOpen = false; return; }
    await saveCurrentSession();
    const session = await sessionStore.getSession(id);
    if (!session) return;
    activeSessionId = id;
    history = session.messages.slice();
    nextId = 0;
    displayItems = buildDisplayItems(history);
    applySessionStats(session);
    showWelcome = history.length === 0;
    if (session.selectedMod !== undefined) {
      selectedMod = session.selectedMod;
      writeCache({ selectedMod: session.selectedMod });
    }
    if (session.maxMode !== undefined) {
      maxMode = session.maxMode;
      writeCache({ maxMode: session.maxMode });
    }
    drawerOpen = false;
  }

  async function deleteSessionHandler(id: string) {
    await sessionStore.deleteSession(id);
    sessions = sessions.filter((s) => s.id !== id);
    if (id === activeSessionId) {
      if (sessions.length > 0) {
        await selectSession(sessions[0].id);
      } else {
        await newSession();
      }
    }
  }

  function startTimer() {
    thinkStart = Date.now();
    elapsed = 0;
    elapsedTimer = setInterval(() => { elapsed = Math.round((Date.now() - thinkStart) / 1000); }, 200);
  }

  function stopTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  $effect(() => {
    document.documentElement.lang = tr.htmlLang;
  });

  /** Restore the most recent session, or open an empty one. Split out of `onMount` because an async
   *  `onMount` callback may not return a cleanup function — Svelte only awaits it. */
  async function restoreLatestSession() {
    sessions = await sessionStore.getAllSessions();
    if (sessions.length > 0) {
      const latest = sessions[0];
      activeSessionId = latest.id;
      history = latest.messages.slice();
      nextId = 0;
      displayItems = buildDisplayItems(history);
      applySessionStats(latest);
      showWelcome = history.length === 0;
      if (latest.selectedMod !== undefined) {
        selectedMod = latest.selectedMod;
      }
      if (latest.maxMode !== undefined) {
        maxMode = latest.maxMode;
      }
    } else {
      await newSession();
    }
  }

  onMount(() => {
    // Before anything hits /v1: persist a ?token= if the operator supplied one.
    captureTokenFromUrl();
    // Not awaited: the round cap only feeds an indicator, so session restore must not wait on it.
    void fetchLimits()
      .then((limits) => {
        if (typeof limits?.maxConversationRounds === 'number') maxRounds = limits.maxConversationRounds;
        if (typeof limits?.maxContextTokens === 'number' && limits.maxContextTokens > 0) {
          maxContext = limits.maxContextTokens;
        }
      })
      // Marked loaded even on failure: an older backend has no `/v1/limits`, and leaving the gate
      // permanently disarmed there would drop the client-side check entirely. The fallback figures
      // are then the best available, and the server still enforces the real ones.
      .finally(() => {
        limitsLoaded = true;
      });
    void restoreLatestSession();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentSession();
      }
    };
    const onBeforeUnload = () => { saveCurrentSession(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  });

  function estimateHistoryTokens(): number {
    return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  let currentInputText = $state('');

  function handleInputChange(text: string) {
    currentInputText = text;
  }

  // Rounds consumed by this conversation. One user message = one round, which is exactly how the
  // server counts the replayed history (`ceil(nonSystemMessages / 2)`), so the indicator and the
  // 400 it prevents stay in step.
  let roundsUsed = $derived(history.filter((m) => m.role === 'user').length);

  let effectiveContextUsed = $derived(
    contextUsed > 0
      ? contextUsed + estimateTokens(currentInputText)
      : estimateHistoryTokens() + estimateTokens(currentInputText),
  );

  function handleToggleLang() {
    lang = toggleLang(lang);
  }

  function handleToggleTheme() {
    theme = toggleTheme(theme);
  }

  function handleToggleMenu() {
    drawerOpen = !drawerOpen;
  }

  async function handleModChange(mod: string) {
    await saveCurrentSession();
    selectedMod = mod;
    writeCache({ selectedMod: mod });
    history = [];
    contextUsed = 0;
    lastBreakdown = undefined;
    displayItems = [];
    showWelcome = true;
    activeSessionId = sessionStore.generateId();
    const emptySession: Session = {
      id: activeSessionId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      selectedMod: mod || undefined,
      maxMode: maxMode || undefined,
    };
    await sessionStore.saveSession(emptySession);
    sessions = [emptySession, ...sessions];
  }

  function handleMaxModeToggle() {
    maxMode = !maxMode;
    writeCache({ maxMode });
  }

  async function handleResetAll() {
    resetting = true;
    drawerOpen = false;
    await resetLocalState();
    window.location.reload();
  }

  function showToast(message: string) {
    clearTimeout(toastTimer);
    toast = { message, visible: true };
    toastTimer = setTimeout(() => { toast = { ...toast, visible: false }; }, 2000);
  }

  async function sendMessage(text: string) {
    await sendMessageInternal(text, false);
  }

  /**
   * End the running turn now. Whatever was generated stays on screen; the stream closes itself with
   * `stopReason: 'stopped'`, so there is nothing to tear down here.
   */
  async function stopTurn() {
    const id = serverTurnId;
    if (!id) return;
    try {
      await fetch('/v1/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ turnId: id }),
      });
    } catch {
      // The stream is the source of truth for how the turn ended — a failed stop just means it
      // keeps running, which the UI already shows.
    }
  }

  async function sendMessageInternal(text: string, isRetry: boolean, retryTurnId?: string) {
    if (!text || loading) return;

    // Every block this turn produces carries the same `turnId`. A retry re-runs an existing turn, so
    // it keeps that turn's id and its user bubble.
    const turnId = retryTurnId ?? newTurnId();

    // Where this turn's question sits in `history`. A retried turn may sit mid-conversation: the
    // request must end at its question — replaying later turns after it would ask the model to
    // answer a question that already has answers below it — and the new answer must go back in at
    // the same position, not at the end.
    let qIdx = -1;

    if (!isRetry) {
      // Round cap, checked client-side so the user gets a localized note instead of the server's
      // 400 body. A retry re-sends an existing round and is deliberately exempt.
      if (limitsLoaded && maxRounds > 0 && roundsUsed >= maxRounds) {
        showWelcome = false;
        displayItems.push({ type: 'message', role: 'error', content: tr.roundsOver(maxRounds), id: uid(), turnId });
        displayItems = displayItems;
        return;
      }

      const checkBase = contextUsed > 0 ? contextUsed : estimateHistoryTokens();
      if (checkBase + estimateTokens(text) >= maxContext) {
        showWelcome = false;
        displayItems.push({ type: 'message', role: 'error', content: tr.ctxOver, id: uid(), turnId });
        displayItems = displayItems;
        return;
      }

      loading = true;
      showWelcome = false;
      displayItems.push({ type: 'message', role: 'user', content: text, id: uid(), turnId });
      displayItems = displayItems;
      history.push({ role: 'user', content: text, turnId });
      qIdx = history.length - 1;
    } else {
      loading = true;
      qIdx = history.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (qIdx < 0) {
        // The question was rolled back out of `history` by an earlier failure — put it back.
        history.push({ role: 'user', content: text, turnId });
        qIdx = history.length - 1;
      }
    }

    thinking = true;
    startTimer();

    const t0 = performance.now();
    let firstChunkTime = 0;
    // The turn's blocks in arrival order. Persisted with the assistant message, so a reload replays
    // the same timeline instead of collapsing it back into one bubble. The answer text itself is
    // derived from these — there is deliberately no separate accumulator to drift out of sync.
    const segments: TurnSegment[] = [];
    // What the turn answered so far: the text blocks, joined the same way `handleCopyTurn` joins
    // them on screen — a tool call splits blocks, and gluing them back without a separator would
    // feed the model merged words and broken markdown on every later request.
    const answerText = () =>
      segments.flatMap((s) => (s.kind === 'text' && s.text.length > 0 ? [s.text] : [])).join('\n\n');
    // Fallback call ids for a backend too old to send `toolCallId`: minted once per opening event.
    // Never derive these from `displayItems.length` — pushing the card changes it.
    let toolSeq = 0;
    // Cursors into the block currently accumulating deltas. A tool call closes both, so the next
    // delta opens a fresh block below the tool card — that is the whole point of the rewrite.
    // Indices stay valid because blocks are only ever appended.
    let textIdx = -1;
    let textSeg: Extract<TurnSegment, { kind: 'text' }> | null = null;
    let reasonIdx = -1;
    let reasonSeg: Extract<TurnSegment, { kind: 'reasoning' }> | null = null;
    // Stats of this turn, attached to the assistant message at the end so they survive a reload.
    let turnStat: TurnStat | undefined;
    // Candidate-close events received so far; when all N have closed the judge phase begins.
    let closedCount = 0;
    // The revised answer, when the turn's self-check produced one. It replaces the streamed text in
    // `history` — see the `revision` branch — and stays null on every other turn.
    let revisionText: string | null = null;
    // Findings from the `reflection` event, held for the `revision` event that follows it: they belong
    // on the revision block, and the two events arrive separately.
    let pendingIssues: { code: string; detail?: string }[] = [];

    /** Shared side effects of the first block of any kind: TTFB, and swapping the indicator out. */
    const beginStreaming = () => {
      if (firstChunkTime === 0) firstChunkTime = performance.now();
      thinking = false;
      streaming = true;
    };

    const closeBlocks = () => {
      textIdx = -1;
      textSeg = null;
      reasonIdx = -1;
      reasonSeg = null;
      activeBlockId = null;
    };

    const render = () => {
      if (textIdx >= 0 && textSeg) {
        const it = displayItems[textIdx];
        if (it?.type === 'message') displayItems[textIdx] = { ...it, content: textSeg.text };
      }
      if (reasonIdx >= 0 && reasonSeg) {
        const it = displayItems[reasonIdx];
        if (it?.type === 'reasoning') displayItems[reasonIdx] = { ...it, text: reasonSeg.text };
      }
      displayItems = displayItems;
    };

    // Rendering is what makes a backgrounded tab dangerous: every delta re-renders the whole markdown
    // answer, and a hidden tab's main thread is throttled hard enough that `reader.read()` stops
    // draining the response. The HTTP/2 flow-control window then fills, the CDN in front can no longer
    // write to the client, and it kills the stream as a stalled origin (EdgeOne's HTTP response
    // timeout is 15s) — that is what surfaced as ERR_HTTP2_PROTOCOL_ERROR on returning to the tab.
    // rAF callbacks never run while hidden, so this coalesces into one repaint on return while the
    // read loop keeps draining in the meantime.
    let rafPending = false;
    const paint = () => {
      if (!document.hidden) {
        render();
        return;
      }
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render();
      });
    };

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(activeSessionId ? { 'x-session-id': activeSessionId } : {}),
          ...authHeaders(),
        },
        body: JSON.stringify({
          model: 'rwr-agent',
          // `stats` is client-side only — strip it before the wire. A retry sends the conversation
          // only up to its own question: the old answer and every later turn stay out of the request.
          messages: history.slice(0, qIdx + 1).map(({ role, content }) => ({ role, content })),
          ...(selectedMod ? { mod: selectedMod } : {}),
          ...(maxMode ? { mode: 'max' } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'turn-start') {
              // First frame of the stream. Until it lands there is nothing to stop.
              serverTurnId = typeof event.turnId === 'string' ? event.turnId : null;
            } else if (event.type === 'steer-applied') {
              // This composer never steers — it only stops. But `POST /v1/chat/steer` is a public
              // side channel any client (or a curl) can hit against a turn id, so the frame is still
              // rendered rather than silently dropped: a redirected answer that showed no reason for
              // changing course would read as the model losing the thread.
              // Its own timeline block, so the text above it stays readable as "what the model
              // thought before being redirected".
              displayItems.push({
                type: 'meta',
                text: tr.steerApplied(String(event.message ?? '')),
                id: uid(),
                turnId,
              });
              displayItems = displayItems;
            } else if (event.type === 'reasoning-delta') {
              const r = event.textDelta ?? '';
              if (r) {
                if (reasonIdx < 0) {
                  beginStreaming();
                  // Same reason as the tool-step branch: deltas deferred by a hidden tab live only
                  // in the cursors, so flush them into the text block before releasing it.
                  render();
                  textIdx = -1;
                  textSeg = null;
                  const seg: Extract<TurnSegment, { kind: 'reasoning' }> = { kind: 'reasoning', text: '' };
                  segments.push(seg);
                  reasonSeg = seg;
                  const id = uid();
                  displayItems.push({ type: 'reasoning', text: '', id, turnId });
                  reasonIdx = displayItems.length - 1;
                  activeBlockId = id;
                  displayItems = displayItems;
                }
                if (reasonSeg) reasonSeg.text += r;
                paint();
              }
            } else if (event.type === 'text-delta') {
              const content = event.textDelta ?? '';
              if (content) {
                if (textIdx < 0) {
                  beginStreaming();
                  // Same reason as above, in the other direction: flush the reasoning block before
                  // its cursor goes.
                  render();
                  reasonIdx = -1;
                  reasonSeg = null;
                  const seg: Extract<TurnSegment, { kind: 'text' }> = { kind: 'text', text: '' };
                  segments.push(seg);
                  textSeg = seg;
                  const id = uid();
                  displayItems.push({ type: 'message', role: 'ai', content: '', id, turnId });
                  textIdx = displayItems.length - 1;
                  activeBlockId = id;
                  displayItems = displayItems;
                }
                if (textSeg) textSeg.text += content;
                paint();
              }
            } else if (event.type === 'tool-step') {
              // A tool call is its own block, and it closes whatever text/reasoning block came
              // before it \u2014 so what the model writes after the result opens a *new* block below the
              // card. That is what keeps the rendered order equal to the real timeline.
              // `ok` is absent on the opening event and false when the tool returned an error: a
              // failed call must still close its card, otherwise it reads as still running.
              if (!event.done) {
                beginStreaming();
                // Deltas deferred by a hidden tab live only in the cursors \u2014 flush them into the
                // block before dropping it, or it stays an empty bubble for the whole session.
                render();
                closeBlocks();
                const callId: string = event.toolCallId ?? `${turnId}-call-${toolSeq++}`;
                const toolName: string = event.toolName ?? 'tool';
                segments.push({ kind: 'tool', callId, toolName, input: event.summary });
                displayItems.push({ type: 'tool-call', callId, toolName, input: event.summary, id: uid(), turnId });
                displayItems = displayItems;
              } else {
                const ok: boolean = event.ok !== false;
                // `toolCallId` pairs the closing event with its opening card. Without it (a backend
                // old enough not to send it) the pair is this turn's still-open card: calls never
                // overlap within a turn there, and a recomputed fallback id could never match the
                // opening one anyway.
                const idx = displayItems.findLastIndex(
                  (it) => it.type === 'tool-call' && it.ok === undefined &&
                    (event.toolCallId ? it.callId === event.toolCallId : it.turnId === turnId),
                );
                const card = idx >= 0 ? displayItems[idx] : undefined;
                const closing = { ok, durationMs: event.durationMs as number | undefined, output: event.summary as string | undefined };
                let callId: string;
                if (card?.type === 'tool-call') {
                  callId = card.callId;
                  displayItems[idx] = { ...card, ...closing };
                } else {
                  // Nothing open to close: the opening event never arrived. Render the outcome
                  // rather than dropping the call.
                  callId = event.toolCallId ?? `${turnId}-call-${toolSeq++}`;
                  displayItems.push({ type: 'tool-call', callId, toolName: event.toolName ?? 'tool', ...closing, id: uid(), turnId });
                }
                const seg = segments.findLast((s) => s.kind === 'tool' && s.callId === callId);
                if (seg?.kind === 'tool') {
                  Object.assign(seg, closing);
                } else {
                  segments.push({ kind: 'tool', callId, toolName: event.toolName ?? 'tool', ...closing });
                }
                displayItems = displayItems;
              }
            } else if (event.type === 'candidate-open') {
              // Start a live trace per candidate; tool steps arrive as `candidate-step`.
              maxModeTotal = event.total ?? 0;
              judgePhase = false;
              displayItems.push({
                type: 'candidate-trace',
                candidate: event.candidate ?? 0,
                total: maxModeTotal,
                steps: [],
                id: uid(),
                turnId,
              });
              displayItems = displayItems;
            } else if (event.type === 'candidate-step') {
              const c = event.candidate;
              const idx = displayItems.findIndex(
                (it) => it.type === 'candidate-trace' && it.candidate === c,
              );
              if (idx >= 0 && displayItems[idx]?.type === 'candidate-trace') {
                const step = {
                  text: event.summary ?? event.toolName ?? 'tool',
                  ok: event.done ? event.ok !== false : undefined,
                  durationMs: event.durationMs,
                  candidate: c,
                };
                displayItems[idx].steps.push(step);
                displayItems = [...displayItems];
              }
            } else if (event.type === 'candidate-close') {
              const idx = displayItems.findIndex(
                (it) => it.type === 'candidate-trace' && it.candidate === event.candidate,
              );
              if (idx >= 0 && displayItems[idx]?.type === 'candidate-trace') {
                displayItems[idx] = {
                  ...displayItems[idx],
                  done: true,
                  ok: event.ok === true,
                };
                displayItems = [...displayItems];
              }
              closedCount++;
              if (maxModeTotal > 0 && closedCount >= maxModeTotal) {
                judgePhase = true;
              }
            } else if (event.type === 'candidates') {
              // All drafts are in: drop the live traces, show the collapsible raw-drafts panel.
              // Filtering re-indexes the array, so flush any deferred deltas and drop the cursors
              // first — they are positional and would point at the wrong block afterwards.
              render();
              closeBlocks();
              const traceIds = new Set(
                displayItems.filter((it) => it.type === 'candidate-trace').map((it) => it.id),
              );
              displayItems = displayItems.filter((it) => !traceIds.has(it.id));
              displayItems.push({
                type: 'candidate-panel',
                candidates: (event.list ?? []) as CandidateView[],
                kind: event.kind,
                id: uid(),
                turnId,
              });
              displayItems = displayItems;
              maxModeTotal = 0;
              judgePhase = false;
            } else if (event.type === 'reflection') {
              // The self-check's outcome, after the answer and before `finish`. A clean check is a
              // one-line badge; a check that found something renders as the revision block that
              // follows, so its findings are carried there instead of shown twice.
              render();
              closeBlocks();
              const issues = (event.issues ?? []) as { code: string; detail?: string }[];
              segments.push({ kind: 'reflection', verdict: event.verdict, issues });
              if (event.verdict === 'pass') {
                displayItems.push({ type: 'reflection', verdict: 'pass', id: uid(), turnId });
              } else {
                pendingIssues = issues;
              }
              displayItems = displayItems;
            } else if (event.type === 'revision') {
              // The revised answer, whole. The streamed original stays on screen above it — the
              // timeline is what actually happened — but this is the version `history` carries, so the
              // next request is not built on an answer the server itself flagged.
              render();
              closeBlocks();
              revisionText = event.text as string;
              segments.push({ kind: 'revision', text: revisionText, issues: pendingIssues });
              displayItems.push({ type: 'revision', text: revisionText, issues: pendingIssues, id: uid(), turnId });
              displayItems = displayItems;
            } else if (event.type === 'finish') {
              // The turn is over: nothing is accumulating any more, so the caret stops blinking on
              // whatever block was last. Flush deferred deltas first — dropping the cursors is what
              // would otherwise turn the final render() below into a no-op on a hidden tab.
              render();
              closeBlocks();
              const usage = event.usage;
              if (usage) {
                // `contextTokens` is what the *next* request will carry: the base prompt plus the
                // conversation, with this turn's tool transcript excluded — the transcript is never
                // sent again. It can legitimately shrink (fewer retrieved docs on the next turn), so
                // it must not be clamped to a high-water mark: doing so would keep an overstated
                // value forever and eventually trip the send gate below with room still left.
                // promptTokens/completionTokens are cumulative *spend* across steps, not occupancy.
                if (usage.maxContextTokens) maxContext = usage.maxContextTokens;
                contextUsed = Math.max(usage.contextTokens ?? contextUsed, estimateHistoryTokens());
              }
              const totalTime = Math.round(performance.now() - t0);
              const ttfb = firstChunkTime > 0 ? Math.round(firstChunkTime - t0) : '-';
              // Backend falls back to a char-based estimate when the provider omits usage; mark estimates with "~".
              const est = usage?.estimated === true;
              const inTokens = usage?.promptTokens != null ? (est ? `~${usage.promptTokens}` : usage.promptTokens) : '-';
              const outTokens = usage?.completionTokens != null ? (est ? `~${usage.completionTokens}` : usage.completionTokens) : '-';
              turnStat = {
                ttfb,
                total: totalTime,
                inTokens,
                outTokens,
                steps: usage?.breakdown?.steps,
                contextTokens: usage?.contextTokens ?? undefined,
                maxContextTokens: usage?.maxContextTokens ?? undefined,
                breakdown: usage?.breakdown ?? undefined,
              };
              if (usage?.breakdown) lastBreakdown = usage.breakdown;
              displayItems.push({ type: 'meta', text: tr.metaFormat(ttfb, totalTime, inTokens, outTokens, usage?.breakdown?.steps), id: uid(), turnId });
              // Why the loop ended, when it was not a clean finish. The backend reports the reason,
              // not the wording, so it can be shown in the user's language.
              const stopNote = event.stopReason === 'step-limit' ? tr.stopStepLimit
                : event.stopReason === 'output-limit' ? tr.stopOutputLimit
                : event.stopReason === 'stopped' ? tr.stopStopped
                : null;
              if (stopNote) displayItems.push({ type: 'meta', text: stopNote, id: uid(), turnId });
              displayItems = displayItems;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      thinking = false;
      streaming = false;
      stopTimer();
      maxModeTotal = 0;
      judgePhase = false;
      // A turn that already streamed part of an answer keeps its user message: the partial reply is
      // pushed onto `history` below, and dropping the question would leave two assistant turns in a
      // row — a malformed history that the next request replays to the model.
      if (answerText()) {
        displayItems.push({ type: 'meta', text: tr.streamInterrupted, id: uid(), turnId });
      } else {
        // Blocks appear as soon as *any* delta arrives, reasoning and tool calls included, so a break
        // that produced no answer text still leaves blocks with no matching `history` turn. Retrying
        // from them would delete the *previous* turn's assistant message and re-send a history
        // missing this question, so every assistant-side block of this turn goes with the rollback.
        // The user bubble stays: the question is still on screen, just no longer in `history`.
        displayItems = stripTurnBlocks(displayItems, turnId);
        closeBlocks();
        if (!isRetry) {
          history.pop();
        } else {
          // A failed retry keeps the old answer in `history` (it is only replaced on success below)
          // — put its blocks back on screen too, so the turn keeps its action bar and stays
          // retryable instead of ending as an orphaned question.
          const old = history.find((m) => m.turnId === turnId && m.role === 'assistant');
          if (old) displayItems.push(...messageItems(old, turnId));
        }
        const errorMsg = (err.message?.includes('Failed to fetch') ? tr.netError : tr.reqFailed) + (err.message ?? '');
        displayItems.push({ type: 'message', role: 'error', content: errorMsg, id: uid(), turnId });
      }
      displayItems = displayItems;
      if (isRetry) {
        showToast(tr.retryFailed);
      }
    }

    thinking = false;
    streaming = false;
    stopTimer();
    maxModeTotal = 0;
    judgePhase = false;
    // The turn is over on the server too, so steer/stop would 404 from here on.
    serverTurnId = null;
    // Final state goes in even while hidden: `paint()` may have deferred the last deltas to a rAF
    // that will not fire until the tab comes back, and the turn is over — one render, not per-delta.
    render();
    closeBlocks();

    // The revision wins when the turn produced one: the server flagged the streamed answer, and every
    // later request — including the summarizer's view of this conversation — replays `content`. Both
    // versions stay on screen, but only one can be the answer the model builds on. A `step-limit` turn
    // streamed nothing at all, so this is also what lets a rebuilt answer reach storage.
    const content = revisionText ?? answerText();
    if (content) {
      // A tool call that ended the turn leaves an empty trailing text block behind; it would restore
      // as an empty bubble, so it never reaches storage. Only text/reasoning blocks can be empty —
      // the rest carry no `text` to measure.
      const kept = segments.filter((s) =>
        s.kind === 'text' || s.kind === 'reasoning' ? s.text.length > 0 : true,
      );
      // A call whose closing event never arrived (stream broke mid-call) must not restore as
      // "running" — `ok` is what closes the card, and nothing can ever close it after a reload.
      for (const s of kept) {
        if (s.kind === 'tool' && s.ok === undefined) s.ok = false;
      }
      const msg: Message = { role: 'assistant', content, stats: turnStat, segments: kept, turnId };
      // A retried turn's answer replaces the old one *in place* — appending it would put the turn's
      // answer after later turns' messages, a non-alternating history the model chokes on.
      const oldIdx = history.findIndex((m) => m.turnId === turnId && m.role === 'assistant');
      if (oldIdx >= 0) history.splice(oldIdx, 1, msg);
      else if (isRetry) history.splice(qIdx + 1, 0, msg);
      else history.push(msg);
    }
    loading = false;
    saveCurrentSession();
  }

  function handleAsk(q: string) {
    sendMessage(q);
  }

  /** Re-run a turn: its assistant-side blocks go, the question stays and is sent again. */
  async function handleRetry(turnId: string) {
    if (loading) return;

    const userItem = displayItems.find(
      (it) => it.type === 'message' && it.role === 'user' && it.turnId === turnId,
    );
    const userContent = userItem?.type === 'message' ? userItem.content : '';
    if (!userContent) return;

    // Everything the assistant produced for this turn — text blocks, reasoning, tool cards, meta.
    // The old answer stays in `history` until the retry actually produces a replacement: the
    // request never includes it (it is sliced off at the question), and keeping it is what lets a
    // failed retry restore the turn instead of leaving an orphaned question.
    displayItems = stripTurnBlocks(displayItems, turnId);

    contextUsed = 0;
    lastBreakdown = undefined;
    await sendMessageInternal(userContent, true, turnId);
  }

  function handleRecall(turnId: string) {
    if (loading) return;
    pendingRecallTurnId = turnId;
  }

  function confirmRecall() {
    if (!pendingRecallTurnId) return;
    const turnId = pendingRecallTurnId;

    const idx = displayItems.findIndex((it) => it.turnId === turnId);
    if (idx < 0) { pendingRecallTurnId = null; return; }

    const item = displayItems[idx];
    const recalledContent = item.type === 'message' ? item.content : '';

    const removed = displayItems.slice(idx);
    displayItems = displayItems.slice(0, idx);

    // Truncate `history` by turn rather than rebuilding it from `displayItems`: one turn is now many
    // display items, and folding them back would turn a single answer into several assistant
    // messages. Keyed on the *removed turns* rather than sliced at the clicked one — a turn rolled
    // back by an error is not in `history` at all, and slicing at it would silently keep every
    // later turn as invisible context the user believes was rewound.
    const removedTurnIds = new Set(removed.map((it) => it.turnId));
    history = history.filter((m) => !m.turnId || !removedTurnIds.has(m.turnId));

    contextUsed = 0;
    lastBreakdown = undefined;
    prefillText = recalledContent;

    if (displayItems.length === 0) {
      showWelcome = true;
    }

    pendingRecallTurnId = null;
    saveCurrentSession();
  }

  function cancelRecall() {
    pendingRecallTurnId = null;
  }

  function writeClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(tr.copied);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(tr.copied);
    });
  }

  /** Single bubble — user questions and error notices, which are plain text either way. */
  function handleCopy(messageId: string) {
    const item = displayItems.find(it => it.id === messageId);
    if (!item || item.type !== 'message') return;
    writeClipboard(item.content);
  }

  /**
   * A whole answer: every text block of the turn, joined. Tool cards and reasoning stay out.
   *
   * A revised turn copies the revision alone — it is the version `history` carries, so copying the
   * superseded text (or both) would hand out something the conversation itself no longer stands on.
   */
  function handleCopyTurn(turnId: string, format: 'text' | 'markdown') {
    const revision = displayItems.find((it) => it.type === 'revision' && it.turnId === turnId);
    const text =
      revision?.type === 'revision'
        ? revision.text
        : displayItems
            .filter((it) => it.type === 'message' && it.role === 'ai' && it.turnId === turnId)
            .map((it) => (it.type === 'message' ? it.content : ''))
            .join('\n\n');
    if (!text) return;
    writeClipboard(format === 'markdown' ? text : stripMarkdown(text));
  }

  function handlePrefillConsumed() {
    prefillText = '';
  }
</script>

<div class="flex flex-col h-dvh overflow-hidden bg-base-100 text-base-content">
  <Header {lang} {tr} {selectedMod} {theme} onmodchange={handleModChange} ontogglelang={handleToggleLang} ontoggletheme={handleToggleTheme} ontogglemenu={handleToggleMenu} />
  {#if showWelcome}
    <Welcome {tr} onask={handleAsk} />
  {:else}
    <Chat
      items={displayItems}
      {thinking}
      {streaming}
      thinkingText={maxModeTotal > 0 ? tr.runningCandidates(maxModeTotal) : judgePhase ? tr.synthesizing : tr.thinking}
      searchingText={tr.searching}
      generatingText={tr.generating}
      {elapsed}
      {pendingRecallTurnId}
      {activeBlockId}
      {tr}
      onretry={handleRetry}
      onrecall={handleRecall}
      oncopy={handleCopy}
      oncopyturn={handleCopyTurn}
      onconfirmrecall={confirmRecall}
      oncancelrecall={cancelRecall}
      {loading}
    />
  {/if}
  <InputArea
    {tr}
    {loading}
    contextUsed={effectiveContextUsed}
    maxContext={maxContext}
    {roundsUsed}
    maxRounds={limitsLoaded ? maxRounds : 0}
    breakdown={lastBreakdown}
    {maxMode}
    onmaxtoggle={handleMaxModeToggle}
    onsend={sendMessage}
    oninputchange={handleInputChange}
    {prefillText}
    onprefillconsumed={handlePrefillConsumed}
    stoppable={serverTurnId !== null}
    onstop={stopTurn}
  />

  <SessionDrawer
    open={drawerOpen}
    {sessions}
    {activeSessionId}
    {tr}
    onselect={selectSession}
    onnew={newSession}
    ondelete={deleteSessionHandler}
    onreset={handleResetAll}
    onclose={() => { drawerOpen = false; }}
  />

  {#if toast.visible}
    <div class="fixed bottom-24 left-1/2 -translate-x-1/2 bg-base-200 border border-base-300 px-5 py-2 rounded-box text-sm text-base-content z-50 shadow-elevation-2 animate-fade-in">
      {toast.message}
    </div>
  {/if}
</div>
