<script lang="ts">
  interface Props {
    used: number;
    max: number;
  }
  let { used, max }: Props = $props();

  let pct = $derived(Math.min((used / max) * 100, 100));
  let display = $derived(used >= 1000 ? (used / 1000).toFixed(1) + 'K' : used);
</script>

<div class="flex items-center gap-2 text-xs text-base-content/50 select-none">
  <progress class="progress progress-primary w-full max-w-[200px] h-1" value={pct} max="100"></progress>
  <span class:text-error={pct > 90} class:text-warning={pct > 70 && pct <= 90}>{display} / 200K tokens</span>
</div>
