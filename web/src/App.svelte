<script lang="ts">
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import type { Theme } from './lib/theme.js';
  import { getInitialTheme, toggleTheme } from './lib/theme.js';
  import type { Message, DisplayItem } from './lib/types.js';
  import { stripMarkdown } from './lib/utils.js';
  import Header from './components/Header.svelte';
  import Chat from './components/Chat.svelte';
  import Welcome from './components/Welcome.svelte';
  import InputArea from './components/InputArea.svelte';

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

  let nextId = 0;
  function uid(): string { return `m${nextId++}`; }

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

  function handleTableChange(table: string) {
    selectedTable = table;
    writeCache({ selectedTable: table });
    history = [];
    contextUsed = 0;
    displayItems = [];
    showWelcome = true;
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
  <Header {lang} {tr} {selectedTable} {theme} ontablechange={handleTableChange} ontogglelang={handleToggleLang} ontoggletheme={handleToggleTheme} />
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

  {#if toast.visible}
    <div class="fixed bottom-24 left-1/2 -translate-x-1/2 bg-base-200 border border-base-300 px-5 py-2 rounded-lg text-sm text-base-content z-50 shadow-lg animate-fade-in">
      {toast.message}
    </div>
  {/if}
</div>
