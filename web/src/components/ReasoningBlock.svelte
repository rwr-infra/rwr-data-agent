<script lang="ts">
  import { formatElapsed } from '../lib/utils.js';

  interface Props {
    text: string;
    /** True while this block is the one still receiving deltas. */
    active?: boolean;
    reasoningLabel?: string;
    thinkingLabel?: string;
    elapsed?: number;
  }
  let {
    text,
    active = false,
    reasoningLabel = 'Reasoning',
    thinkingLabel = 'Thinking',
    elapsed = 0,
  }: Props = $props();

  let elapsedDisplay = $derived(formatElapsed(elapsed));
</script>

<details class="fold w-full max-w-[88vw] sm:max-w-2xl rounded-lg bg-base-200/50 text-xs" open={active}>
  <summary class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none font-medium text-base-content/60">
    <span class="fold-arrow inline-block text-[0.65rem] leading-none">▶</span>
    {#if active}
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
    <div class="whitespace-pre-wrap break-words border-l-2 border-base-300 pl-3 text-base-content/60">{text}</div>
  </div>
</details>
