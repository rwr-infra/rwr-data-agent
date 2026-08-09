<script lang="ts">
  import type { CandidateView } from '../lib/types.js';
  import type { Translations } from '../lib/i18n.js';
  import MarkdownRenderer from './MarkdownRenderer.svelte';

  interface Props {
    candidates: CandidateView[];
    kind?: 'synthesis' | 'fallback';
    tr: Translations;
  }
  let { candidates, kind = 'synthesis', tr }: Props = $props();

  let open = $state(false);
  let failedCount = $derived(candidates.filter((c) => !c.ok).length);
</script>

<div class="flex flex-col items-start animate-fade-in w-full max-w-2xl">
  <details class="fold w-full rounded-box bg-base-200" bind:open={open}>
    <summary class="cursor-pointer select-none flex items-center gap-2 px-3 py-1.5 text-xs text-base-content/70">
      <span class="fold-arrow inline-block text-[0.65rem] leading-none">▶</span>
      <span class="font-medium">{tr.candidatesTitle} ({candidates.length})</span>
      <span class="ml-auto flex items-center gap-2">
        {#if failedCount > 0}
          <span class="text-error">{failedCount} failed</span>
        {/if}
        {#if kind === 'fallback'}
          <span class="text-warning">{tr.fallbackNote}</span>
        {/if}
      </span>
    </summary>
    {#if kind === 'synthesis'}
      <div class="text-xs text-base-content/50 px-3 mt-1 mb-2">{tr.disagreement}</div>
    {/if}
    <div class="px-3 pb-2">
      <div class="flex flex-col gap-3 mt-0.5 pl-3 border-l border-base-300">
        {#each candidates as c (c.i)}
          <div class="rounded-box border border-base-300 bg-base-100/50 p-2.5">
            <div class="flex items-center gap-2 text-xs text-base-content/70 mb-1">
              <span class="font-semibold">{tr.candidateN(c.i + 1)}</span>
              <span class="text-base-content/50">{c.steps} step{c.steps === 1 ? '' : 's'}</span>
              {#if c.ok}
                <svg class="shrink-0 text-success ml-auto" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              {:else}
                <svg class="shrink-0 text-error ml-auto" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              {/if}
            </div>
            {#if c.ok && c.answer}
              <div class="prose prose-sm max-w-none text-sm">
                <MarkdownRenderer source={c.answer} />
              </div>
            {:else}
              <div class="text-xs text-error/70">—</div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </details>
</div>
