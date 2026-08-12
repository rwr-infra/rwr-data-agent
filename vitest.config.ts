import { defineConfig } from 'vitest/config';

/**
 * Unit tests cover the *pure* layer only — intent classification, tool disclosure, the transcript
 * shaper, token accounting, the tool envelope, plugin loading. Deterministic, no LLM calls, no
 * network. Behaviour that needs a real model belongs in `npm run eval:agent`.
 *
 * `include` is scoped rather than left at the default glob on purpose: the default would walk
 * `data/` and `ww2-data/` (~24k game files) looking for test files.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
