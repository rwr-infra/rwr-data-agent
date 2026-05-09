<script lang="ts">
  import Message from './Message.svelte';

  type DisplayItem =
    | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string }
    | { type: 'meta'; text: string };

  interface Props {
    items: DisplayItem[];
    thinking: boolean;
    thinkingText: string;
  }
  let { items, thinking, thinkingText }: Props = $props();

  let chatEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    items.length;
    thinking;
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  });
</script>

<div id="chat" bind:this={chatEl}>
  {#each items as item}
    {#if item.type === 'message'}
      <Message content={item.content} type={item.role} />
    {:else}
      <div class="msg-meta">{item.text}</div>
    {/if}
  {/each}
  {#if thinking}
    <div class="typing">{thinkingText}<span>.</span><span>.</span><span>.</span></div>
  {/if}
</div>
