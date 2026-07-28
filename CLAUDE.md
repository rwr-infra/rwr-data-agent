# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> A detailed `AGENTS.md` also exists. When the two disagree, trust this file.

## What this is

An AI agent over *Running With Rifles* game data: a Fastify server exposing an **OpenAI-compatible** `/v1/chat/completions` endpoint, plus a Svelte chat UI. Retrieval is a **local in-process index** (MiniSearch full-text + an entity graph), built directly from the game files on disk. There is **no database** — no Postgres, no pgvector, no embeddings.

## Critical conventions

- **ESM only** (`"type": "module"`, `NodeNext` resolution). All relative imports use `.js` extensions even from `.ts` source. The `~/*` path alias is mapped in tsconfig but **unused in practice** — follow the relative-import style.
- Strict TypeScript. No test framework; correctness is checked via the eval harness (`npm run eval`) and curl smoke tests.
- ⚠️ `npm run lint` is broken: ESLint 10 requires an `eslint.config.js`, and this repo has none. Use `npx tsc --noEmit` as the real check.

## Getting started

```bash
cp .env.example .env      # fill in LLM_API_KEY
npm install
npm run dev               # index is built automatically on first boot
```

That is the whole setup. `DATA_DIR` (default `./data`) is the only other knob most people touch.

## Commands

```bash
npm run dev            # backend hot-reload (tsx) — src/api/server.ts
npm run web:dev        # frontend dev server (vite :5173, proxies /v1 + /health)
npm run build          # tsc → dist/  AND  vite build web/ → public/
npm start              # node dist/api/server.js

npm run build:index    # explicit index rebuild (also runs automatically at startup)
npm run validate:index # smoke-test the graph tools against the built index
npm run eval           # retrieval eval harness → src/eval/run.ts
```

`build:index` flags: `-s/--source <dir>` (default `DATA_DIR`), `-o/--output <dir>` (default `OUTPUT_DIR`), `--only <pkg,pkg>` to restrict to specific packages.

## Data model: packages, not tables

A RWR **package** is any directory containing `package_config.xml`. `DATA_DIR` points at either:

- a single package — `./data/GFL_Castling`, or (as configured by default) `./data`, whose only child is a package; or
- a directory of packages — `./ww2-data` holds `ww2_base`, `edelweiss`, `pacific`, `ww2_combined`, `ww2_invasion`.

`discoverPackages()` (`src/ingestion/packages.ts`) looks at the root and its **immediate children only**. That non-recursion is deliberate: `ww2_base/packages/<overlay>/` subtrees belong to `ww2_base` and must not become packages of their own.

Every indexed document is tagged with its package directory name as `mod`. Requests may narrow retrieval to one package via `body.mod`; `GET /v1/packages` lists what is available. (This replaced the old `DATABASE_TABLE` / `body.table` / `GET /v1/tables` mechanism, which is gone.)

## Architecture

### Entry points & app factory
- `src/app.ts` — `buildApp()`: awaits `ensureIndexes()`, then registers CORS, `/v1/*` routes, `/health`, and static serving. Used by both entry points.
- `src/api/server.ts` — local dev entry (`app.listen()`).
- `src/index.ts` / `api/index.ts` — Vercel serverless entry (exports the Fastify instance, no `listen`).
- Static serving is environment-split: **local** uses `@fastify/static` over `public/` with an SPA fallback to `index.html`; **Vercel** (`process.env.VERCEL`) reads `public/index.html` manually.

### Index lifecycle (`src/indexing/`)
- `build.ts` — `buildIndexes()`: discover packages → `buildGraph()` → write `graph.json` + `script-symbols.json` → `buildSearchIndex()` → write `search-index.json`. Shared by the CLI and the startup path.
- `bootstrap.ts` — `ensureIndexes()`: loads the index header, rebuilds when it is missing, was built from a different `DATA_DIR`, has a stale version, or the data fingerprint (file count + max mtime) moved. Then warms the index into memory. **Never throws** — failures degrade to a warning and surface via `/health`.
- On Vercel the data directory is not bundled, so bootstrap only ever loads what shipped (`vercel.json` `includeFiles` covers `output/**`).
- `AUTO_BUILD_INDEX=false` disables the automatic rebuild.

