<script lang="ts">
  import type { Translations } from '../lib/i18n.js';
  import type { TokenBreakdown } from '../lib/types.js';

  interface Props {
    used: number;
    max: number;
    breakdown?: TokenBreakdown;
    tr: Translations;
  }
  let { used, max, breakdown, tr }: Props = $props();

  let pct = $derived(Math.min((used / max) * 100, 100));
  function fmt(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K' : String(n);
  }
  let display = $derived(fmt(used));
  let maxDisplay = $derived(fmt(max));
</script>

{#snippet bar()}
  <div class="flex w-full items-center gap-2 text-xs text-base-content/50 select-none">
    <progress class="progress progress-primary w-full max-w-[200px] h-1" value={pct} max="100"></progress>
    <span class:text-error={pct > 90} class:text-warning={pct > 70 && pct <= 90}>{display} / {maxDisplay} tokens</span>
  </div>
{/snippet}

{#if breakdown}
  <div class="dropdown dropdown-hover dropdown-top w-full">
    <div tabindex="0" role="button" class="w-full cursor-help">{@render bar()}</div>
    <div class="dropdown-content z-10 w-56 mb-1 rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
      <div class="mb-1 font-semibold text-base-content/80">{tr.tokenBreakdown}</div>
      <div class="mt-0.5 text-base-content/40">{tr.bdInput}</div>
      <div class="flex justify-between pl-2"><span class="text-base-content/60">{tr.bdSystem}</span><span class="tabular-nums">{breakdown.systemPrompt}</span></div>
      <div class="flex justify-between pl-2"><span class="text-base-content/60">{tr.bdContext}</span><span class="tabular-nums">{breakdown.context}</span></div>
      <div class="flex justify-between pl-2"><span class="text-base-content/60">{tr.bdMessages}</span><span class="tabular-nums">{breakdown.messages}</span></div>
      <div class="mt-1 text-base-content/40">{tr.bdOutput}</div>
      {#if breakdown.reasoning > 0}
        <div class="flex justify-between pl-2"><span class="text-base-content/60">{tr.bdReasoning}</span><span class="tabular-nums">{breakdown.reasoning}</span></div>
      {/if}
      <div class="flex justify-between pl-2"><span class="text-base-content/60">{tr.bdAnswer}</span><span class="tabular-nums">{breakdown.answer}</span></div>
    </div>
  </div>
{:else}
  {@render bar()}
{/if}
