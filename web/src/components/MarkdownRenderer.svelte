<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';

  interface Props {
    source: string;
  }
  let { source }: Props = $props();
</script>

<div class="prose prose-sm max-w-none
  prose-headings:text-base-content
  prose-p:text-base-content
  prose-a:text-primary
  prose-code:bg-base-300 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
  prose-pre:bg-base-300 prose-pre:border prose-pre:border-base-300
  prose-blockquote:border-l-primary prose-blockquote:text-base-content/60
  prose-th:bg-base-300 prose-td:border-base-300 prose-th:border-base-300
  prose-hr:border-base-300
  prose-strong:text-base-content
  prose-li:text-base-content
">
  <SvelteMarkdown
    {source}
    options={{ gfm: true, breaks: true }}
    streaming={true}
  />
</div>
