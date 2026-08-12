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
 *  - root config files belong to no tsconfig `include`, so projectService cannot
 *    type them at all.
 */
const UNTYPED = [
  'api/**/*.ts',
  'types/**/*.d.ts',
  'tools.d/**/*.js',
  'eslint.config.js',
  'vitest.config.ts',
];

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

  // packages/agent-core is only "reusable" if it does not know about this game. That claim is
  // worth exactly as much as its enforcement: a directory that merely *looks* separate gets
  // punctured the first time someone is in a hurry, and nobody notices until the day they try to
  // reuse it. So the boundary is a lint error, not a convention.
  {
    files: ['packages/agent-core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Anything climbing out of the package: the app's src/, its config, its retrieval and
              // ingestion layers, or the package's own published name (which would be a cycle).
              group: ['**/src/**', '../../../*', '@rwr/*'],
              message:
                'agent-core must not import the RWR domain (config, retrieval, ingestion, indexing, game tools). ' +
                'Whatever it needs, the domain passes in — see the host parameter on the plugin loader for the pattern.',
            },
          ],
        },
      ],
    },
  },

  // Must stay last: turns off formatting rules that conflict with Prettier and
  // adds no checks of its own.
  prettier,
);
