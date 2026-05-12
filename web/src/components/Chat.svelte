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

  let chatEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    items.length;
    thinking;
    streaming;
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  });
</script>

<div id="chat" bind:this={chatEl}>
  {#each items as item, i}
    {#if item.type === 'message'}
      <div class="msg-wrap {item.role}" class:dimmed={isDimmed(i)}>
        <Message
          content={item.content}
          type={item.role}
          id={item.id}
          streaming={streaming && i === lastAiIdx}
        />
        <!-- user & error: actions right after the bubble -->
        {#if item.role === 'user'}
          <div class="msg-actions">
            <button class="action-btn" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="action-btn" onclick={() => onrecall(item.id)} title={tr.recall} disabled={loading}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            </button>
          </div>
        {/if}
        {#if item.role === 'error'}
          <div class="msg-actions">
            <button class="action-btn" onclick={() => oncopy(item.id, 'text')} title={tr.copyText}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <!-- meta line -->
      <div class="msg-wrap meta" class:dimmed={isDimmed(i)}>
        <div class="msg-meta">{item.text}</div>
      </div>
      <!-- AI actions go AFTER the meta line that follows an AI message -->
      {#if i > 0 && items[i - 1].type === 'message' && items[i - 1].role === 'ai'}
        <div class="msg-actions ai-actions">
          <button class="action-btn" onclick={() => oncopy(items[i - 1].id, 'text')} title={tr.copyText}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <button class="action-btn md-label" onclick={() => oncopy(items[i - 1].id, 'markdown')} title={tr.copyMarkdown}>MD</button>
          <button class="action-btn" onclick={() => onretry(items[i - 1].id)} title={tr.retry} disabled={loading}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      {/if}
    {/if}

    {#if pendingRecallId && item.id === pendingRecallId}
      <div class="recall-confirm">
        <span>{tr.recallConfirm}</span>
        <button onclick={onconfirmrecall}>{tr.recallConfirmBtn}</button>
        <button class="cancel-btn" onclick={oncancelrecall}>{tr.recallCancelBtn}</button>
      </div>
    {/if}
  {/each}

  <!-- handle case: AI message is the last item (still streaming or no meta yet) -->
  {#if items.length > 0 && items[items.length - 1].type === 'message' && items[items.length - 1].role === 'ai' && !(streaming && items.length - 1 === lastAiIdx)}
    <div class="msg-actions ai-actions">
      <button class="action-btn" onclick={() => oncopy(items[items.length - 1].id, 'text')} title={tr.copyText}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
      <button class="action-btn md-label" onclick={() => oncopy(items[items.length - 1].id, 'markdown')} title={tr.copyMarkdown}>MD</button>
      <button class="action-btn" onclick={() => onretry(items[items.length - 1].id)} title={tr.retry} disabled={loading}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
      </button>
    </div>
  {/if}

  {#if thinking}
    <ThinkingIndicator {thinkingText} {searchingText} {generatingText} {elapsed} />
  {/if}
</div>