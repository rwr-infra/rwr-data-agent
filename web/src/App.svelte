<script lang="ts">
  import { onMount } from 'svelte';
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import type { Message } from './lib/types.js';
  import Header from './components/Header.svelte';
  import Chat from './components/Chat.svelte';
  import Welcome from './components/Welcome.svelte';
  import InputArea from './components/InputArea.svelte';

  type DisplayItem =
    | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string }
    | { type: 'meta'; text: string };

  let lang: Lang = $state(getInitialLang());
  let tr = $derived(t(lang));
  let history: Message[] = $state([]);
  let displayItems: DisplayItem[] = $state([]);
  let loading = $state(false);
  let thinking = $state(false);
  let streaming = $state(false);
  let showWelcome = $state(true);
  let selectedTable = $state('');
  let contextUsed = $state(0);
  const MAX_CONTEXT = 200000;

  let thinkStart = $state(0);
  let elapsed = $state(0);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

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

  function handleTableChange(table: string) {
    selectedTable = table;
    history = [];
    contextUsed = 0;
    displayItems = [];
    showWelcome = true;
  }

  async function sendMessage(text: string) {
    if (!text || loading) return;
    const checkBase = contextUsed > 0 ? contextUsed : estimateHistoryTokens();
    if (checkBase + estimateTokens(text) >= MAX_CONTEXT) {
      showWelcome = false;
      displayItems.push({ type: 'message', role: 'error', content: tr.ctxOver });
      displayItems = displayItems;
      return;
    }

    loading = true;
    showWelcome = false;
    displayItems.push({ type: 'message', role: 'user', content: text });
    displayItems = displayItems;
    history.push({ role: 'user', content: text });
    thinking = true;
    startTimer();

    const t0 = performance.now();
    let firstChunkTime = 0;
    let fullContent = '';
    let aiItemIdx = -1;
    let errorOccurred = false;

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
                  displayItems.push({ type: 'message', role: 'ai', content: '' });
                  aiItemIdx = displayItems.length - 1;
                  displayItems = displayItems;
                }
                fullContent += content;
                if (aiItemIdx >= 0) {
                  displayItems[aiItemIdx] = { type: 'message', role: 'ai', content: fullContent };
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
              displayItems.push({ type: 'meta', text: tr.metaFormat(ttfb, totalTime, inTokens, outTokens) });
              displayItems = displayItems;
              console.log(`[frontend] TTFB=${ttfb}ms total=${totalTime}ms in=${inTokens} out=${outTokens}`);
            }
          } catch {}
        }
      }
    } catch (err: any) {
      errorOccurred = true;
      thinking = false;
      streaming = false;
      stopTimer();
      history.pop();
      displayItems.push({
        type: 'message',
        role: 'error',
        content: (err.message?.includes('Failed to fetch') ? tr.netError : tr.reqFailed) + (err.message ?? ''),
      });
      displayItems = displayItems;
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
</script>

<Header {lang} {tr} {selectedTable} ontablechange={handleTableChange} ontogglelang={handleToggleLang} />
{#if showWelcome}
  <Welcome {tr} onask={handleAsk} />
{:else}
  <Chat items={displayItems} {thinking} {streaming} thinkingText={tr.thinking} searchingText={tr.searching} generatingText={tr.generating} {elapsed} />
{/if}
<InputArea {tr} {loading} contextUsed={effectiveContextUsed} maxContext={MAX_CONTEXT} onsend={sendMessage} oninputchange={handleInputChange} />
