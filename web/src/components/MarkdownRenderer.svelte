<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';

  interface Props {
    source: string;
  }
  let { source }: Props = $props();
</script>

<div class="markdown-body">
  <SvelteMarkdown
    {source}
    options={{ gfm: true, breaks: true }}
    streaming={true}
  />
</div>
