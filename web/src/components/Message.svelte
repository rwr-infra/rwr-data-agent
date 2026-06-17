<script lang="ts">
  import { slide } from 'svelte/transition';
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
    id: string;
    streaming?: boolean;
    reasoning?: string;
    reasoningLabel?: string;
    thinkingLabel?: string;
    elapsed?: number;
  }
  let {
    content,
    type,
    id,
    streaming = false,
    reasoning,
    reasoningLabel = 'Reasoning',
    thinkingLabel = 'Thinking',
    elapsed = 0,
  }: Props = $props();

  // "Thinking" phase: actively streaming, reasoning has begun, but the answer text
  // hasn't started yet. Surfaces a live indicator instead of an empty bubble.
  let reasoningActive = $derived(streaming && !!reasoning && !content);
  let elapsedDisplay = $derived(
    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
  );
</script>

{#if type === 'ai'}
  <div class="chat chat-start">
    <div class="chat-bubble chat-bubble-base-200 relative max-w-[88vw] sm:max-w-none">
      {#if reasoning}
        <details class="reasoning mb-2 rounded-lg bg-base-100/50 text-xs" transition:slide={{ duration: 200 }}>
          <summary class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none font-medium text-base-content/60">
            <span class="reasoning-arrow inline-block text-[0.65rem] leading-none">▶</span>
            {#if reasoningActive}
              <span class="animate-pulse">🧠</span>
              <span aria-live="polite">{thinkingLabel}</span>
              <span class="loading loading-dots loading-xs"></span>
              {#if elapsed > 0}
                <span class="badge badge-ghost badge-xs ml-auto">{elapsedDisplay}</span>
              {/if}
            {:else}
              <span>💭 {reasoningLabel}</span>
            {/if}
          </summary>
          <div class="px-3 pb-2 pt-0.5">
            <div class="whitespace-pre-wrap break-words border-l-2 border-base-300 pl-3 text-base-content/60">{reasoning}</div>
          </div>
        </details>
      {/if}
      <MarkdownRenderer source={content} />
      {#if streaming && !reasoningActive}
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
