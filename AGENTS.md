# AGENTS.md

## Project Overview

An AI agent over *Running With Rifles* game data. Fastify server, **OpenAI-compatible** `/v1/chat/completions`, Svelte 5 chat UI. Retrieval is a **local in-process index** built straight from the game files: MiniSearch full-text + an entity graph the LLM can walk with tools.

**There is no database.** Postgres, pgvector, embeddings, reranking and the two-stage extract/embed pipeline were all removed — the only external service is the LLM endpoint.

## Critical Conventions

- **ESM only** (`"type": "module"`, `NodeNext`). Relative imports carry `.js` extensions even in `.ts` sources. The `~/*` tsconfig alias exists but is unused — follow the relative-import style.
- Strict TypeScript. No unit-test runner; `npm run eval` + curl smoke tests are the correctness net.
- ⚠️ `npm run lint` fails — ESLint 10 needs an `eslint.config.js` and there is none. Use `npx tsc --noEmit`.

## Developer Commands

```bash
npm run dev             # backend hot-reload (tsx) — src/api/server.ts
npm run web:dev         # vite :5173, proxies /v1 + /health to the backend
npm run build           # tsc → dist/  AND  vite build web/ → public/
npm start               # node dist/api/server.js

npm run build:index     # rebuild graph + search indexes
npm run build:index:prod
npm run validate:index  # smoke-test the 7 graph tools against the built index
npm run eval            # retrieval eval harness → src/eval/run.ts
npm run format          # Prettier
```

## Running Locally

```bash
cp .env.example .env    # fill LLM_API_KEY
npm install
npm run dev             # indexes build automatically on first boot
```

No ordering constraints, no migrations, no docker prerequisite.

## Packages: the unit of data isolation

A **package** is a directory containing `package_config.xml`. `DATA_DIR` (default `./data`) is either one package or a directory of them.

`discoverPackages()` (`src/ingestion/packages.ts`) checks the root, then its immediate children, and stops. Non-recursion is load-bearing: `ww2_base/packages/{edelweiss,pacific,ww2_undead}/` are overlays owned by `ww2_base`, not separate packages. `displayName` comes from `<package name="…">`, falling back to the directory name (`ww2_invasion` ships a bare `<package />`).

Each document's `mod` is the package directory name. A request narrows retrieval with `body.mod`; `GET /v1/packages` enumerates them.

> This replaced the old `DATABASE_TABLE` / `body.table` / `GET /v1/tables` scheme. There is no `table` concept anywhere in the codebase now.

## Index Lifecycle (src/indexing/)

`buildIndexes()` (`build.ts`) — discover packages → `buildGraph()` → write `graph.json` + `script-symbols.json` → `buildSearchIndex()` → write `search-index.json`. Used by both the CLI and startup.

`ensureIndexes()` (`bootstrap.ts`) runs at the top of `buildApp()` and rebuilds when:
- the index file is missing,
- `version` ≠ `INDEX_VERSION`,
- `data_dir` in the header ≠ current `DATA_DIR`,
- the data fingerprint (file count, max mtime) moved.

Then it warms the index into memory. It **never throws** — failures become a console warning and are reported by `GET /health`. On Vercel it skips building entirely (the data dir is not bundled) and only loads what shipped.

`AUTO_BUILD_INDEX=false` disables auto-rebuild; the CLI then becomes mandatory.

Output files (in `OUTPUT_DIR`, gitignored):
- `graph.json` — nodes + edges, `version: 2`, with a `packages[]` header
- `script-symbols.json` — AngelScript function/class/include signatures with line numbers
- `search-index.json` — `version: 2`, header carries `data_dir`, `packages[]`, `fingerprint`, then `entries[]`

## Search Index (src/retrieval/localSearch.ts)

MiniSearch over `key`, `name`, `i18nNames`, `content`, `type`. Boosts: key 3, name 2.5, i18nNames 2.5, content 1.

