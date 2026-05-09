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

<div class="thinking-card" role="status" aria-live="polite" aria-label={thinkingText}>
  <div class="thinking-icon">{current.icon}</div>
  <div class="thinking-body">
    <div class="thinking-header">
      <span class="thinking-label">{current.text()}</span>
      <span class="thinking-timer">{elapsedDisplay}</span>
    </div>
    <div class="skeleton-lines">
      <div class="skeleton-line w80"></div>
      <div class="skeleton-line w60"></div>
      <div class="skeleton-line w45"></div>
    </div>
  </div>
</div>
