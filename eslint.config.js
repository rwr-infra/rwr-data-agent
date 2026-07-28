import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { includeIgnoreFile } from '@eslint/compat';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** File types to lint. Attached explicitly to every block that carries rules. */
const ALL = ['**/*.{ts,mts,cts,js,mjs,cjs}'];

/**
 * Targets that skip type-aware linting:
 *  - api/ imports from ../dist/*, a gitignored build artifact that is not
 *    guaranteed to exist. Type-aware rules would degrade the unresolved imports
 *    to `any` (a wall of no-unsafe-* false positives) and make lint results
 *    depend on whether `npm run build` has been run.
 *  - .d.ts files and plain-JS plugins gain nothing from type-aware rules.
 */
const UNTYPED = ['api/**/*.ts', 'types/**/*.d.ts', 'tools.d/**/*.js', 'eslint.config.js'];

export default tseslint.config(
  // .gitignore is the single source of truth for ignores — ESLint 9+ no longer
  // reads it automatically, and a hand-copied list drifts from the real one.
  // This also preserves directory pruning: .gitignore says `data/` (trailing
  // slash), which makes ESLint skip the whole tree. Written as `data/**` it does
  // NOT prune — ESLint would walk all 24k game-data files just to discard them.
  includeIgnoreFile(path.resolve(rootDir, '.gitignore')),

  // web/ is version-controlled so it is absent from .gitignore. It has its own
  // Svelte toolchain and is deliberately out of scope for this config.
  { ignores: ['web/'] },

  {
    files: ALL,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // nodeBuiltin, not node: this package is pure ESM, so __dirname/require/
      // module do not exist. `node` would wave a genuinely broken require()
      // through as a legitimate global.
      globals: { ...globals.nodeBuiltin },
      parserOptions: { projectService: true, tsconfigRootDir: rootDir },
    },
    rules: {
      // TypeScript resolves undefined identifiers itself; no-undef only produces
      // false positives on TS (whether `fetch` reports depends on the globals
      // package version). typescript-eslint's FAQ explicitly recommends off.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  { files: UNTYPED, extends: [tseslint.configs.disableTypeChecked] },

  // Must stay last: turns off formatting rules that conflict with Prettier and
  // adds no checks of its own.
  prettier,
);
