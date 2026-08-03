<script lang="ts">
  import type { Translations } from '../lib/i18n.js';
  import type { TokenBreakdown } from '../lib/types.js';
  import ContextBar from './ContextBar.svelte';

  interface Props {
    tr: Translations;
    loading: boolean;
    contextUsed: number;
    maxContext: number;
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

  function handleInput() {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    oninputchange(inputText);
  }

  function handleKeydown(e: KeyboardEvent) {
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
    <button
      class="btn btn-primary btn-sm join-item shrink-0 self-end h-[44px] w-[44px]"
      aria-label={tr.send}
      title={tr.send}
      disabled={loading || !inputText.trim()}
      onclick={submit}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5" />
        <path d="m5 12 7-7 7 7" />
      </svg>
    </button>
  </div>

  <!-- One full-width row: context indicator on the left, Max-mode toggle on the right. On mobile
       it stacks — context first, then the toggle. `min-w-0` everywhere is what lets the row
       compress instead of spilling a horizontal scrollbar. -->
  <div class="flex flex-col sm:flex-row sm:items-center gap-2 w-full max-w-full min-w-0">
    <div class="min-w-0 sm:flex-1">
      <ContextBar used={contextUsed} max={maxContext} {breakdown} {tr} />
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
