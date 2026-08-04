import type { Message } from './types.js';

export const TOKEN_KEY = 'rwr-data-agent-token';

/**
 * API token for deployments that set `API_TOKEN` on the server.
 *
 * There is no settings UI: the operator opens the page once with `?token=…`, which is persisted and
 * stripped from the address bar so it does not sit in history or get shared by copying the URL.
 * Deployments without `API_TOKEN` never see any of this.
 */
export function captureTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  url.searchParams.delete('token');
  window.history.replaceState({}, '', url.toString());
}

/** Auth headers for `/v1/*`, empty when no token has been captured. */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { 'x-api-key': token } : {};
}

/**
 * Server-side ceilings from `GET /v1/limits`. Fetched once at mount so the round indicator shows
 * the operator's real cap from the first turn instead of after a rejected request. On failure the
 * caller keeps its own default — a missing endpoint (older backend) must not break the page.
 */
export async function fetchLimits(): Promise<{ maxConversationRounds?: number } | null> {
  try {
    const res = await fetch('/v1/limits', { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    return { maxConversationRounds: data?.max_conversation_rounds };
  } catch {
    return null;
  }
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  mod?: string;
}

export interface StreamCallbacks {
  onContent: (content: string) => void;
  onUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void;
  onError: (error: string) => void;
}

export async function streamChat(request: ChatRequest, callbacks: StreamCallbacks): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err: any) {
    callbacks.onError(err.message);
    return;
  }

  if (!response.ok) {
    const err = await response.text();
    callbacks.onError(err);
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content || '';
        if (content) callbacks.onContent(content);
        if (json.usage) callbacks.onUsage(json.usage);
      } catch {}
    }
  }
}
