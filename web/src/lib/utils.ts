/**
 * Client-side token estimate. Mirrors `estimateTokens` in `src/api/tokenAccounting.ts` — that is the
 * source of truth; keep the two formulas identical or the bar will disagree with the server's own
 * numbers. Han/kana/hangul cost roughly one token per 1.5 characters, everything else per 4.
 *
 * Only used as a floor for the context bar before the server reports real usage, and to add the
 * pending input box to it.
 */
const CJK_CHARS = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHARS)?.length ?? 0;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

/** Live elapsed badge: seconds until one minute, then m:ss. Shared by the thinking indicator and
 *  the reasoning-block header so the two can never show the same time in two formats. */
export function formatElapsed(seconds: number): string {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) =>
      m
        .replace(/^```\w*\n?/gm, '')
        .replace(/```/gm, '')
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(.+?)\*(?!\*)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}