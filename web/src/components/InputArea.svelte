<script lang="ts">
  import type { Translations } from '../lib/i18n.js';
  import ContextBar from './ContextBar.svelte';

  interface Props {
    tr: Translations;
    loading: boolean;
    contextUsed: number;
    maxContext: number;
    onsend: (text: string) => void;
    oninputchange: (text: string) => void;
    prefillText?: string;
    onprefillconsumed?: () => void;
  }
  let { tr, loading, contextUsed, maxContext, onsend, oninputchange, prefillText = '', onprefillconsumed }: Props = $props();

  let inputText = $state('');
  let textarea: HTMLTextAreaElement | undefined = $state();

  function handleInput() {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    oninputchange(inputText);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = inputText.trim();
    if (!text || loading) return;
    inputText = '';
    if (textarea) textarea.style.height = 'auto';
    onsend(text);
  }

  $effect(() => {
    if (prefillText) {
      inputText = prefillText;
      handleInput();
      setTimeout(() => {
        if (textarea) textarea.focus();
        onprefillconsumed?.();
      }, 100);
    }
  });
</script>

<div id="input-area">
  <div id="input-row">
    <textarea
      class="chat-input"
      rows="1"
      bind:this={textarea}
      bind:value={inputText}
      placeholder={tr.placeholder}
      oninput={handleInput}
      onkeydown={handleKeydown}
    ></textarea>
    <button class="send-btn" disabled={loading} onclick={submit}>{tr.send}</button>
  </div>
  <ContextBar used={contextUsed} max={maxContext} />
</div>