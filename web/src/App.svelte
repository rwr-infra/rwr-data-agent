<script lang="ts">
  import { onMount } from 'svelte';
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import type { Theme } from './lib/theme.js';
  import { getInitialTheme, toggleTheme } from './lib/theme.js';
  import type { Message, DisplayItem, Session } from './lib/types.js';
  import { stripMarkdown } from './lib/utils.js';
  import * as sessionStore from './lib/sessionStore.js';
  import Header from './components/Header.svelte';
  import Chat from './components/Chat.svelte';
  import Welcome from './components/Welcome.svelte';
  import InputArea from './components/InputArea.svelte';
  import SessionDrawer from './components/SessionDrawer.svelte';

  const LOCAL_CACHE_KEY = 'rwr-data-agent-cache';
  type LocalCache = { selectedTable?: string };
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
  let selectedTable = $state(readCache().selectedTable ?? '');
  let contextUsed = $state(0);
  const MAX_CONTEXT = 200000;
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

  let nextId = 0;
  function uid(): string { return `m${nextId++}`; }

  function buildDisplayItems(msgs: Message[]): DisplayItem[] {
    return msgs.map((m) => ({
      type: 'message' as const,
      role: (m.role === 'assistant' ? 'ai' : m.role) as 'user' | 'ai',
      content: m.content,
      id: uid(),
    }));
  }

  async function saveCurrentSession() {
    if (!activeSessionId) return;
    const plainMessages: Message[] = JSON.parse(JSON.stringify(history));
    if (plainMessages.length === 0) return;
    const session: Session = {
      id: activeSessionId,
      title: sessionStore.generateTitle(plainMessages),
      createdAt: sessions.find((s) => s.id === activeSessionId)?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages: plainMessages,
      selectedTable: selectedTable || undefined,
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
    showWelcome = true;
    drawerOpen = false;
    const emptySession: Session = {
      id: newId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      selectedTable: selectedTable || undefined,
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
    contextUsed = 0;
    showWelcome = history.length === 0;
    if (session.selectedTable !== undefined) {
      selectedTable = session.selectedTable;
      writeCache({ selectedTable: session.selectedTable });
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

  onMount(async () => {
    sessions = await sessionStore.getAllSessions();
    if (sessions.length > 0) {
      const latest = sessions[0];
      activeSessionId = latest.id;
      history = latest.messages.slice();
      nextId = 0;
      displayItems = buildDisplayItems(history);
      showWelcome = history.length === 0;
      if (latest.selectedTable !== undefined) {
        selectedTable = latest.selectedTable;
      }
    } else {
      await newSession();
    }

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

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 1.5);
  }

  function estimateHistoryTokens(): number {
    return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  let currentInputText = $state('');

  function handleInputChange(text: string) {
    currentInputText = text;
  }

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

  async function handleTableChange(table: string) {
    await saveCurrentSession();
    selectedTable = table;
    writeCache({ selectedTable: table });
    history = [];
    contextUsed = 0;
    displayItems = [];
    showWelcome = true;
    activeSessionId = sessionStore.generateId();
    const emptySession: Session = {
      id: activeSessionId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      selectedTable: table || undefined,
    };
    await sessionStore.saveSession(emptySession);
    sessions = [emptySession, ...sessions];
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
      const checkBase = contextUsed > 0 ? contextUsed : estimateHistoryTokens();
      if (checkBase + estimateTokens(text) >= MAX_CONTEXT) {
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
    let aiItemIdx = -1;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'rwr-agent',
          messages: history.slice(),
          ...(selectedTable ? { table: selectedTable } : {}),
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
            if (event.type === 'text-delta') {
              const content = event.textDelta ?? '';
              if (content) {
                if (firstChunkTime === 0) {
                  firstChunkTime = performance.now();
                  thinking = false;
                  streaming = true;
                  displayItems.push({ type: 'message', role: 'ai', content: '', id: uid() });
                  aiItemIdx = displayItems.length - 1;
                  displayItems = displayItems;
                }
                fullContent += content;
                if (aiItemIdx >= 0) {
                  displayItems[aiItemIdx] = { ...displayItems[aiItemIdx], type: 'message', role: 'ai', content: fullContent };
                  displayItems = displayItems;
                }
              }
            } else if (event.type === 'finish') {
              const usage = event.usage;
              if (usage) {
                const reportedTotal = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
                contextUsed = Math.max(contextUsed, reportedTotal, estimateHistoryTokens());
              }
              const totalTime = Math.round(performance.now() - t0);
              const ttfb = firstChunkTime > 0 ? Math.round(firstChunkTime - t0) : '-';
              const inTokens = usage?.promptTokens ?? '-';
              const outTokens = usage?.completionTokens ?? '-';
              displayItems.push({ type: 'meta', text: tr.metaFormat(ttfb, totalTime, inTokens, outTokens), id: uid() });
              displayItems = displayItems;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      thinking = false;
      streaming = false;
      stopTimer();
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

    if (fullContent) {
      history.push({ role: 'assistant', content: fullContent });
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

<div class="flex flex-col h-screen bg-base-100 text-base-content">
  <Header {lang} {tr} {selectedTable} {theme} ontablechange={handleTableChange} ontogglelang={handleToggleLang} ontoggletheme={handleToggleTheme} ontogglemenu={handleToggleMenu} />
  {#if showWelcome}
    <Welcome {tr} onask={handleAsk} />
  {:else}
    <Chat
      items={displayItems}
      {thinking}
      {streaming}
      thinkingText={tr.thinking}
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
    maxContext={MAX_CONTEXT}
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
    onclose={() => { drawerOpen = false; }}
  />

  {#if toast.visible}
    <div class="fixed bottom-24 left-1/2 -translate-x-1/2 bg-base-200 border border-base-300 px-5 py-2 rounded-lg text-sm text-base-content z-50 shadow-lg animate-fade-in">
      {toast.message}
    </div>
  {/if}
</div>
