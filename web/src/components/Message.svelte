<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';
  import type { Translations } from '../lib/i18n.js';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
    id: string;
    streaming?: boolean;
  }
  let { content, type, id, streaming = false }: Props = $props();
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