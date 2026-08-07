<script lang="ts">
  import type { Translations } from '../lib/i18n.js';
  import type { TokenBreakdown } from '../lib/types.js';
  import ContextBar from './ContextBar.svelte';

  interface Props {
    tr: Translations;
    loading: boolean;
    contextUsed: number;
    maxContext: number;
    /** Rounds used / server cap. `maxRounds === 0` means unlimited and hides the indicator. */
    roundsUsed: number;
    maxRounds: number;
    breakdown?: TokenBreakdown;
    maxMode?: boolean;
    onmaxtoggle?: () => void;
    onsend: (text: string) => void;
    oninputchange: (text: string) => void;
    prefillText?: string;
    onprefillconsumed?: () => void;
  }
  let {
    tr,
    loading,
    contextUsed,
    maxContext,
    roundsUsed,
    maxRounds,
    breakdown,
    maxMode = false,
    onmaxtoggle,
    onsend,
    oninputchange,
    prefillText = '',
    onprefillconsumed,
  }: Props = $props();

  let inputText = $state('');
  let textarea: HTMLTextAreaElement | undefined = $state();

  // The indicator only earns its space once the cap is in sight: warning on the last three rounds,
  // error once nothing is left. Below that it stays a plain, quiet counter.
  let roundsLeft = $derived(Math.max(maxRounds - roundsUsed, 0));
  let roundsExhausted = $derived(maxRounds > 0 && roundsLeft === 0);
  let roundsLow = $derived(maxRounds > 0 && roundsLeft > 0 && roundsLeft <= 3);

  function handleInput() {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    oninputchange(inputText);
  }

  function handleKeydown(e: KeyboardEvent) {
    // IME (e.g. Rime) commits the candidate with Enter; that keydown must not send the message.
    // Safari fires this keydown after compositionend with isComposing already false, but keeps
    // keyCode 229 — hence the extra check.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = inputText.trim();
    if (!text || loading) return;
    inputText = '';
    if (textarea) textarea.style.height = 'auto';
    onsend(text);
  }

  $effect(() => {
    if (prefillText) {
      inputText = prefillText;
      handleInput();
      setTimeout(() => {
        if (textarea) textarea.focus();
        onprefillconsumed?.();
      }, 100);
    }
  });
</script>

<div class="p-3 sm:p-4 border-t border-base-300 bg-base-200 flex flex-col gap-2 w-full max-w-full">
  <!-- Note: no overflow-hidden here — the ContextBar's token-breakdown dropdown opens upward
       and would be clipped by it. Scrollbar safety comes from the `min-w-0` chains below and the
       app root's `h-dvh overflow-hidden`. -->
  <!-- ChatGPT-style composer: the textarea and the Send button share one joined field, Send on
       the right — same on mobile. The button hugs the bottom as the textarea grows, and stays
       disabled until there is something to send. -->
  <div class="join w-full max-w-full min-w-0">
    <textarea
      class="textarea textarea-bordered join-item flex-1 resize-none min-h-[44px] leading-relaxed text-sm sm:text-base"
      rows="1"
      bind:this={textarea}
      bind:value={inputText}
      placeholder={tr.placeholder}
      oninput={handleInput}
      onkeydown={handleKeydown}
    ></textarea>
    <!-- While a turn streams the button spins rather than just greying out: disabled alone reads as
         "nothing to send", the spinner says "an answer is on its way". Still disabled — the send
         path is closed either way. -->
    <button
      class="btn btn-primary btn-sm join-item shrink-0 self-end h-[44px] w-[44px]"
      aria-label={loading ? tr.thinking : tr.send}
      title={loading ? tr.thinking : tr.send}
      aria-busy={loading}
      disabled={loading || !inputText.trim()}
      onclick={submit}
    >
      {#if loading}
        <span class="loading loading-spinner loading-sm"></span>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
      {/if}
    </button>
  </div>

  <!-- One full-width row: the usage stats on the left, Max-mode toggle on the right. On mobile
       it stacks — stats first, then the toggle. `min-w-0` everywhere is what lets the row
       compress instead of spilling a horizontal scrollbar. -->
  <div class="flex flex-col sm:flex-row sm:items-center gap-2 w-full max-w-full min-w-0">
    <!-- Stats cluster: context occupancy and the round counter are both "how much of the budget is
         gone", so they sit together. `flex-wrap` + a basis on the bar is the mobile behaviour: on a
         narrow phone the round counter drops to its own line instead of squeezing the bar. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 sm:flex-1">
      <!-- Sized, not grown: with `flex-1` the bar ate the whole row and pushed the round counter to
           the far right, which read as two unrelated widgets. A fixed basis keeps the counter
           glued to the bar on desktop; it may still shrink, and wraps below on a narrow phone. -->
      <!-- `h-4` on both stats (= the `text-xs` line box) is what makes their text sit on one line:
           left to their own heights, the bar's row and the counter resolve differently and the
           counter rides high. Fixed identical boxes + `items-center` inside each one. -->
      <div class="flex h-4 items-center min-w-0 basis-[300px] grow-0 shrink">
        <ContextBar used={contextUsed} max={maxContext} {breakdown} {tr} />
      </div>
      <!-- Round counter: how many question/answer rounds this conversation has spent against the
           server's MAX_CONVERSATION_ROUNDS. Hidden when the operator disabled the cap (0). -->
      {#if maxRounds > 0}
        <!-- Divider only from `sm` up: below that the cluster wraps and the rule would be left
             dangling at the end of the context row. Decorative, so it is hidden from a11y. -->
        <span class="hidden sm:block h-3 w-px shrink-0 self-center bg-base-300" aria-hidden="true"></span>
        <span
          class="inline-flex h-4 items-center shrink-0 text-xs leading-4 tabular-nums select-none {roundsExhausted
            ? 'text-error'
            : roundsLow
              ? 'text-warning'
              : 'text-base-content/50'}"
          title={tr.roundsHint(maxRounds)}
        >
          {tr.roundsLabel} {Math.min(roundsUsed, maxRounds)} / {maxRounds}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2 min-w-0">
      <!-- Max mode: a daisyUI toggle switch with its label, wrapped in a hover tooltip explaining
           what it does. The tooltip only shows on lg+ screens (hover has no meaning on touch);
           `title` is the native fallback there. Clicking the label toggles the checkbox. -->
      <label
        class="lg:tooltip tooltip-edge shrink-0 flex items-center gap-1.5 cursor-pointer"
        data-tip={tr.maxModeHint}
      >
        <input
          type="checkbox"
          class="toggle toggle-primary toggle-sm"
          title={tr.maxModeHint}
          aria-label={tr.maxMode}
          checked={maxMode}
          disabled={loading}
          onchange={() => onmaxtoggle?.()}
        />
        <span class="text-xs text-base-content/60 select-none">{tr.maxMode}</span>
      </label>
    </div>
  </div>

  <div class="text-center text-xs text-base-content/40 select-none">{tr.aiDisclaimer}</div>
</div>

<style>
  /* The Max-mode toggle sits at the right edge of the input row. daisyUI centers the tooltip
     bubble on its anchor, so a wide hint spills past the viewport; anchor the bubble to the
     label's right edge instead — it grows leftward, stays above the toggle, and the arrow keeps
     pointing at the toggle. */
  .lg\:tooltip.tooltip-edge[data-tip]:before {
    inset: auto 0 var(--tt-off) auto;
    transform: translateY(var(--tt-pos, 0.25rem));
  }
</style>
