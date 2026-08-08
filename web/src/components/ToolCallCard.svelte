<script lang="ts">
  interface Props {
    toolName: string;
    /** Argument summary from the opening event — part of the always-visible header line. */
    input?: string;
    /** Result summary from the closing event — the fold body. */
    output?: string;
    /** Absent while the call is still running; false when the tool returned an error. */
    ok?: boolean;
    durationMs?: number;
    runningLabel: string;
    failedLabel: string;
    resultLabel: string;
  }
  let { toolName, input, output, ok, durationMs, runningLabel, failedLabel, resultLabel }: Props = $props();

  // `ok` is what closes the card: absent means the closing event has not arrived, so the call is
  // still running. A failed call is closed too — it just closes red.
  let running = $derived(ok === undefined);
  let failed = $derived(ok === false);
</script>

<div class="tool-card w-full max-w-2xl">
  <details class="fold rounded-box bg-base-200 text-xs">
    <summary
      class="cursor-pointer select-none flex items-center gap-1.5 px-3 py-1.5 {failed ? 'text-error' : 'text-base-content/70'}"
    >
      <span class="fold-arrow inline-block text-[0.65rem] leading-none" class:invisible={!output}>▶</span>
      <span class="font-medium truncate">{toolName}</span>
      {#if input}
        <span class="truncate text-base-content/50">({input})</span>
      {/if}
      {#if running}
        <span class="loading loading-dots loading-xs ml-auto shrink-0 text-primary" aria-label={runningLabel}></span>
      {:else}
        <span class="ml-auto flex items-center gap-1.5 shrink-0">
          {#if failed}
            <svg class="shrink-0 text-error" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            <span class="text-error">{failedLabel}</span>
          {:else}
            <svg class="shrink-0 text-success" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          {/if}
          {#if durationMs != null}<span class="text-base-content/50">{durationMs}ms</span>{/if}
        </span>
      {/if}
    </summary>
    {#if output}
      <div class="px-3 pb-2">
        <div class="whitespace-pre-wrap break-words border-l border-base-300 pl-3 text-base-content/70" class:text-error={failed}>
          <span class="text-base-content/50">{resultLabel}:</span>
          {output}
        </div>
      </div>
    {/if}
  </details>
</div>
