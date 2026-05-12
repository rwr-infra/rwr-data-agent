<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    thinkingText: string;
    searchingText: string;
    generatingText: string;
    elapsed: number;
  }
  let { thinkingText, searchingText, generatingText, elapsed }: Props = $props();

  let phase = $state(0);
  const phases = [
    { icon: '🔍', text: () => searchingText },
    { icon: '🧠', text: () => thinkingText },
    { icon: '✨', text: () => generatingText },
  ];
  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    phase = 0;
    timer = setInterval(() => { phase = (phase + 1) % phases.length; }, 2500);
    return () => clearInterval(timer);
  });

  let current = $derived(phases[phase]);
  let elapsedDisplay = $derived(
    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  );
</script>

<div class="chat chat-start animate-fade-in" role="status" aria-live="polite" aria-label={thinkingText}>
  <div class="chat-bubble chat-bubble-base-200 flex items-start gap-3">
    <span class="text-xl animate-pulse">{current.icon}</span>
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
