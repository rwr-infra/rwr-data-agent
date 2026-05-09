<script lang="ts">
  import Message from './Message.svelte';
  import ThinkingIndicator from './ThinkingIndicator.svelte';

  type DisplayItem =
    | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string }
    | { type: 'meta'; text: string };

  interface Props {
    items: DisplayItem[];
    thinking: boolean;
    streaming: boolean;
    thinkingText: string;
    searchingText: string;
    generatingText: string;
    elapsed: number;
  }
  let { items, thinking, streaming, thinkingText, searchingText, generatingText, elapsed }: Props = $props();

  let lastAiIdx = $derived(items.findLastIndex((it) => it.type === 'message' && it.role === 'ai'));

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
      <Message content={item.content} type={item.role} streaming={streaming && i === lastAiIdx} />
    {:else}
      <div class="msg-meta">{item.text}</div>
    {/if}
  {/each}
  {#if thinking}
    <ThinkingIndicator {thinkingText} {searchingText} {generatingText} {elapsed} />
  {/if}
</div>
