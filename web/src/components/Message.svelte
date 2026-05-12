<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
    id: string;
    streaming?: boolean;
  }
  let { content, type, id, streaming = false }: Props = $props();
</script>

{#if type === 'ai'}
  <div class="chat chat-start">
    <div class="chat-bubble chat-bubble-base-200 relative max-w-[80vw] sm:max-w-none">
      <MarkdownRenderer source={content} />
      {#if streaming}
        <span class="inline-block w-0.5 h-4 bg-primary ml-0.5 align-text-bottom rounded-sm animate-pulse" aria-hidden="true"></span>
      {/if}
    </div>
  </div>
{:else if type === 'error'}
  <div class="chat chat-start">
    <div class="chat-bubble chat-bubble-error max-w-[80vw] sm:max-w-none">{content}</div>
  </div>
{:else}
  <div class="chat chat-end">
    <div class="chat-bubble chat-bubble-primary max-w-[80vw] sm:max-w-none whitespace-pre-wrap break-words">{content}</div>
  </div>
{/if}