### Frontend (`web/` → builds into `public/`)
Svelte 5 + Vite + Tailwind 4 + daisyUI. `vite build` outputs to `../public`, which the backend serves — treat `public/` as **build output**, not hand-written. `web/vite.config.ts` reads `PORT` from the repo-root `.env` so its proxy always follows the backend.

### Request pipeline (`src/api/routes/chat.ts`)
1. **External `system` messages are dropped** — the server enforces its own `SYSTEM_PROMPT` (`src/retrieval/prompt.ts`). Anti-injection.
2. Token-size guard rejects oversized requests (~`maxContextTokens * 0.7`).
3. **Session memory**: `x-session-id` header keys a rolling summary (`src/memory/summarizer.ts`, an in-process `Map`); summaries regenerate every `SUMMARY_INTERVAL_TURNS`.
4. **Meta-query detection** (`isMetaQuery`) short-circuits search for questions about the bot itself.
5. **Query rewrite** (`src/retrieval/queryRewrite.ts`) enriches the query with conversation history, the session summary, and CN↔EN synonym expansion.
6. **Search** — `src/retrieval/localSearch.ts`, optionally filtered by `body.mod`.
7. **Agent tools** — the LLM gets the seven built-in entity-navigation tools plus any loaded plugins (`src/agent/toolDefs.ts`), re-queried per request so hot-reloaded plugins take effect.
8. **Structured vs text output**: when the query is classified `enumeration`/`comparison` AND the request sets `response_format: json_object` (or the `x-response-format` header), it uses `streamObject` with `EnumResultSchema`/`ComparisonResultSchema` (`src/types/schemas.ts`); otherwise `streamText`.

### ⚠️ Streaming is custom NDJSON, not OpenAI SSE
Each line is one JSON object with a `type`: `text-delta`, `reasoning-delta`, `json-delta`, `finish`, `error`. The frontend (`web/src/App.svelte`) consumes this format.

### Retrieval internals (`src/retrieval/localSearch.ts`)
- One MiniSearch index over `key`, `name`, `i18nNames`, `content`, `type`; loaded from `output/search-index.json` as a process-lifetime singleton.
- **i18n is indexed.** During the build, `resolveI18n()` runs per package against that package's own `languages/` directory, and the resolved names land in `i18nNames`. Only `cn`/`en` are indexed — the other eight languages ship as ISO-8859-1 and read back as mojibake, and indexing all of them dilutes term frequencies.
- **CJK tokenization**: `tokenize()` splits CJK runs into unigrams + bigrams so Chinese queries match without a dictionary segmenter. Applied to queries and to the short fields (`key`/`name`/`i18nNames`/`type`) **but not to `content`** — expanding content would drown real hits in noise from the game's large localized text blobs. Fuzzy and prefix matching are disabled for CJK terms.
- Filters (`type`, `faction`, `weapon_class`, `mod_name`) are applied post-search on stored fields.

### Agent tools: built-ins + runtime plugins (`src/agent/`)
`toolDefs.ts` exposes `getAgentTools()` — an **async registry** of the seven built-in graph tools (`tool()` + zod) merged with plugins loaded from `TOOLS_DIR` (default `./tools.d`).

A plugin is a plain ESM **`.js`** file (never `.ts` — production runs `node dist/…`, no transpiler) whose default export is `(host) => PluginToolSpec[]`. Specs carry a **JSON Schema** `inputSchema` and get wrapped with `dynamicTool()` + `jsonSchema()`, so plugin files never import zod. `types/tool-plugin.d.ts` is the authoring contract; `tools.d/lookup-upgrade.js` is the reference implementation.

