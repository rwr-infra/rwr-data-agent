<script lang="ts">
  import type { DisplayItem } from '../lib/types.js';
  import type { Translations } from '../lib/i18n.js';
  import Message from './Message.svelte';
  import ReasoningBlock from './ReasoningBlock.svelte';
  import ToolCallCard from './ToolCallCard.svelte';
  import ThinkingIndicator from './ThinkingIndicator.svelte';
  import CandidatePanel from './CandidatePanel.svelte';

  interface Props {
    items: DisplayItem[];
    thinking: boolean;
    streaming: boolean;
    thinkingText: string;
    searchingText: string;
    generatingText: string;
    elapsed: number;
    pendingRecallTurnId: string | null;
    /** Id of the block still receiving deltas — it gets the caret / the live reasoning header. */
    activeBlockId: string | null;
    tr: Translations;
    loading: boolean;
    onretry: (turnId: string) => void;
    onrecall: (turnId: string) => void;
    oncopy: (id: string) => void;
    oncopyturn: (turnId: string, format: 'text' | 'markdown') => void;
    onconfirmrecall: () => void;
    oncancelrecall: () => void;
  }
  let { items, thinking, streaming, thinkingText, searchingText, generatingText, elapsed, pendingRecallTurnId, activeBlockId, tr, loading, onretry, onrecall, oncopy, oncopyturn, onconfirmrecall, oncancelrecall }: Props = $props();

  // The turn still streaming. Its action bar and meta line stay hidden until it finishes.
  let liveTurnId = $derived(streaming ? items[items.length - 1]?.turnId : undefined);

  let recallStartIdx = $derived(
    pendingRecallTurnId
      ? items.findIndex(it => it.turnId === pendingRecallTurnId)
      : -1
  );

  function isDimmed(i: number): boolean {
    return recallStartIdx >= 0 && i >= recallStartIdx;
  }

  // Each of these binds the neighbour to a local first: indexing twice (`items[i-1].type === … &&
  // items[i-1].role === …`) discards the narrowing between the two reads, since TS cannot know the
  // array did not change in between.
  /** True when the block before `i` is one this turn's answer text lives in — an AI message, or the
   *  revision that superseded it. Both render the meta line inside their own block. */
  function prevWasAnswer(i: number): boolean {
    const prev = i > 0 ? items[i - 1] : undefined;
    if (prev?.type === 'revision') return true;
    return prev?.type === 'message' && prev.role === 'ai';
  }

  /**
   * One-line summary of a revision's findings, e.g. `缺少证据支撑的结论 ×10、缺少来源文件引用 ×3`.
   *
   * Aggregated by code rather than listed: a reflection routinely reports the same finding about
   * several claims, and one badge each turned the header into a row of a dozen identical chips that
   * said nothing the count does not. The per-claim `detail` stays on the wire for the log; what the
   * reader needs here is which checks failed and roughly how often.
   */
  function issueSummary(issues: { code: string; detail?: string }[]): string {
    const counts = new Map<string, number>();
    for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    return [...counts]
      .map(([code, n]) => `${tr.reflectionIssue(code)}${n > 1 ? ` ×${n}` : ''}`)
      .join('、');
  }

  /** Text of the meta line that follows an AI message, or '' when there is none. */
  function metaTextAt(i: number): string {
    const next = items[i + 1];
    return next?.type === 'meta' ? next.text : '';
  }

  /**
   * The last answer block of each turn — the action bar belongs to the turn, not to every block
   * (text → tool → text …), so it hangs off the final one only. One reverse pass, recomputed when
   * `items` changes; a per-row forward scan would make every streamed delta O(items × turn size).
   *
   * A revision counts, and being later it wins: the turn's copy/retry belong to the answer the
   * conversation actually continues from, and hanging a second bar off the superseded text would give
   * one turn two.
   */
  let turnEndIds = $derived.by(() => {
    const ids = new Set<string>();
    const seen = new Set<string>();
    for (let j = items.length - 1; j >= 0; j--) {
      const it = items[j];
      const isAnswer = it.type === 'revision' || (it.type === 'message' && it.role === 'ai');
      if (isAnswer && !seen.has(it.turnId)) {
        seen.add(it.turnId);
        ids.add(it.id);
      }
    }
    return ids;
  });

  // A meta line that follows an AI message is rendered *inside* that message's block, so it must not
  // render again on its own. Filtering it out here (keeping the original index, which `prevWasAi` /
  // `isDimmed` key off) replaces what used to be an empty `{:else if}` branch.
  let rows = $derived(
    items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => !(item.type === 'meta' && prevWasAnswer(i))),
  );

  let chatEl: HTMLDivElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();

  // Deliberately not `$state`: the scroll effect both reads and writes it, and a reactive read
  // would make the user's own scroll re-run the effect that scrolls them back down.
  let stick = true;

  function scrollToBottom() {
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function handleScroll() {
    if (!chatEl) return;
    // Tolerance rather than an exact match: sub-pixel scrollHeight and momentum scrolling leave a
    // few pixels of slack even when the view is visually pinned to the bottom.
    stick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 48;
  }

  // Streaming rewrites the last block's text in place, so `items.length` never changes and a
  // length-keyed effect only fires between blocks — the final answer would grow off-screen until
  // the turn ends. Watching the content box's height catches every delta, and also the late layout
  // shifts markdown produces (tables, code blocks, images) that no state dependency can see.
  $effect(() => {
    if (!contentEl) return;
    const ro = new ResizeObserver(() => {
      if (stick) scrollToBottom();
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    const last = items[items.length - 1];
    thinking;
    streaming;
    // A message the user just sent always snaps to the bottom; blocks the agent appends respect
    // whether the user has scrolled up to read something.
    if (last?.type === 'message' && last.role === 'user') stick = true;
    if (stick) scrollToBottom();
  });
</script>

{#snippet copyIcon()}
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
{/snippet}

{#snippet aiActions(turnId: string)}
  <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2">
    <button class="btn btn-ghost btn-xs" onclick={() => oncopyturn(turnId, 'text')} title={tr.copyText}>
      {@render copyIcon()}
    </button>
    <button class="btn btn-ghost btn-xs font-bold text-xs" onclick={() => oncopyturn(turnId, 'markdown')} title={tr.copyMarkdown}>MD</button>
    <button class="btn btn-ghost btn-xs" onclick={() => onretry(turnId)} title={tr.retry} disabled={loading}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
    </button>
  </div>
{/snippet}

<div class="flex-1 overflow-y-auto" bind:this={chatEl} onscroll={handleScroll}>
  <div class="mx-auto w-full max-w-4xl px-4 sm:px-6 pt-4 pb-8 sm:pb-10 flex flex-col gap-4" bind:this={contentEl}>
  {#each rows as { item, i } (item.id)}
    {#if item.type === 'message' && item.role === 'ai'}
      <div class="group flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <Message content={item.content} type="ai" streaming={item.id === activeBlockId} />
        {#if item.turnId !== liveTurnId && turnEndIds.has(item.id)}
          {#if metaTextAt(i)}
            <div class="text-xs text-base-content/50 mt-0.5 animate-fade-in">{metaTextAt(i)}</div>
          {/if}
          {@render aiActions(item.turnId)}
        {/if}
      </div>
    {:else if item.type === 'message'}
      <!-- `group` sits on the whole block, as in the AI branch: hovering the bubble reveals the
           actions. On the button row alone it would only respond to a pointer already over the
           invisible buttons. -->
      <div class="group flex flex-col animate-fade-in"
        class:items-end={item.role === 'user'}
        class:items-start={item.role !== 'user'}
        class:opacity-50={isDimmed(i)}
        class:transition-opacity={isDimmed(i)}
      >
        <Message content={item.content} type={item.role} />
        {#if item.role === 'user'}
          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2 justify-end">
            <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id)} title={tr.copyText}>
              {@render copyIcon()}
            </button>
            <button class="btn btn-ghost btn-xs" onclick={() => onrecall(item.turnId)} title={tr.recall} disabled={loading}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            </button>
          </div>
        {/if}
        {#if item.role === 'error'}
          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 transition-opacity mt-1 mb-2">
            <button class="btn btn-ghost btn-xs" onclick={() => oncopy(item.id)} title={tr.copyText}>
              {@render copyIcon()}
            </button>
          </div>
        {/if}
      </div>
    {:else if item.type === 'reasoning'}
      <div class="flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <ReasoningBlock
          text={item.text}
          active={item.id === activeBlockId}
          reasoningLabel={tr.reasoning}
          thinkingLabel={tr.thinking}
          {elapsed}
        />
      </div>
    {:else if item.type === 'tool-call'}
      <div class="flex flex-col items-start animate-fade-in w-full" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <ToolCallCard
          toolName={item.toolName}
          input={item.input}
          output={item.output}
          ok={item.ok}
          durationMs={item.durationMs}
          runningLabel={tr.toolRunning}
          failedLabel={tr.toolFailed}
          resultLabel={tr.toolResult}
        />
      </div>
    {:else if item.type === 'meta'}
      <div class="flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <div class="text-xs text-base-content/50">{item.text}</div>
      </div>
    {:else if item.type === 'candidate-trace'}
      <div class="flex flex-col items-start animate-fade-in w-full max-w-2xl" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <details class="fold rounded-box bg-base-200 text-xs text-base-content/70 w-full" open>
          <summary class="cursor-pointer select-none flex items-center gap-1.5 px-3 py-1.5">
            <span class="fold-arrow inline-block text-[0.65rem] leading-none">▶</span>
            <span class="font-medium truncate">{tr.candidateN(item.candidate + 1)} / {item.total}</span>
            {#if !item.done}
              <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0 ml-auto" aria-hidden="true"></span>
            {:else if item.ok === false}
              <svg class="shrink-0 ml-auto text-error" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            {:else}
              <svg class="shrink-0 ml-auto text-success" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </summary>
          <div class="px-3 pb-2">
            <div class="flex flex-col gap-0.5 mt-0.5 pl-3 border-l border-base-300">
              {#each item.steps as step}
                <span class="flex items-center gap-1.5" class:text-error={step.ok === false}>
                  {#if step.ok === undefined}
                    <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" aria-hidden="true"></span>
                  {:else if step.ok}
                    <svg class="shrink-0 text-success" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  {:else}
                    <svg class="shrink-0 text-error" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  {/if}
                  <span class="min-w-0">{step.text}</span>
                  {#if step.durationMs != null}<span class="text-base-content/30 shrink-0">{step.durationMs}ms</span>{/if}
                </span>
              {/each}
              {#if !item.done}
                <span class="animate-pulse text-base-content/30">…</span>
              {/if}
            </div>
          </div>
        </details>
      </div>
    {:else if item.type === 'candidate-panel'}
      <div class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <CandidatePanel candidates={item.candidates} kind={item.kind} {tr} />
      </div>
    {:else if item.type === 'reflection'}
      <div class="flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <div class="text-xs text-success/70">{tr.reflectionPass}</div>
      </div>
    {:else if item.type === 'revision'}
      <!-- Rendered as an ordinary answer bubble, not a quote or a collapsible panel: this *is* the
           answer the conversation continues from, and framing it as an aside made the superseded
           version look like the real one. The findings collapse into a single note above it — one
           badge per repeated finding filled the header with a dozen identical chips. -->
      <div class="group flex flex-col items-start animate-fade-in" class:opacity-50={isDimmed(i)} class:transition-opacity={isDimmed(i)}>
        <div class="text-xs text-warning/80 mb-1">
          {tr.revisionNote}{issueSummary(item.issues) ? ` · ${issueSummary(item.issues)}` : ''}
        </div>
        <Message content={item.text} type="ai" />
        {#if item.turnId !== liveTurnId && turnEndIds.has(item.id)}
          {#if metaTextAt(i)}
            <div class="text-xs text-base-content/50 mt-0.5 animate-fade-in">{metaTextAt(i)}</div>
          {/if}
          {@render aiActions(item.turnId)}
        {/if}
      </div>
    {/if}

    {#if pendingRecallTurnId && item.type === 'message' && item.role === 'user' && item.turnId === pendingRecallTurnId}
      <div class="self-start max-w-[80%] p-3 bg-primary/10 border border-primary rounded-box flex items-center gap-3 text-sm text-base-content animate-fade-in">
        <span>{tr.recallConfirm}</span>
        <button class="btn btn-primary btn-xs" onclick={onconfirmrecall}>{tr.recallConfirmBtn}</button>
        <button class="btn btn-ghost btn-xs" onclick={oncancelrecall}>{tr.recallCancelBtn}</button>
      </div>
    {/if}
  {/each}

  {#if thinking}
    <ThinkingIndicator {thinkingText} {searchingText} {generatingText} {elapsed} />
  {/if}
  </div>
</div>
