/**
 * Syntax highlighting for fenced code blocks in answers.
 *
 * Two grammars are registered, because two are what this agent emits: the game data is
 * XML — `.xml` plus a pile of XML-in-disguise extensions (`.weapon`, `.projectile`,
 * `.vehicle`, `.character`, …) — and the scripts are AngelScript (`.as`). Importing the
 * `highlight.js` barrel would pull in 190+ grammars, so this takes `lib/core` and adds
 * those two by hand: ~25 kB gzipped instead of ~1 MB. Adding a language later is one
 * import plus one `registerLanguage` line.
 */
import hljs from 'highlight.js/lib/core';
import angelscript from 'highlight.js/lib/languages/angelscript';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('angelscript', angelscript);

/**
 * Fence labels highlight.js does not resolve on its own. It already knows each grammar's
 * declared aliases (`html`/`svg`/`plist`/… → xml, `asc` → angelscript); `as` is the
 * extension the game files actually carry, and the model writes it far more often than
 * `angelscript`.
 */
const EXTRA_ALIASES: Record<string, string> = {
  as: 'angelscript',
};

/**
 * Past this length the block stays plain. A block that big is a pasted file rather than a
 * quoted snippet, and tokenizing it costs more than colors are worth on lines nobody
 * scrolls to.
 */
const MAX_HIGHLIGHT_CHARS = 40_000;

/**
 * Which grammar a fence should be highlighted as, or `null` to leave it plain.
 *
 * An unrecognized label — including the bare game extensions (` ```weapon `) and no label
 * at all — falls back to sniffing the first character. That is deliberately the only
 * heuristic here: the extension list is long and grows with the game, while "starts with
 * `<`" identifies every one of them without a list to maintain.
 */
export function resolveLanguage(lang: string | undefined, text: string): string | null {
  // marked hands over the whole info string, which may carry more than the language.
  const label = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
  const aliased = EXTRA_ALIASES[label] ?? label;
  if (aliased && hljs.getLanguage(aliased) !== undefined) return aliased;
  return text.trimStart().startsWith('<') ? 'xml' : null;
}

/**
 * Highlighted HTML for `text`, or `null` when the block should render as plain text.
 *
 * The returned markup is HTML-escaped by highlight.js, which is what makes it safe to
 * inject with `{@html}` at the call site.
 */
export function highlight(text: string, lang: string | undefined): string | null {
  if (text.length > MAX_HIGHLIGHT_CHARS) return null;
  const language = resolveLanguage(lang, text);
  if (language === null) return null;
  try {
    // `ignoreIllegals` is load-bearing twice over: a quoted block is routinely a fragment
    // lifted out of the middle of a file, and mid-stream it is a truncated one. A strict
    // parse throws on both and would drop the whole block's colors.
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    // A grammar that throws anyway must not take the surrounding message down with it.
    return null;
  }
}
