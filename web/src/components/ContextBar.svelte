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

  // Every slice is a proportional attribution of the reported total, so it carries "~" unless the
  // provider reported that exact figure itself (listed in `breakdown.exact`).
  function cell(value: number, field: string): string {
    return (breakdown?.exact.includes(field) ? '' : '~') + fmt(value);
  }

  type Row = [label: string, value: number, field: string];

  let inputRows = $derived<Row[]>(
    breakdown
      ? ([
          [tr.bdSystem, breakdown.systemPrompt, 'systemPrompt'],
          [tr.bdToolDefs, breakdown.toolDefs, 'toolDefs'],
          [tr.bdContext, breakdown.context, 'context'],
          [tr.bdMessages, breakdown.messages, 'messages'],
          [tr.bdToolResults, breakdown.toolResults, 'toolResults'],
        ] as Row[]).filter(([, v]) => v > 0)
      : [],
  );
  let outputRows = $derived<Row[]>(
    breakdown
      ? ([
          [tr.bdReasoning, breakdown.reasoning, 'reasoning'],
          [tr.bdToolCalls, breakdown.toolCalls, 'toolCalls'],
          [tr.bdAnswer, breakdown.answer, 'answer'],
        ] as Row[]).filter(([, v]) => v > 0)
      : [],
  );
  let inputTotal = $derived(inputRows.reduce((s, [, v]) => s + v, 0));
  let outputTotal = $derived(outputRows.reduce((s, [, v]) => s + v, 0));
</script>

{#snippet bar()}
  <div class="flex w-full items-center gap-2 text-xs text-base-content/50 select-none" title={tr.ctxHint}>
    <!-- The bar yields, the label does not: `min-w` + shrink on the progress and `nowrap` +
         `shrink-0` on the counter, so a narrow container shortens the bar instead of wrapping
         "Context 0 / 500K" onto two lines. -->
    <progress class="progress progress-primary w-full max-w-[200px] min-w-[48px] shrink h-1" value={pct} max="100"></progress>
    <span class="whitespace-nowrap shrink-0" class:text-error={pct > 90} class:text-warning={pct > 70 && pct <= 90}>
      {tr.ctxLabel} {display} / {maxDisplay}
    </span>
  </div>
{/snippet}

{#snippet slice(label: string, value: number, field: string)}
  <div class="flex justify-between pl-2">
    <span class="text-base-content/60">{label}</span>
    <span class="tabular-nums">{cell(value, field)}</span>
  </div>
{/snippet}

{#if breakdown}
  <div class="dropdown dropdown-hover dropdown-top w-full">
    <div tabindex="0" role="button" class="w-full cursor-help">{@render bar()}</div>
    <div class="dropdown-content z-10 w-64 mb-1 rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
      <div class="mb-1 flex items-baseline justify-between gap-2">
        <span class="font-semibold text-base-content/80">{tr.tokenBreakdown}</span>
        {#if breakdown.steps > 1}
          <span class="text-base-content/40" title={tr.bdStepsHint(breakdown.steps)}>{tr.bdSteps(breakdown.steps)}</span>
        {/if}
      </div>

      <div class="mt-0.5 flex justify-between text-base-content/40">
        <span>{tr.bdInput}</span><span class="tabular-nums">{fmt(inputTotal)}</span>
      </div>
      {#each inputRows as [label, value, field] (field)}
        {@render slice(label, value, field)}
      {/each}
      {#if breakdown.cacheRead > 0}
        <!-- Cache reads are a subset of the input total, so they sit outside the slice list. -->
        <div class="flex justify-between pl-2">
          <span class="text-success/70">{tr.bdCacheRead}</span>
          <span class="tabular-nums text-success/70">{fmt(breakdown.cacheRead)}</span>
        </div>
      {/if}

      <div class="mt-1 flex justify-between text-base-content/40">
        <span>{tr.bdOutput}</span><span class="tabular-nums">{fmt(outputTotal)}</span>
      </div>
      {#each outputRows as [label, value, field] (field)}
        {@render slice(label, value, field)}
      {/each}
    </div>
  </div>
{:else}
  {@render bar()}
{/if}
