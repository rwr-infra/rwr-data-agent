<script lang="ts">
  interface Props {
    used: number;
    max: number;
  }
  let { used, max }: Props = $props();

  let pct = $derived(Math.min((used / max) * 100, 100));
  let fillClass = $derived(pct > 90 ? 'over' : pct > 70 ? 'warn' : '');
  let display = $derived(used >= 1000 ? (used / 1000).toFixed(1) + 'K' : used);
  let labelColor = $derived(pct > 90 ? '#f87171' : pct > 70 ? '#fbbf24' : 'var(--muted)');
</script>

<div id="ctx-bar">
  <div id="ctx-track"><div id="ctx-fill" class={fillClass} style="width: {pct}%"></div></div>
  <span style="color: {labelColor}">{display} / 200K tokens</span>
</div>
