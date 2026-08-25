<!--
@component
Custom markdown code-block renderer: colors the fence with highlight.js when it resolves
to one of the two registered grammars (XML, AngelScript — see `lib/highlight.ts`), and
otherwise renders exactly the plain `<pre><code>` the default renderer produced.
-->
<script lang="ts">
  import { highlight } from '../../lib/highlight.js';

  interface Props {
    /** Info string from the fence: `xml`, `as`, a bare game extension, or empty. */
    lang: string;
    text: string;
  }
  let { lang, text }: Props = $props();

  /**
   * How long the text must hold still before it is highlighted again. `MarkdownRenderer`
   * parses in streaming mode, so an unterminated fence is re-parsed on every arriving
   * token — highlighting each of those would re-tokenize the whole block dozens of times
   * a second to color intermediate strings nobody reads. Between the settle windows the
   * block shows as plain monospace, which is what it looked like before this component.
   */
  const SETTLE_MS = 120;

  let html = $state<string | null>(null);

  // A replayed session gets its blocks in one piece, so the first run highlights straight
  // away — waiting out the settle window there would flash plain text for no reason. Only
  // the runs after it are the streaming case.
  let initial = true;

  $effect(() => {
    const source = text;
    const info = lang;
    if (initial) {
      initial = false;
      html = highlight(source, info);
      return;
    }
    // Drop the previous highlight before waiting: it was built from a prefix of `source`,
    // so leaving it up would show stale *content*, not merely stale colors.
    html = null;
    const timer = setTimeout(() => {
      html = highlight(source, info);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  });
</script>

<!-- Kept on one line: Svelte preserves whitespace inside `<pre>` verbatim. `html` is
     escaped by highlight.js, so `{@html}` cannot inject markup from the model. -->
<pre><code class="hljs">{#if html !== null}{@html html}{:else}{text}{/if}</code></pre>
