<script lang="ts">
  import type { Session } from '../lib/types.js';
  import type { Translations } from '../lib/i18n.js';

  interface Props {
    open: boolean;
    sessions: Session[];
    activeSessionId: string | null;
    tr: Translations;
    onselect: (id: string) => void;
    onnew: () => void;
    ondelete: (id: string) => void;
    onreset: () => void;
    onclose: () => void;
  }

  let { open, sessions, activeSessionId, tr, onselect, onnew, ondelete, onreset, onclose }: Props = $props();

  let searchQuery = $state('');
  let touchStartX = $state(0);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let showDeleteId: string | null = $state(null);
  let confirmingReset = $state(false);

  let filtered = $derived(
    searchQuery.trim()
      ? sessions.filter((s) => {
          const q = searchQuery.toLowerCase();
          return s.title.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q));
        })
      : sessions,
  );

  // The panel is behind an `{#if open}`, not a component boundary, so an armed confirm would still be
  // armed the next time the drawer opens.
  $effect(() => {
    if (!open) {
      confirmingReset = false;
      showDeleteId = null;
    }
  });

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return tr.langLabel === '中文' ? '刚刚' : 'just now';
    if (diff < 3_600_000) {
      const m = Math.floor(diff / 60_000);
      return tr.langLabel === '中文' ? `${m}分钟前` : `${m}m ago`;
    }
    if (diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      return tr.langLabel === '中文' ? `${h}小时前` : `${h}h ago`;
    }
    const d = new Date(ts);
    return d.toLocaleDateString(tr.langLabel === '中文' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
  }

  function handleBackdropClick() {
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
  }

  function handleTouchEnd(e: TouchEvent) {
    const delta = e.changedTouches[0].clientX - touchStartX;
    if (delta < -100) onclose();
  }

  function handleItemTouchStart(id: string) {
    longPressTimer = setTimeout(() => {
      showDeleteId = id;
    }, 500);
  }

  function handleItemTouchEnd() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function handleDeleteConfirm(id: string) {
    showDeleteId = null;
    ondelete(id);
  }

  function handleSelect(id: string) {
    showDeleteId = null;
    onselect(id);
  }

  function handleResetConfirm() {
    confirmingReset = false;
    onreset();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="drawer-backdrop fixed inset-0 z-50 bg-black/40 md:bg-black/20"
    onclick={handleBackdropClick}
    role="presentation"
  ></div>
  <div
    class="drawer-panel fixed top-0 left-0 z-50 h-full w-[280px] max-w-[85vw] bg-base-100 border-r border-base-300 flex flex-col shadow-xl"
    ontouchstart={handleTouchStart}
    ontouchend={handleTouchEnd}
    role="dialog"
    aria-label={tr.sessions}
    tabindex="-1"
  >
    <div class="flex items-center justify-between p-3 border-b border-base-300">
      <button class="btn btn-sm btn-ghost" onclick={onnew}>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        {tr.newSession}
      </button>
      <button class="btn btn-sm btn-ghost btn-circle" onclick={onclose} aria-label="Close">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="p-2">
      <input
        type="text"
        class="input input-sm input-bordered w-full text-sm"
        placeholder={tr.searchSessions}
        bind:value={searchQuery}
      />
    </div>

    <div class="flex-1 overflow-y-auto px-1">
      {#if filtered.length === 0}
        <div class="text-center text-base-content/50 text-sm py-8">{tr.noSessions}</div>
      {:else}
        {#each filtered as session (session.id)}
          <div
            class="group flex items-center gap-2 px-3 py-2.5 rounded-lg mx-1 mb-0.5 cursor-pointer transition-colors {session.id === activeSessionId ? 'bg-primary/10 text-primary' : 'hover:bg-base-200'}"
            onclick={() => handleSelect(session.id)}
            ontouchstart={() => handleItemTouchStart(session.id)}
            ontouchend={handleItemTouchEnd}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') handleSelect(session.id); }}
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm truncate">{session.title || tr.untitledSession}</div>
              <div class="text-xs text-base-content/50">{relativeTime(session.updatedAt)}</div>
            </div>
            {#if showDeleteId === session.id}
              <div class="flex gap-1 shrink-0">
                <button
                  class="btn btn-xs btn-error"
                  onclick={(e) => { e.stopPropagation(); handleDeleteConfirm(session.id); }}
                >
                  {tr.deleteSession}
                </button>
                <button
                  class="btn btn-xs btn-ghost"
                  onclick={(e) => { e.stopPropagation(); showDeleteId = null; }}
                >
                  {tr.recallCancelBtn}
                </button>
              </div>
            {:else}
              <button
                class="btn btn-xs btn-ghost btn-circle opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onclick={(e) => { e.stopPropagation(); showDeleteId = session.id; }}
                aria-label={tr.deleteSession}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    {#if confirmingReset}
      <div class="px-3 pt-2 text-xs leading-snug text-error border-t border-base-300">{tr.resetConfirm}</div>
    {/if}

    <div class="px-3 py-2 flex items-center justify-between gap-2 {confirmingReset ? '' : 'border-t border-base-300'}">
      <span class="text-xs text-base-content/40 shrink-0">{sessions.length} {tr.sessions.toLowerCase()}</span>
      {#if confirmingReset}
        <div class="flex gap-1 shrink-0">
          <button class="btn btn-xs btn-error" onclick={handleResetConfirm}>{tr.resetConfirmBtn}</button>
          <button class="btn btn-xs btn-ghost" onclick={() => { confirmingReset = false; }}>{tr.recallCancelBtn}</button>
        </div>
      {:else}
        <button
          class="btn btn-xs btn-ghost gap-1 text-base-content/50 hover:text-error"
          onclick={() => { confirmingReset = true; }}
          title={tr.resetHint}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
          {tr.resetAll}
        </button>
      {/if}
    </div>
  </div>
{/if}
