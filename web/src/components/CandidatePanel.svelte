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

<div class="flex flex-col items-start animate-fade-in w-full max-w-[88vw] sm:max-w-none">
  <details class="fold w-full" bind:open={open}>
    <summary class="cursor-pointer select-none flex items-center gap-2 py-1 text-xs text-base-content/50">
      <span class="fold-arrow inline-block text-[0.65rem] leading-none">▶</span>
      <span class="font-medium">{tr.candidatesTitle} ({candidates.length})</span>
      {#if failedCount > 0}
        <span class="text-error">{failedCount} failed</span>
      {/if}
      {#if kind === 'fallback'}
        <span class="text-warning">{tr.fallbackNote}</span>
      {/if}
    </summary>
    {#if kind === 'synthesis'}
      <div class="text-xs text-base-content/40 mt-1 mb-2">{tr.disagreement}</div>
    {/if}
    <div class="flex flex-col gap-3 mt-0.5 pl-3 border-l border-base-300">
      {#each candidates as c (c.i)}
        <div class="rounded-lg border border-base-300 bg-base-100/50 p-2.5">
          <div class="flex items-center gap-2 text-xs text-base-content/60 mb-1">
            <span class="font-semibold">{tr.candidateN(c.i + 1)}</span>
            <span class="text-base-content/40">{c.steps} step{c.steps === 1 ? '' : 's'}</span>
            {#if c.ok}
              <span class="text-success">✓</span>
            {:else}
              <span class="text-error">✕</span>
            {/if}
          </div>
          {#if c.ok && c.answer}
            <div class="prose prose-sm max-w-none text-sm">
              <MarkdownRenderer source={c.answer} />
            </div>
          {:else}
            <div class="text-xs text-error/80">—</div>
          {/if}
        </div>
      {/each}
    </div>
  </details>
</div>