**i18n is part of the index.** The builder runs `resolveI18n()` per package against that package's own `languages/` dir — this is what fixed the old `findLanguagesDir` bug where a multi-package root resolved to the first `languages/` it found and silently dropped the rest. Only `cn`/`en` are indexed: the other eight ship as ISO-8859-1 (mojibake when read as UTF-8) and indexing all ten dilutes term frequencies.

**CJK tokenization.** `tokenize(text, fieldName?)` splits CJK runs into unigrams + bigrams so Chinese matches without a segmenter. Scoped to queries and the short fields (`key`/`name`/`i18nNames`/`type`) — **not `content`**, because the game's large localized text blobs (`journal`, `ui`, `*.text_lines`) contain nearly every Chinese character and would swamp real hits. Fuzzy and prefix matching are turned off for CJK terms for the same reason.

Filters (`type`, `faction`, `weapon_class`, `mod_name`) are applied post-search against stored fields.

## Graph Index & Agent Tools (src/agent/)

A file-system + relationship overlay covering what full-text search cannot: locating source files, tracing inheritance, querying AngelScript symbols.

Node `file` paths are relative to the **data root** (not the package dir), so one `dataRoot` serves `readSource` across every package. `resolveFilePath` tries, in order: the referring file's directory → its package root → the data root — which is how cross-package overlay references resolve.

**Edge types extracted:**

| Relationship | Meaning | Example |
|---|---|---|
| `extends` | XML `file="parent"` inheritance | `<weapon file="base_primary.weapon">` |
| `fires` | Weapon→projectile reference | `<projectile file="556.projectile">` |
| `transforms_to` | Carry item degradation chain | `transform_on_consume="K309_1"` |
| `includes` | Call file aggregation | `<calls><call file="x.call"/></calls>` |
| `next_in_chain` | Weapon mode switching | `<next_in_chain key="m4_gl"/>` |
| `references` | Generic weapon file include | `<weapon file="..."/>` inside other elements |

**Built-in tool functions** (`src/agent/tools.ts`, in-process, no external service):
- `getInheritanceChain(key)` — full parent chain with depth
- `findReferences(key)` — reverse lookup: who points to this entity
- `getTransformChain(key)` — armor/item degradation layers
- `readSource(file, startLine?, endLine?)` — read raw source with a path-traversal guard
- `listFiles(pattern, type?)` — glob search over indexed nodes
- `getScriptSymbols(file)` — AngelScript signatures
- `getNode(key)` — basic entity lookup

Wrapped as AI SDK `tool()` definitions in `toolDefs.ts` and passed to `streamText({ tools, stopWhen: stepCountIs(100) })`. Tool-call/result events stream to the frontend as `tool-step` NDJSON lines.

## Tool Plugins (src/agent/plugins.ts, TOOLS_DIR)

`getAgentTools()` is an async registry: built-ins ⊕ plugins discovered in `TOOLS_DIR` (default `./tools.d`). Mod-specific tools belong here, not in the core set — `tools.d/lookup-upgrade.js` (Castling weapon upgrade chains) is the reference implementation.

A plugin is a plain ESM **`.js`** file — not `.ts`, because production runs `node dist/…` with no transpiler in the loader chain. Its default export is `(host) => PluginToolSpec[]`:

```js
/** @type {import('../types/tool-plugin.js').PluginFactory} */
export default function register(host) {
  return [{
    name: 'myTool',                                  // may not shadow a built-in
    description: 'What the model should use it for.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async execute({ q }) { return host.search(q); },
  }];
}
```

- **JSON Schema, not zod** — specs are wrapped with `dynamicTool()` + `jsonSchema()`, so plugin files carry no dependency on the host's zod version. `types/tool-plugin.d.ts` gives JSDoc-based autocompletion.
- **`host`** (`createToolHost()`) injects `config` paths, `search()`, and the raw graph primitives — a plugin never imports internal modules.
- **Failure is isolated.** A load-time throw or an execute-time throw is logged, recorded on the `/v1/tools` entry, and skipped; other tools are unaffected. An execute error is returned to the model as `{ error }` rather than breaking the stream.
- **No shadowing.** A plugin whose `name` matches a built-in is rejected, so an external file cannot hijack core behaviour.
- **Hot reload** (`TOOLS_HOT_RELOAD`, defaults on outside production / off on Vercel): `fs.watch` + 300ms debounce sets a dirty flag; the reload itself happens when the next request asks for tools, so an in-flight stream is never swapped. It works via `import(url + '?v=<mtime>')` — the ESM module cache cannot be purged, so each reload leaks the previous module. That is why it defaults off in production.
- **`GET /v1/tools`** reports `{ builtin, plugins[], toolsDir, hotReload }` with per-file errors. Hot reload without this is undebuggable.

