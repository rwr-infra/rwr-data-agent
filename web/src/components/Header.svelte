<script lang="ts">
  import { onMount } from 'svelte';
  import type { Translations } from '../lib/i18n.js';
  import type { TableOption } from '../lib/types.js';
  import type { Theme } from '../lib/theme.js';

  interface Props {
    lang: string;
    tr: Translations;
    selectedTable: string;
    theme: Theme;
    ontablechange: (table: string) => void;
    ontogglelang: () => void;
    ontoggletheme: () => void;
    ontogglemenu: () => void;
  }
  let { lang, tr, selectedTable, theme, ontablechange, ontogglelang, ontoggletheme, ontogglemenu }: Props = $props();

  let tables: TableOption[] = $state([]);

  onMount(async () => {
    try {
      const res = await fetch('/v1/tables');
      if (!res.ok) return;
      const data = await res.json();
      const def = data.default || 'rwr_documents';
      const list: string[] = data.tables || [];
      if (!list.length) {
        tables = [{ value: '', label: def + ' ' + tr.defaultTag }];
      } else {
        tables = list.map((tbl: string) => ({
          value: tbl === def ? '' : tbl,
          label: tbl + (tbl === def ? ' ' + tr.defaultTag : ''),
        }));
      }
    } catch {}
  });
</script>

<div class="navbar bg-base-200 border-b border-base-300 px-3 sm:px-4">
  <div class="navbar-start gap-2">
    <button class="btn btn-ghost btn-sm btn-circle" onclick={ontogglemenu} aria-label={tr.sessions}>
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <h1 class="text-base sm:text-lg font-semibold">RWR Data Agent</h1>
    <span class="badge badge-sm badge-ghost">v1</span>
  </div>
  <div class="navbar-end gap-2">
    <select
      class="select select-sm select-bordered w-auto text-xs sm:text-sm"
      value={selectedTable}
      onchange={(e) => ontablechange((e.target as HTMLSelectElement).value)}
    >
      {#each tables as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <a
      class="btn btn-ghost btn-sm btn-circle"
      href="https://github.com/rwr-infra/rwr-data-agent"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GitHub"
    >
      <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
    </a>
    <label class="swap swap-rotate btn btn-ghost btn-sm btn-circle">
      <input
        type="checkbox"
        class="theme-controller"
        value="dark"
        checked={theme === 'dark'}
        onchange={ontoggletheme}
      />
      <svg class="swap-off" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>
      </svg>
      <svg class="swap-on" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    </label>
    <button class="btn btn-ghost btn-sm text-xs" onclick={ontogglelang}>{tr.langLabel}</button>
  </div>
</div>
