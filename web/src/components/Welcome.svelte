<script lang="ts">
  import type { Translations } from '../lib/i18n.js';

  interface Props {
    tr: Translations;
    onask: (q: string) => void;
  }
  let { tr, onask }: Props = $props();
</script>

<div class="welcome">
  <h2>{tr.welcomeTitle}</h2>
  <p>{tr.welcomeDesc}</p>
  <div class="examples">
    <button onclick={() => onask(tr.exWeapons)}>{tr.exWeapons}</button>
    <button onclick={() => onask(tr.exM4a1)}>{tr.exM4a1}</button>
    <button onclick={() => onask(tr.exExact)}>{tr.exExact}</button>
  </div>
</div>
