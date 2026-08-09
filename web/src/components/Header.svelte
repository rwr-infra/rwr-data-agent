<script lang="ts">
  import { onMount } from 'svelte';
  import type { Translations } from '../lib/i18n.js';
  import type { PackageOption } from '../lib/types.js';
  import type { Theme } from '../lib/theme.js';
  import { authHeaders } from '../lib/api.js';

  interface Props {
    lang: string;
    tr: Translations;
    selectedMod: string;
    theme: Theme;
    onmodchange: (mod: string) => void;
    ontogglelang: () => void;
    ontoggletheme: () => void;
    ontogglemenu: () => void;
  }
  let { lang, tr, selectedMod, theme, onmodchange, ontogglelang, ontoggletheme, ontogglemenu }: Props = $props();

  interface PackageInfo {
    name: string;
    displayName: string;
    count: number;
  }

  let pkgList: PackageInfo[] = $state([]);

  // '' means "search across every package". A single package needs no picker —
  // everything already comes from it, so just show its name.
  const packages: PackageOption[] = $derived(
    pkgList.length === 1
      ? [{ value: '', label: pkgList[0].displayName || pkgList[0].name }]
      : [
          { value: '', label: tr.allPackages },
          ...pkgList.map((p) => ({ value: p.name, label: p.displayName || p.name })),
        ],
  );

  onMount(async () => {
    try {
      const res = await fetch('/v1/packages', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      pkgList = data.packages || [];
    } catch {}
  });
</script>

<div class="navbar bg-base-200 border-b border-base-300 p-0">
  <div class="mx-auto w-full max-w-4xl px-4 sm:px-6 flex flex-wrap items-center gap-x-3 gap-y-2">
  <div class="flex items-center gap-2 flex-1 min-w-0 order-1">
    <button class="btn btn-ghost btn-sm btn-circle shrink-0" onclick={ontogglemenu} aria-label={tr.sessions}>
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <h1 class="text-base sm:text-lg font-bold text-base-content truncate">RWR Data Agent</h1>
    <span class="badge badge-sm badge-ghost hidden sm:inline-flex shrink-0">{__APP_VERSION__}</span>
  </div>
  <div class="order-3 w-full sm:order-2 sm:w-auto">
    <select
      class="select select-sm select-bordered w-full sm:w-auto text-xs sm:text-sm"
      value={selectedMod}
      disabled={packages.length <= 1}
      onchange={(e) => onmodchange((e.target as HTMLSelectElement).value)}
    >
      {#each packages as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>
  <div class="flex items-center gap-1 sm:gap-2 flex-none order-2 sm:order-3">
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
</div>
