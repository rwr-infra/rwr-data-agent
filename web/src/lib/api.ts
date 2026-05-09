import type { Message } from './types.js';

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  table?: string;
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