⚠️ **Trust model.** Plugins are `import()`ed into the server process and run with its full privileges — filesystem, network, `process.env`. This is fine for files an operator placed themselves. It is **not** a sandbox: never wire plugin loading to untrusted uploads. That would require `worker_threads` isolation, which this loader deliberately does not implement.

## Parsers (src/ingestion/)

- **Excluded dirs**: `models/`, `maps/` (skipped by `collectFiles`).
- **Supported extensions**: `.weapon`, `.projectile`, `.carry_item`, `.base_weapon`, `.base_carry_item`, `.animation_base`, `.base`, `.call`, `.character`, `.xml` → XML parser (with `file=` inheritance resolution); `.as` → AngelScript parser; `.ai`, `.resources`, `.models`, `.name`, `.text_lines` → plain-text fallback.
- `i18n.ts` loads `<translation><text key="…" text="…"/>` files from a package's `languages/<lang>/` dirs, following `file=` indirections.

Parsed `StructuredDocument`s feed the index builder directly — there is no intermediate `extracted-documents.json` stage any more.

### AngelScript (`asSymbols.ts`)

One implementation shared by `asParser.ts` (documents) and `graphBuilder.ts` (`script-symbols.json`). A line/brace scanner over comment- and string-blanked source — deliberately not a parser. Handles multi-line signatures, default-valued parameters, class members and ctor/dtor, `enum` / `namespace` / `funcdef`, and tracks the enclosing container as `ScriptSymbol.parent`.

Every `.as` file becomes exactly **one** `script_chunk` document. Because `structuredDocToRWRDocument` only feeds `raw_text.slice(0, 500)` into the searchable content, the symbol summary is written into `description` + `flat_attributes` (`classes`, `functions`, `includes`, `enums`, `funcdefs`, `properties`, capped at 120 names each) — those are rendered into the content in full. That is what makes "which script defines X" / "what includes Y" answerable by search instead of only via `getScriptSymbols`.

**Historical trap:** an `extractSoldierBlocks` heuristic used to match `<tag>…</tag>` inside `.as`. It was actually matching AngelScript generics (`array<string>`, `dictionary`), emitting junk `soldier` documents keyed `string`/`float`/`int`, and returning early so the entire script body never reached the index — 16 of 108 files were invisible. Real soldier data comes from faction XML. Never reintroduce tag-shaped matching over `.as`.

