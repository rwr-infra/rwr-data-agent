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

<div class="tool-card w-full max-w-[88vw] sm:max-w-2xl">
  <details class="fold group text-xs">
    <summary
      class="cursor-pointer select-none flex items-center gap-1.5 py-0.5"
      class:text-error={failed}
      class:text-base-content={!failed}
      class:opacity-60={!failed}
    >
      <span class="fold-arrow inline-block text-[0.65rem] leading-none" class:invisible={!output}>▶</span>
      <span aria-hidden="true">{running ? '⏺' : failed ? '✕' : '✓'}</span>
      <span class="font-medium truncate">{toolName}</span>
      {#if input}
        <span class="truncate opacity-70">({input})</span>
      {/if}
      {#if running}
        <span class="loading loading-dots loading-xs shrink-0" aria-label={runningLabel}></span>
      {:else}
        {#if failed}<span class="shrink-0">{failedLabel}</span>{/if}
        {#if durationMs != null}<span class="shrink-0 opacity-60">{durationMs}ms</span>{/if}
      {/if}
    </summary>
    {#if output}
      <div class="mt-0.5 pl-3 border-l border-base-300 whitespace-pre-wrap break-words opacity-70" class:text-error={failed}>
        <span class="opacity-60">{resultLabel}:</span>
        {output}
      </div>
    {/if}
  </details>
</div>
