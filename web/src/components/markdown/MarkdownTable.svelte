<!--
@component
Custom markdown table renderer: wraps the native <table> in a horizontally
scrollable container so wide tables scroll within the chat bubble on mobile
instead of overflowing and getting clipped by the viewport.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
  }
  let { children }: Props = $props();
</script>

<div class="overflow-x-auto max-w-full">
  <table>{@render children?.()}</table>
</div>
