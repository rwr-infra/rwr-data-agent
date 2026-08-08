<script lang="ts">
  import { onMount } from 'svelte';
  import { formatElapsed } from '../lib/utils.js';

  interface Props {
    thinkingText: string;
    searchingText: string;
    generatingText: string;
    elapsed: number;
  }
  let { thinkingText, searchingText, generatingText, elapsed }: Props = $props();

  let phase = $state(0);
  const phases = [
    { text: () => searchingText },
    { text: () => thinkingText },
    { text: () => generatingText },
  ];
  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    phase = 0;
    timer = setInterval(() => { phase = (phase + 1) % phases.length; }, 2500);
    return () => clearInterval(timer);
  });

  let current = $derived(phases[phase]);
  let elapsedDisplay = $derived(formatElapsed(elapsed));
</script>

<div class="chat chat-start animate-fade-in" role="status" aria-live="polite" aria-label={thinkingText}>
  <div class="chat-bubble flex items-start gap-3">
    <span class="animate-pulse text-primary shrink-0 mt-0.5">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    </span>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-sm font-medium text-base-content animate-pulse">{current.text()}</span>
        <span class="badge badge-primary badge-xs">{elapsedDisplay}</span>
      </div>
      <div class="flex flex-col gap-2">
        <div class="skeleton h-2.5 w-4/5"></div>
        <div class="skeleton h-2.5 w-3/5"></div>
        <div class="skeleton h-2.5 w-2/5"></div>
      </div>
    </div>
  </div>
</div>
