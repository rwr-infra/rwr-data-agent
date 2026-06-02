<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
    id: string;
    streaming?: boolean;
    reasoning?: string;
    reasoningLabel?: string;
  }
  let { content, type, id, streaming = false, reasoning, reasoningLabel = 'Reasoning' }: Props = $props();
</script>

{#if type === 'ai'}
  <div class="chat chat-start">
    <div class="chat-bubble chat-bubble-base-200 relative max-w-[80vw] sm:max-w-none">
      {#if reasoning}
        <details class="reasoning mb-2 rounded-lg bg-base-100/50 text-xs">
          <summary class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none font-medium text-base-content/60">
            <span class="reasoning-arrow inline-block text-[0.65rem] leading-none">▶</span>
            <span>💭 {reasoningLabel}</span>
          </summary>
          <div class="px-3 pb-2 pt-0.5">
            <div class="whitespace-pre-wrap break-words border-l-2 border-base-300 pl-3 text-base-content/60">{reasoning}</div>
          </div>
        </details>
      {/if}
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

<style>
  /* Native <details> reasoning fold — avoids daisyUI collapse's absolutely-positioned
     arrow overlapping the short label. The arrow sits inline on the left and rotates on open. */
  details.reasoning > summary {
    list-style: none;
  }
  details.reasoning > summary::-webkit-details-marker {
    display: none;
  }
  .reasoning-arrow {
    transition: transform 0.15s ease;
  }
  details.reasoning[open] > summary .reasoning-arrow {
    transform: rotate(90deg);
  }
</style>
