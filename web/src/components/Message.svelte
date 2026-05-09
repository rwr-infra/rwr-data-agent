<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
  }
  let { content, type }: Props = $props();
</script>

{#if type === 'ai'}
  <div class="msg ai">
    <MarkdownRenderer source={content} />
  </div>
{:else}
  <div class="msg {type}">{content}</div>
{/if}
