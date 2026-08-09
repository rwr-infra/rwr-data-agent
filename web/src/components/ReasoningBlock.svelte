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

<details class="fold w-full max-w-2xl rounded-box bg-base-200 text-xs" open={active}>
  <summary class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none font-medium text-base-content/70">
    <span class="fold-arrow inline-block text-[0.65rem] leading-none">▶</span>
    {#if active}
      <svg class="animate-pulse text-primary shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5a2.5 2.5 0 0 1-2-2.45V14a2.5 2.5 0 0 1 1.5-2.3A2.5 2.5 0 0 1 4.5 8 2.5 2.5 0 0 1 7 5.5 2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5a2.5 2.5 0 0 0 2-2.45V14a2.5 2.5 0 0 0-1.5-2.3A2.5 2.5 0 0 0 19.5 8a2.5 2.5 0 0 0-2.5-2.5A2.5 2.5 0 0 0 14.5 2Z"/></svg>
      <span aria-live="polite">{thinkingLabel}</span>
      <span class="loading loading-dots loading-xs"></span>
      {#if elapsed > 0}
        <span class="badge badge-ghost badge-xs ml-auto">{elapsedDisplay}</span>
      {/if}
    {:else}
      <svg class="shrink-0 text-base-content/50" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5a2.5 2.5 0 0 1-2-2.45V14a2.5 2.5 0 0 1 1.5-2.3A2.5 2.5 0 0 1 4.5 8 2.5 2.5 0 0 1 7 5.5 2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5a2.5 2.5 0 0 0 2-2.45V14a2.5 2.5 0 0 0-1.5-2.3A2.5 2.5 0 0 0 19.5 8a2.5 2.5 0 0 0-2.5-2.5A2.5 2.5 0 0 0 14.5 2Z"/></svg>
      <span>{reasoningLabel}</span>
    {/if}
  </summary>
  <div class="px-3 pb-2 pt-0.5">
    <div class="whitespace-pre-wrap break-words border-l border-base-300 pl-3 text-base-content/70">{text}</div>
  </div>
</details>
