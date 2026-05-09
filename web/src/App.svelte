<script lang="ts">
  import type { Lang } from './lib/i18n.js';
  import { getInitialLang, t, toggleLang } from './lib/i18n.js';
  import { streamChat } from './lib/api.js';
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
  let showWelcome = $state(true);
  let selectedTable = $state('');
  let contextUsed = $state(0);
  const MAX_CONTEXT = 200000;

  $effect(() => {
    document.documentElement.lang = tr.htmlLang;
  });

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 1.5);
  }

  function estimateHistoryTokens(): number {
    return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  function computeContextUsed(inputText: string): number {
    const inputTokens = estimateTokens(inputText);
    const base = contextUsed > 0 ? contextUsed : estimateHistoryTokens();
    return base + inputTokens;
  }

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

  let currentInputText = $state('');

  function handleInputChange(text: string) {
    currentInputText = text;
  }

  let effectiveContextUsed = $derived(
    contextUsed > 0
      ? contextUsed + estimateTokens(currentInputText)
      : estimateHistoryTokens() + estimateTokens(currentInputText),
  );

  async function handleSend(text: string) {
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

    const t0 = performance.now();
    let firstChunkTime = 0;
    let usage: any = null;
    let fullContent = '';
    let aiItemIdx = -1;

    await streamChat(
      {
        model: 'rwr-agent',
        messages: history.slice(),
        stream: true,
        ...(selectedTable ? { table: selectedTable } : {}),
      },
      {
        onContent(content) {
          if (firstChunkTime === 0) {
            firstChunkTime = performance.now();
            thinking = false;
            displayItems.push({ type: 'message', role: 'ai', content: '' });
            aiItemIdx = displayItems.length - 1;
            displayItems = displayItems;
          }
          fullContent += content;
          if (aiItemIdx >= 0) {
            displayItems[aiItemIdx] = { type: 'message', role: 'ai', content: fullContent };
            displayItems = displayItems;
          }
        },
        onUsage(u) {
          usage = u;
        },
        onError(errMsg) {
          thinking = false;
          history.pop();
          displayItems.push({
            type: 'message',
            role: 'error',
            content: (errMsg.includes('网络') || errMsg.includes('Network') || errMsg.includes('Failed to fetch') ? tr.netError : tr.reqFailed) + errMsg,
          });
          displayItems = displayItems;
        },
      },
    );

    thinking = false;

    if (aiItemIdx < 0 && !usage) {
    }

    if (aiItemIdx >= 0 || usage) {
      const totalTime = Math.round(performance.now() - t0);
      const ttfb = firstChunkTime > 0 ? Math.round(firstChunkTime - t0) : '-';
      const inTokens = usage?.prompt_tokens ?? '-';
      const outTokens = usage?.completion_tokens ?? '-';
      if (usage) {
        const reportedTotal = usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));
        contextUsed = Math.max(contextUsed, reportedTotal, estimateHistoryTokens());
      } else {
        contextUsed = Math.max(contextUsed, estimateHistoryTokens());
      }
      displayItems.push({ type: 'meta', text: tr.metaFormat(ttfb, totalTime, inTokens, outTokens) });
      displayItems = displayItems;
      console.log(`[frontend] TTFB=${ttfb}ms total=${totalTime}ms in=${inTokens} out=${outTokens}`);
    }

    if (fullContent) {
      history.push({ role: 'assistant', content: fullContent });
    }
    loading = false;
  }

  function handleAsk(q: string) {
    handleSend(q);
  }
</script>

<Header {lang} {tr} {selectedTable} ontablechange={handleTableChange} ontogglelang={handleToggleLang} />
{#if showWelcome}
  <Welcome {tr} onask={handleAsk} />
{:else}
  <Chat items={displayItems} {thinking} thinkingText={tr.thinking} />
{/if}
<InputArea {tr} {loading} contextUsed={effectiveContextUsed} maxContext={MAX_CONTEXT} onsend={handleSend} oninputchange={handleInputChange} />
