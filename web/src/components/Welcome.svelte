<script lang="ts">
  import type { Translations } from '../lib/i18n.js';

  interface Props {
    tr: Translations;
    onask: (q: string) => void;
  }
  let { tr, onask }: Props = $props();
</script>

<div class="flex-1 flex flex-col items-center justify-center text-center gap-4 text-base-content/60 px-4">
  <h2 class="text-lg sm:text-xl font-semibold text-base-content">{tr.welcomeTitle}</h2>
  <p class="text-sm max-w-md leading-relaxed">{tr.welcomeDesc}</p>
  <div class="flex flex-wrap gap-2 justify-center mt-2">
    <button class="btn btn-outline btn-sm" onclick={() => onask(tr.exWeapons)}>{tr.exWeapons}</button>
    <button class="btn btn-outline btn-sm" onclick={() => onask(tr.exM4a1)}>{tr.exM4a1}</button>
    <button class="btn btn-outline btn-sm" onclick={() => onask(tr.exExact)}>{tr.exExact}</button>
  </div>
</div>
