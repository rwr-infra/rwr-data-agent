import { TOKEN_KEY } from './api.js';
import { clearAllSessions, deleteDatabase } from './sessionStore.js';

/**
 * localStorage keys that survive a reset. The API token is a credential, not state: there is no
 * settings UI to type it back in, so wiping it would lock the operator out of `/v1` until someone
 * re-opens the page with `?token=…`.
 */
const PRESERVED_KEYS = [TOKEN_KEY];

function wipeWebStorage(): void {
  const keep: Array<[string, string]> = [];
  for (const key of PRESERVED_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) keep.push([key, value]);
  }
  // Storage can be blocked outright (private mode, hardened settings); a reset that throws there
  // would be worse than one that no-ops.
  try {
    localStorage.clear();
  } catch (e) {
    console.warn('[reset] localStorage.clear() failed:', e);
  }
  try {
    sessionStorage.clear();
  } catch (e) {
    console.warn('[reset] sessionStorage.clear() failed:', e);
  }
  for (const [key, value] of keep) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[reset] restoring preserved key failed:', e);
    }
  }
}

/**
 * Wipe this app's entire browser-side state: the IndexedDB session store plus the mod / lang / theme
 * localStorage keys. The caller reloads afterwards — a session record the UI can no longer render is
 * only really gone once nothing in memory writes it back.
 */
export async function resetLocalState(): Promise<void> {
  await clearAllSessions();
  wipeWebStorage();
  await deleteDatabase();
}

/**
 * `?reset=1` escape hatch, consumed in `main.ts` before Svelte mounts: the in-app button is
 * unreachable when a bad session record throws during the first render. Returns true when a reset is
 * under way — the caller must skip mounting, the page is already navigating.
 */
export function consumeUrlReset(): boolean {
  const url = new URL(window.location.href);
  const flag = url.searchParams.get('reset');
  if (flag === null || flag === '0' || flag === 'false') return false;
  url.searchParams.delete('reset');
  wipeWebStorage();
  void deleteDatabase().then(() => {
    window.location.replace(url.toString());
  });
  return true;
}
