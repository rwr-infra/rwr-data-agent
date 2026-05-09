<script lang="ts">
  interface Props {
    content: string;
    type: 'user' | 'ai' | 'error';
  }
  let { content, type }: Props = $props();
</script>

<div class="msg {type}">{content}</div>
