<script lang="ts">
  import { onMount } from 'svelte';
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import type { Theme } from './lib/theme.js';
  import { getInitialTheme, toggleTheme } from './lib/theme.js';
  import type { Message, DisplayItem, Session, TokenBreakdown, CandidateView, TurnStat } from './lib/types.js';
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
  let pendingRecallId: string | null = $state(null);
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

  function buildDisplayItems(msgs: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const m of msgs) {
      items.push({
        type: 'message' as const,
        role: (m.role === 'assistant' ? 'ai' : m.role) as 'user' | 'ai',
        content: m.content,
        id: uid(),
      });
      // Restored turns re-render their meta line (TTFB / total / tokens / steps) from the stats
      // attached to the assistant message, so a reload does not lose the per-turn numbers.
      if (m.role === 'assistant' && m.stats) {
        items.push({
          type: 'meta',
          text: tr.metaFormat(m.stats.ttfb, m.stats.total, m.stats.inTokens, m.stats.outTokens, m.stats.steps),
          id: uid(),
        });
      }
    }
    return items;
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

  async function sendMessageInternal(text: string, isRetry: boolean) {
    if (!text || loading) return;

    if (!isRetry) {
      // Round cap, checked client-side so the user gets a localized note instead of the server's
      // 400 body. A retry re-sends an existing round and is deliberately exempt.
      if (limitsLoaded && maxRounds > 0 && roundsUsed >= maxRounds) {
        showWelcome = false;
        displayItems.push({ type: 'message', role: 'error', content: tr.roundsOver(maxRounds), id: uid() });
        displayItems = displayItems;
        return;
      }

      const checkBase = contextUsed > 0 ? contextUsed : estimateHistoryTokens();
      if (checkBase + estimateTokens(text) >= maxContext) {
        showWelcome = false;
        displayItems.push({ type: 'message', role: 'error', content: tr.ctxOver, id: uid() });
        displayItems = displayItems;
        return;
      }

      loading = true;
      showWelcome = false;
      displayItems.push({ type: 'message', role: 'user', content: text, id: uid() });
      displayItems = displayItems;
      history.push({ role: 'user', content: text });
    } else {
      loading = true;
    }

    thinking = true;
    startTimer();

    const t0 = performance.now();
    let firstChunkTime = 0;
    let fullContent = '';
    let fullReasoning = '';
    let aiItemIdx = -1;
    let currentTraceIdx = -1;
    // Stats of this turn, attached to the assistant message at the end so they survive a reload.
    let turnStat: TurnStat | undefined;
    // Candidate-close events received so far; when all N have closed the judge phase begins.
    let closedCount = 0;

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
          // `stats` is client-side only — strip it before the wire.
          messages: history.map(({ role, content }) => ({ role, content })),
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
            if (event.type === 'reasoning-delta') {
              const r = event.textDelta ?? '';
              if (r) {
                if (firstChunkTime === 0) {
                  firstChunkTime = performance.now();
                  thinking = false;
                  streaming = true;
                  displayItems.push({ type: 'message', role: 'ai', content: '', id: uid() });
                  aiItemIdx = displayItems.length - 1;
                  displayItems = displayItems;
                }
                fullReasoning += r;
                if (aiItemIdx >= 0) {
                  displayItems[aiItemIdx] = { ...displayItems[aiItemIdx], type: 'message', role: 'ai', content: fullContent, reasoning: fullReasoning };
                  displayItems = displayItems;
                }
              }
            } else if (event.type === 'text-delta') {
              const content = event.textDelta ?? '';
              if (content) {
                if (aiItemIdx < 0) {
                  if (firstChunkTime === 0) firstChunkTime = performance.now();
                  thinking = false;
                  streaming = true;
                  displayItems.push({ type: 'message', role: 'ai', content: '', id: uid() });
                  aiItemIdx = displayItems.length - 1;
                  displayItems = displayItems;
                }                fullContent += content;
                if (aiItemIdx >= 0) {
                  displayItems[aiItemIdx] = { ...displayItems[aiItemIdx], type: 'message', role: 'ai', content: fullContent, reasoning: fullReasoning || undefined };
                  displayItems = displayItems;
                }
              }
            } else if (event.type === 'tool-step') {
              // `ok` is absent on the opening step and false when the tool returned an error \u2014 a
              // failed call must still close its line, otherwise it reads as still running.
              const failed = event.done && event.ok === false;
              const icon = !event.done ? '\uD83D\uDD27' : failed ? '\u2715' : '\u2713';
              const text = event.summary ?? event.toolName ?? 'tool';
              const step = { icon, text, ok: event.done ? event.ok !== false : undefined, durationMs: event.durationMs };
              // Bound to a local so the `type === 'tool-trace'` check narrows the push below —
              // re-indexing the array would throw the narrowing away.
              const trace = currentTraceIdx >= 0 ? displayItems[currentTraceIdx] : undefined;
              if (trace?.type === 'tool-trace') {
                trace.steps.push(step);
                displayItems = [...displayItems];
              } else {
                displayItems.push({ type: 'tool-trace', steps: [step], id: uid() });
                currentTraceIdx = displayItems.length - 1;
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
              });
              displayItems = displayItems;
            } else if (event.type === 'candidate-step') {
              const c = event.candidate;
              const idx = displayItems.findIndex(
                (it) => it.type === 'candidate-trace' && it.candidate === c,
              );
              if (idx >= 0 && displayItems[idx]?.type === 'candidate-trace') {
                const failed = event.done && event.ok === false;
                const icon = !event.done ? '\uD83D\uDD27' : failed ? '\u2715' : '\u2713';
                const step = {
                  icon,
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
              const traceIds = new Set(
                displayItems.filter((it) => it.type === 'candidate-trace').map((it) => it.id),
              );
              displayItems = displayItems.filter((it) => !traceIds.has(it.id));
              displayItems.push({
                type: 'candidate-panel',
                candidates: (event.list ?? []) as CandidateView[],
                kind: event.kind,
                id: uid(),
              });
              displayItems = displayItems;
              maxModeTotal = 0;
              judgePhase = false;
            } else if (event.type === 'finish') {
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
              displayItems.push({ type: 'meta', text: tr.metaFormat(ttfb, totalTime, inTokens, outTokens, usage?.breakdown?.steps), id: uid() });
              // Why the loop ended, when it was not a clean finish. The backend reports the reason,
              // not the wording, so it can be shown in the user's language.
              const stopNote = event.stopReason === 'step-limit' ? tr.stopStepLimit
                : event.stopReason === 'output-limit' ? tr.stopOutputLimit
                : null;
              if (stopNote) displayItems.push({ type: 'meta', text: stopNote, id: uid() });
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
      if (!isRetry) {
        history.pop();
      }
      const errorMsg = (err.message?.includes('Failed to fetch') ? tr.netError : tr.reqFailed) + (err.message ?? '');
      displayItems.push({ type: 'message', role: 'error', content: errorMsg, id: uid() });
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

    if (fullContent) {
      history.push({ role: 'assistant', content: fullContent, stats: turnStat });
    }
    loading = false;
    saveCurrentSession();
  }

  function handleAsk(q: string) {
    sendMessage(q);
  }

  async function handleRetry(aiMessageId: string) {
    if (loading) return;

    const aiIdx = displayItems.findIndex(it => it.id === aiMessageId);
    if (aiIdx < 0) return;

    let userContent = '';
    for (let i = aiIdx - 1; i >= 0; i--) {
      const item = displayItems[i];
      if (item.type === 'message' && item.role === 'user') {
        userContent = item.content;
        break;
      }
    }
    if (!userContent) return;

    let removeEnd = aiIdx + 1;
    while (removeEnd < displayItems.length && displayItems[removeEnd].type === 'meta') {
      removeEnd++;
    }
    displayItems.splice(aiIdx, removeEnd - aiIdx);
    displayItems = displayItems;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        history.splice(i, 1);
        break;
      }
    }
    history = history;

    contextUsed = 0;
    lastBreakdown = undefined;
    await sendMessageInternal(userContent, true);
  }

  function handleRecall(userMessageId: string) {
    if (loading) return;
    pendingRecallId = userMessageId;
  }

  function confirmRecall() {
    if (!pendingRecallId) return;

    const idx = displayItems.findIndex(it => it.id === pendingRecallId);
    if (idx < 0) { pendingRecallId = null; return; }

    const item = displayItems[idx];
    const recalledContent = item.type === 'message' ? item.content : '';

    displayItems.splice(idx);
    displayItems = displayItems;

    history = displayItems
      .filter((it): it is DisplayItem & { type: 'message' } => it.type === 'message' && (it.role === 'user' || it.role === 'ai'))
      .map(it => ({
        role: it.role === 'ai' ? 'assistant' : it.role,
        content: it.content,
      }));

    contextUsed = 0;
    lastBreakdown = undefined;
    prefillText = recalledContent;

    if (displayItems.length === 0) {
      showWelcome = true;
    }

    pendingRecallId = null;
    saveCurrentSession();
  }

  function cancelRecall() {
    pendingRecallId = null;
  }

  function handleCopy(messageId: string, format: 'text' | 'markdown') {
    const item = displayItems.find(it => it.id === messageId);
    if (!item || item.type !== 'message') return;

    let text: string;
    if (format === 'markdown') {
      text = item.content;
    } else {
      text = item.role === 'ai' ? stripMarkdown(item.content) : item.content;
    }

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
      {pendingRecallId}
      {tr}
      onretry={handleRetry}
      onrecall={handleRecall}
      oncopy={handleCopy}
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
    <div class="fixed bottom-24 left-1/2 -translate-x-1/2 bg-base-200 border border-base-300 px-5 py-2 rounded-lg text-sm text-base-content z-50 shadow-lg animate-fade-in">
      {toast.message}
    </div>
  {/if}
</div>
