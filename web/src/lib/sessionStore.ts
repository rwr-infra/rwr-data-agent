import { createStore, get, set, del, clear, entries } from 'idb-keyval';
import type { Message, Session } from './types.js';

const DB_NAME = 'rwr-data-agent';
const STORE_NAME = 'sessions';

let store: ReturnType<typeof createStore> | null = null;
let memoryFallback = false;
const memStore = new Map<string, Session>();

function getStore() {
  if (!store && !memoryFallback) {
    try {
      store = createStore(DB_NAME, STORE_NAME);
    } catch (e) {
      console.warn('[sessionStore] createStore failed, using memory fallback:', e);
      memoryFallback = true;
    }
  }
  return store;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  const text = first.content.trim();
  return text.length > 30 ? text.slice(0, 30) + '...' : text;
}

export async function getAllSessions(): Promise<Session[]> {
  let list: Session[];
  if (memoryFallback) {
    list = [...memStore.values()];
  } else {
    const s = getStore();
    if (!s) return [];
    try {
      const allEntries = await entries(s);
      list = allEntries.map(([, v]) => v as Session);
    } catch (e) {
      console.warn('[sessionStore] entries() failed, using memory fallback:', e);
      memoryFallback = true;
      list = [...memStore.values()];
    }
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSession(id: string): Promise<Session | undefined> {
  if (memoryFallback) return memStore.get(id);
  const s = getStore();
  if (!s) return undefined;
  try {
    return (await get(id, s)) as Session | undefined;
  } catch (e) {
    console.warn('[sessionStore] get() failed:', e);
    return memStore.get(id);
  }
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = Date.now();
  if (memoryFallback) {
    memStore.set(session.id, session);
    return;
  }
  const s = getStore();
  if (!s) return;
  try {
    await set(session.id, session, s);
  } catch (e) {
    console.warn('[sessionStore] set() failed, using memory fallback:', e);
    memoryFallback = true;
    memStore.set(session.id, session);
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (memoryFallback) {
    memStore.delete(id);
    return;
  }
  const s = getStore();
  if (!s) return;
  try {
    await del(id, s);
  } catch (e) {
    console.warn('[sessionStore] del() failed, using memory fallback:', e);
    memoryFallback = true;
    memStore.delete(id);
  }
}

/** Empty the store in place. Works with this tab's connection still open, unlike deleteDatabase(). */
export async function clearAllSessions(): Promise<void> {
  memStore.clear();
  if (memoryFallback) return;
  const s = getStore();
  if (!s) return;
  try {
    await clear(s);
  } catch (e) {
    console.warn('[sessionStore] clear() failed:', e);
  }
}

/**
 * Drop the whole database, not just its records — the last resort when the store itself is what is
 * broken. `blocked` resolves too: this tab holds an open connection, so the delete only completes
 * after the reload that follows, and clearAllSessions() has already emptied the records.
 */
export function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch (e) {
      console.warn('[sessionStore] deleteDatabase() failed:', e);
      resolve();
    }
  });
}
