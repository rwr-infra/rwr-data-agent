<script lang="ts">
  import type { DisplayItem } from '../lib/types.js';
  import type { Translations } from '../lib/i18n.js';
  import Message from './Message.svelte';
  import ThinkingIndicator from './ThinkingIndicator.svelte';

  interface Props {
    items: DisplayItem[];
    thinking: boolean;
    streaming: boolean;
    thinkingText: string;
    searchingText: string;
    generatingText: string;
    elapsed: number;
    pendingRecallId: string | null;
    tr: Translations;
    loading: boolean;
    onretry: (id: string) => void;
    onrecall: (id: string) => void;
    oncopy: (id: string, format: 'text' | 'markdown') => void;
    onconfirmrecall: () => void;
    oncancelrecall: () => void;
  }
  let { items, thinking, streaming, thinkingText, searchingText, generatingText, elapsed, pendingRecallId, tr, loading, onretry, onrecall, oncopy, onconfirmrecall, oncancelrecall }: Props = $props();

  let lastAiIdx = $derived(items.findLastIndex((it) => it.type === 'message' && it.role === 'ai'));

  let recallStartIdx = $derived(
    pendingRecallId
      ? items.findIndex(it => it.id === pendingRecallId)
      : -1
  );

  function isDimmed(i: number): boolean {
    return recallStartIdx >= 0 && i >= recallStartIdx;
  }

  function prevWasAi(i: number): boolean {
    return i > 0 && items[i - 1].type === 'message' && items[i - 1].role === 'ai';
  }

  function nextIsMeta(i: number): boolean {
    return i + 1 < items.length && items[i + 1].type === 'meta';
  }

  let chatEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    items.length;
    thinking;
    streaming;
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  });
</script>

<div class="flex-1 overflow-y-auto p-3 sm:p-6 flex flex-col gap-4" bind:this={chatEl}>
  {#each items as item, i}
    {#if item.type === 'message' && item.role === 'ai' && nextIsMeta(i)}
      {@const metaItem = items[i + 1]}
      <div class="group flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i) || isDimmed(i + 1)} class:transition-opacity={isDimmed(i) || isDimmed(i + 1)}>
        <Message content={item.content} type="ai" id={item.id} streaming={streaming && i === lastAiIdx} />
        <div class="text-xs text-base-content/50 mt-0.5 animate-fade-in">{metaItem.text}</div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2">
          <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <button class="btn btn-ghost btn-xs font-bold text-xs" onclick={() => oncopy(item.id, 'markdown')} title={tr.copyMarkdown}>MD</button>
          <button class="btn btn-ghost btn-xs" onclick={() => onretry(item.id)} title={tr.retry} disabled={loading}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      </div>
    {:else if item.type === 'meta' && prevWasAi(i)}
    {:else if item.type === 'message'}
      {#if item.role === 'ai' && !nextIsMeta(i) && !(streaming && i === lastAiIdx)}
        <div class="group flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
          <Message content={item.content} type="ai" id={item.id} />
          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2">
            <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="btn btn-ghost btn-xs font-bold text-xs" onclick={() => oncopy(item.id, 'markdown')} title={tr.copyMarkdown}>MD</button>
            <button class="btn btn-ghost btn-xs" onclick={() => onretry(item.id)} title={tr.retry} disabled={loading}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>
          </div>
        </div>
      {:else}
        <div class="flex flex-col animate-fade-in"
          class:items-end={item.role === 'user'}
          class:items-start={item.role !== 'user'}
          class:opacity-50={isDimmed(i)}
          class:transition-opacity={isDimmed(i)}
        >
          <Message content={item.content} type={item.role} id={item.id} streaming={streaming && i === lastAiIdx} />
          {#if item.role === 'user'}
            <div class="group">
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2 justify-end">
                <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                </button>
                <button class="btn btn-ghost btn-xs" onclick={() => onrecall(item.id)} title={tr.recall} disabled={loading}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                </button>
              </div>
            </div>
          {/if}
          {#if item.role === 'error'}
            <div class="group">
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2">
                <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {:else if item.type === 'meta' && !prevWasAi(i)}
      <div class="flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <div class="text-xs text-base-content/50">{item.text}</div>
      </div>
    {/if}

    {#if pendingRecallId && item.id === pendingRecallId}
      <div class="self-start max-w-[80%] p-3 bg-primary/10 border border-primary rounded-lg flex items-center gap-3 text-sm text-base-content animate-fade-in">
        <span>{tr.recallConfirm}</span>
        <button class="btn btn-primary btn-xs" onclick={onconfirmrecall}>{tr.recallConfirmBtn}</button>
        <button class="btn btn-ghost btn-xs" onclick={oncancelrecall}>{tr.recallCancelBtn}</button>
      </div>
    {/if}
  {/each}

  {#if thinking}
    <ThinkingIndicator {thinkingText} {searchingText} {generatingText} {elapsed} />
  {/if}
</div>