**On tree-sitter:** worth it only when call graphs, cross-file symbol resolution, or `#include` dependency graphs are needed. No AngelScript grammar is published to npm ([Relrin/tree-sitter-angelscript](https://github.com/Relrin/tree-sitter-angelscript) is the most complete but must be cloned and built), so adopting it means vendoring a self-built `.wasm` for `web-tree-sitter`. The migration surface is one function: `extractScriptSymbols(source, fileBase)`.

## Architecture

### Entry Points
- `src/app.ts` — `buildApp()`: `await ensureIndexes()`, CORS, `/v1/*`, `/health`, static serving.
- `src/api/server.ts` — local entry (`app.listen`).
- `src/index.ts` / `api/index.ts` — Vercel serverless entry (no `listen`).
- Static serving splits on `process.env.VERCEL`: locally `@fastify/static` over `public/` with an SPA fallback; on Vercel `public/index.html` is read manually.

### Routes
| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | Main endpoint. Extra fields: `mod`, `response_format` |
| `GET /v1/models` | Model list |
| `GET /v1/packages` | Packages in the current index (`name`, `displayName`, `count`) |
| `GET /v1/tools` | Tool inventory: built-ins, plugin entries with per-file errors, `toolsDir`, `hotReload` |
| `GET /health` | `{status, index:{ready, documents, packages, builtAt, reason?}}` — no external check |

### Request pipeline (src/api/routes/chat.ts)
1. External `system` messages dropped; server enforces `SYSTEM_PROMPT`. Anti-injection.
2. Token-size guard at ~`maxContextTokens * 0.7`.
3. `x-session-id` keys a rolling summary (`src/memory/summarizer.ts`, in-process `Map`, never persisted).
4. `isMetaQuery` short-circuits search for questions about the bot.
5. `buildSearchQuery` merges history + summary + CN↔EN synonym expansion.
6. `localSearch(query, filters, topK, enrichedQuery)` — `topK` 150 for enumeration, else 60.
7. `streamText` with graph tools, or `streamObject` with `EnumResultSchema`/`ComparisonResultSchema` when the query is enumeration/comparison **and** `response_format: json_object` (or `x-response-format`) is set.

### Streaming format
Custom **NDJSON**, not SSE. One JSON object per line, keyed by `type`: `text-delta`, `reasoning-delta`, `json-delta`, `tool-step`, `finish`, `error`.

### Frontend
Svelte 5 + Vite + Tailwind 4 + daisyUI in `web/`, building into `public/` — treat `public/` as generated. `web/vite.config.ts` reads `PORT` from the repo-root `.env` via `loadEnv`, so the dev proxy always follows the backend port. The Header's dropdown is a package filter fed by `GET /v1/packages`; it hides itself when there is only one package.

## Environment & Config

`LLM_API_KEY` is the only required variable (`SILICONFLOW_API_KEY` is still accepted as a fallback for older `.env` files). Everything else has a default in `src/config/index.ts`:

| Variable | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://api.siliconflow.cn/v1` | |
| `LLM_MODEL` | `deepseek-v4-flash` | |
| `DATA_DIR` | `./data` | Single package or directory of packages |
| `OUTPUT_DIR` | `./output` | |
| `GRAPH_PATH` / `SEARCH_INDEX_PATH` | `<OUTPUT_DIR>/…` | Individual overrides |
| `AUTO_BUILD_INDEX` | `true` | |
| `TOOLS_DIR` | `./tools.d` | Runtime tool plugins; skipped if absent |
| `TOOLS_HOT_RELOAD` | on outside prod, off on Vercel | Watch `TOOLS_DIR` and reload on the next request |
| `PORT` | `3000` | |
| `MAX_CONTEXT_TOKENS` | `500000` | |
| `LLM_MAX_OUTPUT_TOKENS` | `32768` | Reasoning + answer share this budget |
| `LLM_REASONING_EFFORT` / `LLM_THINKING_ENABLED` / `LLM_TEMPERATURE` | unset | Omitted from the request when unset |
| `SUMMARY_INTERVAL_TURNS` / `SUMMARY_MODEL` | `3` / `LLM_MODEL` | |
| `LANGFUSE_*` | disabled | |

## Deployment

### Docker
`docker compose up -d --build` — a single `app` service. `./data` mounts read-only at `/app/data`; `./output` is a writable volume so restarts skip the rebuild; `./tools.d` mounts read-only at `/app/tools.d`.

### Vercel
`vercel.json` bundles `dist/**`, `public/**`, `output/**`, `tools.d/**` into the function. The data directory is not uploaded, so the index must exist before deploy — `ensureIndexes()` will only load, never build, when `VERCEL` is set. Plugins load once per cold start; hot reload is off.

## Testing

- `npm run eval` — 30-case retrieval harness over `tests/eval/dataset.json`, writes a timestamped report into `tests/eval/`. Note the dataset references some keys that no longer exist in the current `./data` snapshot, so absolute recall understates real quality; track deltas, not the absolute number.
- `npm run validate:index` — exercises all 7 graph tools, picking real sample keys out of the built graph so it works against any data directory.

## Style

Prettier defaults, no config file. Match the surrounding code.
