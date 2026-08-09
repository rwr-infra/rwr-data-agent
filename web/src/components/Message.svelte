<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
    streaming?: boolean;
  }
  let { content, type, streaming = false }: Props = $props();
</script>

{#if type === 'ai'}
  <div class="chat chat-start">
    <div class="chat-bubble relative w-full max-w-full">
      <MarkdownRenderer source={content} />
      {#if streaming}
        <span class="inline-block w-0.5 h-4 bg-primary ml-0.5 align-text-bottom rounded-sm animate-pulse" aria-hidden="true"></span>
      {/if}
    </div>
  </div>
{:else if type === 'error'}
  <div class="chat chat-start">
    <div class="chat-bubble chat-bubble-error max-w-[85%] sm:max-w-[80%]">{content}</div>
  </div>
{:else}
  <div class="chat chat-end">
    <div class="chat-bubble chat-bubble-primary max-w-[85%] sm:max-w-[80%] whitespace-pre-wrap break-words">{content}</div>
  </div>
{/if}