- `host` (`plugins.ts` `createToolHost()`) injects `config` paths, `search()`, and the raw graph primitives, so plugins never reach into internal modules.
- Failure is isolated: a plugin that throws at load or at execute is logged and skipped; the rest of the registry keeps working.
- A plugin **cannot shadow a built-in tool name** — the collision is reported and the plugin definition dropped.
- Hot reload (`TOOLS_HOT_RELOAD`, on outside production) watches the directory and flips a dirty flag; the actual reload happens when the next request asks for tools, so in-flight streams are never swapped. Reloading works via an `import(url + '?v=<mtime>')` cache-buster — the ESM module cache cannot be purged, so each reload leaks the previous module. That is why hot reload defaults off in production.
- `GET /v1/tools` reports the inventory (built-ins, plugin entries, per-file errors).

⚠️ Plugins run **in-process with the server's full privileges**. This is an operator-drops-a-file trust model, not a sandbox — untrusted plugin sources would need `worker_threads` isolation, which the loader deliberately does not implement.

### Graph index (`src/agent/`)
`graphBuilder.ts` walks every package and emits nodes (entities keyed by `key`/`name`) and six edge relations (`extends`, `fires`, `transforms_to`, `includes`, `next_in_chain`, `references`). Node `file` paths are relative to the **data root**, not the package dir, so a single `dataRoot` serves the `readSource` tool across packages. `resolveFilePath` tries the referring file's directory → its package root → the data root, which is what makes cross-package overlay references resolve.

### Ingestion parsers (`src/ingestion/`)
`shared.ts` walks the tree (skipping `models/` and `maps/`) and dispatches by extension to `xmlParser.ts` (`.weapon/.projectile/.call/.character/.xml`, with inheritance resolution), `asParser.ts` (`.as` AngelScript), or a plain-text fallback. `i18n.ts` loads translations from a package's `languages/` dir. There is no separate extract/embed stage any more — parsing feeds the index builder directly.

**AngelScript** (`asSymbols.ts`, shared by `asParser.ts` and `graphBuilder.ts`): a line/brace scanner over comment- and string-blanked source, not a parser. It handles multi-line signatures, default-valued parameters, class members, ctor/dtor, `enum`/`namespace`/`funcdef`. Every `.as` file becomes exactly one `script_chunk` document.

Two things to know before touching it:
- `structuredDocToRWRDocument` only puts `raw_text.slice(0, 500)` into the searchable content, so the symbol summary is written into `description` + `flat_attributes` (`classes`, `functions`, `includes`, …) instead — those are rendered in full. That is what makes "which script defines X" answerable by search rather than only by the `getScriptSymbols` tool.
- There used to be an `extractSoldierBlocks` heuristic here. It matched AngelScript generics (`array<string>`, `dictionary`) as if they were XML tags, emitted junk `soldier` documents keyed `string`/`float`, and **discarded the whole script body**. Real soldier data comes from faction XML. Do not reintroduce tag-shaped matching over `.as`.

Swapping in a real grammar (tree-sitter) later means replacing `extractScriptSymbols(source, fileBase)` and nothing else. No AngelScript tree-sitter grammar is published to npm today, so it would mean vendoring a self-built `.wasm`.

### Cross-cutting
- **Observability** (`src/observability/langfuse.ts`, `src/instrumentation.ts`): Langfuse OTel tracing wraps the chat chain (search/generation spans), gated by `LANGFUSE_ENABLED`.

## Key environment variables
`LLM_API_KEY` is the only required one. Notable optional knobs (all in `src/config/index.ts`): `DATA_DIR`, `OUTPUT_DIR`, `GRAPH_PATH`, `SEARCH_INDEX_PATH`, `AUTO_BUILD_INDEX`, `TOOLS_DIR`, `TOOLS_HOT_RELOAD`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_MAX_OUTPUT_TOKENS`, `MAX_CONTEXT_TOKENS`, `SUMMARY_INTERVAL_TURNS`, `LANGFUSE_*`, `PORT`.
