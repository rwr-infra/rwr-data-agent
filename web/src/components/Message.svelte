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
  <div class="msg ai">
    <MarkdownRenderer source={content} />
    {#if streaming}
      <span class="streaming-cursor" aria-hidden="true"></span>
    {/if}
  </div>
{:else}
  <div class="msg {type}">{content}</div>
{/if}
