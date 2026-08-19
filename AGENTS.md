# AGENTS.md

> This is the single source of truth for agent guidance in this repository. `CLAUDE.md` is a pointer to this file.
>
> **Decisions** — why things are the way they are, and what was deliberately rejected — live in `adr/`, alongside a glossary for the terms that are easy to conflate (`turn` vs `step`, spend vs occupancy, `package` vs `mod`, trigger vs skill). Like `docs/`, that directory is **gitignored and local-only**, so this file stays the single source of truth: anything a fresh clone must know belongs here, not only there.

## Project Overview

An AI agent over *Running With Rifles* game data. Fastify server, **OpenAI-compatible** `/v1/chat/completions`, Svelte 5 chat UI. Retrieval is a **local in-process index** built straight from the game files: MiniSearch full-text + an entity graph the LLM can walk with tools.

**There is no database.** Postgres, pgvector, embeddings, reranking and the two-stage extract/embed pipeline were all removed — the only external service is the LLM endpoint.

## Layout: `packages/agent-core` vs the app

The repo is an npm workspace. `packages/agent-core` (`@rwr/agent-core`) holds the parts that are not about this game:

| Module | What |
|---|---|
| `steering/` | The in-flight turn registry — `createTurn` / `steerTurn` / `stopTurn` / `endTurn` |
| `session/` | `createMemorySessionStore(ttlMs)` — keyed per-session state that evicts |
| `plugins/` | The plugin loader: discovery, validation, per-file failure isolation, trigger normalization |
| `skills/` | The skill loader and `selectSkills` — frontmatter, mandatory triggers, body cap |
| `reload/` | `createReloadGate()` — the staleness counter both loaders need, and the reason it is not a `dirty` boolean |
| `transport/` | `PROTOCOL_VERSION`, the NDJSON event union, `encodeEvent` |

**The loop is deliberately not in it.** The AI SDK already ships one, and re-implementing it would buy nothing — see [Step budget](#step-budget-max_tool_steps-default-100) and the SDK's `ToolLoopAgent`.

**The one architectural rule: `agent-core` may not import a domain module** (`config`, `retrieval/`, `ingestion/`, `indexing/`, `agent/tools.ts`). This is enforced by `@typescript-eslint/no-restricted-imports` in `eslint.config.js`, not by convention — the rule *is* the evidence that the package is reusable, and a directory that merely looks separate gets punctured the first time someone is in a hurry. Whatever the core needs, the domain passes in: `loadToolPlugins({ dir, host, reservedNames })` is the pattern, with `ToolHost` and `createToolHost` staying in `src/agent/plugins.ts`.

Two consequences worth knowing before you build:

- **The package builds first — in every script that resolves it.** `lint`, `test`, `typecheck` and `build` all start with `build:core`, because the root program reaches `@rwr/agent-core` through `node_modules` to the package's *emitted* `dist/` — `.d.ts` for the type-aware tools, `.js` for vitest. Miss it in any one of them and that script fails on a tree where the package has never been built, in a way that names anything but the cause: `tsc` says "cannot find module", vitest says the import failed, and ESLint says nothing about modules at all — it reports several hundred `no-unsafe-*` errors in the *consumer* files, because `projectService` resolved the import to an error type and every use of it then looks unsafe. That last one is why this bullet lists the scripts individually: it cost a red CI run that read as a code-quality problem in `src/`.
  - Adding a script that typechecks or imports the package means adding `build:core` to it too. If you ever want to drop the requirement, the only real fix is making the root program typecheck against the package's *source* (path mapping or project references) — but the root `tsconfig.json` pins `rootDir: ./src` for emit, so that is a build-layout change, not a one-liner.
- **`private: true`, version `0.0.0`, not published.** The workspace gives the boundary its teeth today; publishing would additionally promise API stability, and the API has not been used by anyone yet. Publishing is one `package.json` edit away when it has.

## Critical Conventions

- **ESM only** (`"type": "module"`, `NodeNext`). Relative imports carry `.js` extensions even in `.ts` sources. The `~/*` tsconfig alias exists but is unused — follow the relative-import style.
- Strict TypeScript. Three nets, in ascending cost: `npm run test` (vitest, pure functions only — deterministic, no LLM), `npm run eval` (retrieval, no LLM), `npm run eval:agent` (real tool loop, spends quota). See [Testing](#testing).
- `npm run lint` (ESLint 10 flat config, `eslint.config.js`), `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build` are all green and all gated in CI. Type-aware ESLint rules (`recommendedTypeChecked`) apply to `src/`; `api/`, `types/`, `tools.d/` get syntax-layer checks only — `api/` imports from the gitignored `dist/`, so type-aware rules there would depend on having built first. `web/` is out of ESLint's scope (its own Svelte toolchain) but **not** out of typecheck's: `typecheck` ends with `npm run web:check` → `svelte-check`, because `vite build` compiles `.svelte` without typechecking it, so a UI type error surfaces there or nowhere.

## Developer Commands

```bash
npm run dev             # backend hot-reload (tsx) — src/api/server.ts
npm run web:dev         # vite :5173, proxies /v1 + /health to the backend
npm run web:install     # npm install inside web/
npm run build           # tsc → dist/  AND  vite build web/ → public/
npm start               # node dist/api/server.js

npm run build:index     # rebuild graph + search indexes (also runs automatically at startup)
npm run build:index:prod # same, from dist/ (no tsx)
npm run validate:index  # smoke-test the 7 graph tools against the built index
npm run test            # vitest over tests/unit/ — pure functions, no LLM calls, ~1s
npm run test:watch      # same, in watch mode
npm run eval            # retrieval eval harness → src/eval/run.ts (no LLM calls)
npm run eval:agent      # tool-loop eval → src/eval/agent.ts (spends LLM quota)

npm run lint            # eslint . --max-warnings 0
npm run lint:fix        # same, with --fix
npm run typecheck       # tsc --noEmit for src/, tsc -p tests, then svelte-check over web/
npm run web:check       # svelte-check alone (needs `npm run web:install` first)
npm run format          # Prettier over src/ types/ tools.d/ tests/ packages/
npm run format:check    # same, check-only
```

`build:index` flags: `-s/--source <dir>` (default `DATA_DIR`), `-o/--output <dir>` (default `OUTPUT_DIR`), `--only <pkg,pkg>` to restrict to specific packages.

⚠️ ESLint's ignore list is generated from `.gitignore` via `@eslint/compat`'s `includeIgnoreFile()` — **add new build/data directories to `.gitignore`, not to `eslint.config.js`**. The `web/` entry is the one manual addition (it is version-controlled). Directory patterns must keep their trailing slash: `data/` prunes the whole tree, `data/**` does not and makes ESLint walk ~24k game-data files.

## Running Locally

```bash
cp .env.example .env    # fill LLM_API_KEY
npm install
npm run dev             # indexes build automatically on first boot
```

That is the whole setup — no ordering constraints, no migrations, no docker prerequisite. `DATA_DIR` (default `./data`) is the only other knob most people touch.

## Packages: the unit of data isolation

A **package** is a directory containing `package_config.xml`. `DATA_DIR` (default `./data`) is either one package or a directory of them.

`discoverPackages()` (`src/ingestion/packages.ts`) checks the root, then its immediate children, and stops. Non-recursion is load-bearing: `ww2_base/packages/{edelweiss,pacific,ww2_undead}/` are overlays owned by `ww2_base`, not separate packages. `displayName` comes from `<package name="…">`, falling back to the directory name (`ww2_invasion` ships a bare `<package />`).

Each document's `mod` is the package directory name. A request narrows retrieval with `body.mod`; `GET /v1/packages` enumerates them.

> This replaced the old `DATABASE_TABLE` / `body.table` / `GET /v1/tables` scheme. There is no `table` concept anywhere in the codebase now.

### `body.mod` scopes the whole turn, not just retrieval

`body.mod` used to filter only the pre-fetch. The tool loop then ran unscoped, so the agent routinely answered a Castling question out of vanilla — **1351 keys are defined in more than one package** (`gas_tank.vehicle`, `base_valuable.carry_item`, `tracker`, …), and `findNode` returned whichever came first in the node array.

The scope now threads through everything (`packageScope` in `chat.ts`):

| Layer | How it is scoped |
|---|---|
| Pre-fetch | `mod_name` filter, as before |
| Built-in tools | `getAgentTools(scope)` → `buildBuiltinTools(scope)` closes the package over every `execute` |
| Plugin tools | `createToolHost(scope)` binds `host.search` and every `host.graph.*`, so a plugin is scoped without knowing it exists |
| System prompt | `buildSystemPrompt(mod)` appends the Package Scope section |
| User prompt | `buildUserPrompt(…, { mod })` marks the context and the absence instruction |

**The scope is not a tool argument.** It is closed over, so the model cannot widen it — that is the point. Do not add a `mod` parameter to a tool's `inputSchema`.

Because the registry is now per scope, `getAgentTools` caches a `Map<scope, registry>` rather than one object. Keep it cached: `measureToolDefTokens` keys on the registry's object identity, so a fresh registry per request would re-measure every tool definition.

**What a scoped tool returns.** Filtering silently would make the model report a truncated list as complete, so every tool says what it withheld: `scope`, plus `otherPackageHits` (searchDocs), `omittedFromOtherPackages` (listFiles / findReferences), `otherPackages` (getNode), `outOfScope` (readSource). These are counts, never content — the prompt tells the model to offer a package switch instead of answering from them.

**Two deliberate crossings**, because scoping them would produce wrong answers rather than narrow ones:
- `getInheritanceChain` follows a parent into another package (a mod extending a vanilla base is where the effective value lives). Every layer carries its own `mod` and the walk continues with *that* layer's edges.
- `readSource` reads any path under the data root, flagging `outOfScope`. Every path the model has came from an already-scoped tool result.

### Graph edges carry their package (graph version 3)

`from`/`to` are bare keys, so a scoped traversal needs the edge itself attributed:

- `GraphEdge.mod` — package of the **referring** file. Also part of the edge dedup identity: two packages defining the same `key -> base` relationship are two edges, and collapsing them handed one package's relationship to the other.
- `GraphEdge.toMod` — package the `file=` reference **resolved to** at build time. Without it, an `extends` pointing at `base_valuable.carry_item` cannot say which of the packages defining that key it meant. Absent when the reference resolved to no file at all (~40% of edges) — `resolveEdgeTarget` then reports `ambiguousIn: [...]` instead of guessing, and the chain stops there.
- `ScriptSymbol.mod` — `ScriptSymbol.file` is a basename, so two mods shipping `ItemDropEvent.as` are otherwise the same symbol set.

Both fields are optional and an absent `mod` disables filtering, so a graph written before version 3 loads and behaves like the old unscoped build instead of returning nothing. `INDEX_VERSION` (search index) was bumped to force the rebuild — it is the only staleness signal `ensureIndexes()` checks, and a rebuild regenerates the graph too. It is now at 4, for the on-disk layout change described under [Index Lifecycle](#index-lifecycle-srcindexing).

Calling any tool without `mod` keeps the old global behaviour, which is what `validate.ts`, the CLI and the eval harness use.

## Index Lifecycle (src/indexing/)

`buildIndexes()` (`build.ts`) — discover packages → walk each package → **one pass** over the files → `graph.json` + `script-symbols.json` + the search index. Used by both the CLI and startup.

### One pass, one parse, streamed out

The build is shaped by what a 2 vCPU / 2 GB host can survive, because that is where it runs. Three properties are load-bearing; breaking any of them brings back a build that pinned ~1.2 GB and pegged both cores for minutes:

1. **Each file is read and XML-parsed exactly once**, and the resulting tree is handed to *both* consumers — `createGraphCollector()` (`agent/graphBuilder.ts`) and `parseContent()` (`ingestion/shared.ts`). Graph and search used to run separate passes with separate `XMLParser` instances over the same 4.6k files; that duplicate parse was ~40% of build CPU. `GraphCollector` is now the only way to build the graph and every parser takes content rather than a path, so there is no second implementation to drift into. Anything new that needs the tree gets it from this pass — do not add a second walk.
2. **Search entries are streamed to disk** through `createIndexWriter`, one line at a time, and dropped. Nothing accumulates a full `IndexEntry[]`, and nothing hands the index to `JSON.stringify`.
3. **The build never constructs a MiniSearch index.** It used to `addAll()` every entry and then throw the result away — the on-disk index is rebuilt from the body at boot regardless. Pure waste: 3.2s of tokenization and a few hundred MB.

`config.indexConcurrency` (`INDEX_CONCURRENCY`, default: cores clamped to [2, 4]) bounds how many files are in flight. It is a *memory* knob, not a throughput one — parsing is synchronous, so raising it past the core count only keeps more parse trees alive at once.

### Startup

`startIndexes()` (`bootstrap.ts`) is called by `buildApp()` **without being awaited**, so the port opens immediately instead of after a possible multi-minute rebuild. While it runs, `GET /health` reports `status: "building"` and `/v1/chat/*` answers 503 `index_unavailable` rather than searching an index that is not there. Callers that want a ready index instead of a live port — the eval harness — await `whenIndexesReady()`.

`ensureIndexes()` rebuilds when:
- the index header is missing or unparseable,
- `version` ≠ `INDEX_VERSION`,
- `data_dir` in the header ≠ current `DATA_DIR`,
- the data fingerprint (file count, max mtime) moved.

The staleness probe's own tree walk is handed to `buildIndexes()` (`filesByPackage` + `fingerprint`) instead of being thrown away — `walkFiles` is deterministic, so reusing it is equivalent to re-walking, and on a network-backed data volume a re-walk is thousands of round trips. Note the walk stays **per package**: a single walk from the data root is *not* equivalent, since the root may hold directories that are not packages.

It **never throws** — failures become a console warning and are reported by `GET /health`.

`AUTO_BUILD_INDEX=false` disables auto-rebuild; the CLI then becomes mandatory. On a small production host that is the recommended setup: build the index in a one-shot job and let the server only load it.

Output files (in `OUTPUT_DIR`, gitignored):
- `graph.json` — nodes + edges, `version: 3`, with a `packages[]` header
- `script-symbols.json` — AngelScript function/class/include signatures with line numbers
- `search-index.json` — **header only** (`version: 4`): `data_dir`, `packages[]`, `fingerprint`, `count`
- `search-index.ndjson` — the body, one `IndexEntry` per line

The split is why `readIndexMeta()` is cheap: every boot reads it before knowing anything about staleness, and it used to parse 46 MB of inline entries to look at one integer. It now reads a bounded prefix (1 MB) — a pre-v4 file fails to parse there and is reported as "no index", which is the right answer since the version check would have forced a rebuild anyway. `finish()` writes the body first and the header second, so a crash between them leaves a header whose fingerprint no longer matches the data, and the next boot rebuilds.

## Search Index (src/retrieval/localSearch.ts)

One MiniSearch index over `key`, `name`, `i18nNames`, `content`, `type`, built at boot by streaming `output/search-index.ndjson` line by line and `add()`ing each entry, held as a process-lifetime singleton. Boosts: key 3, name 2.5, i18nNames 2.5, content 1. Streaming rather than `readFile` + `JSON.parse` + `addAll` halves boot RSS (877 MB → 455 MB), because the body never exists as one string and the parsed entries are never an array.

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

Every one of them takes an optional trailing `mod` (the request's selected package) — see [`body.mod` scopes the whole turn](#bodymod-scopes-the-whole-turn-not-just-retrieval).

Wrapped as AI SDK `tool()` definitions in `toolDefs.ts` and passed to `streamText({ tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) })`. Tool-call/result events stream to the frontend as `tool-step` NDJSON lines.

### Tool execution envelope (src/agent/toolRuntime.ts)

`instrumentTools()` wraps **every** registered tool — built-ins and plugins alike — once per registry build. In order: reject a call that repeats an earlier one verbatim (`duplicate_call`), race `execute` against `TOOL_TIMEOUT_MS` and the request's `abortSignal`, and convert anything thrown into `{ error, hint }`. Nothing a tool throws escapes.

Two consequences worth knowing before touching this:
- **A failed tool arrives on the stream as `tool-result`, not `tool-error`** — success has to be read off the output shape via `isToolFailure()`. `tool-error` now only covers failures that never reach `execute` (schema validation, unknown tool name).
- **Do not add a `try/catch` inside a tool or plugin.** Catching there looks like success to the envelope and the error loses its recovery `hint`.

The duplicate guard is stateless: it scans `ToolCallOptions.messages`, which holds earlier steps' tool calls and results but not the call being executed. Per-request by construction, no shared state. Blind spot: calls issued in parallel *within one step* cannot see each other.

`repairToolCall` (wired as `experimental_repairToolCall`) remaps hallucinated coding-agent tool names — models reach for `grep`, `cat`, `ls` out of habit — onto the real graph tool via the `TOOL_ALIASES` table. Only unambiguous names are mapped, and only when the argument carries a usable string; anything else returns `null` so the SDK's `NoSuchToolError` proceeds and the model self-corrects from the tool list in its message. **Never add a write, shell, or exec name to that table** — the alias exists to save a wasted step, not to widen the tool surface.

### Tool transcript shaping (src/agent/toolTranscript.ts)

`prepareStep` runs `createToolTranscriptShaper().prepare()`. It always applies provider-compatibility rewrites (Volcengine rejects assistant messages with null content; a tool result of `undefined` serialises to nothing). It sheds old tool results **only** when a step's prompt would overflow `MAX_CONTEXT_TOKENS × TOOL_CONTEXT_BUDGET_RATIO` minus the system prompt, tool definitions and output reservation — with the default window, effectively never. Shedding drops whole array items and clips long strings, keeping valid JSON plus a `_shed` note; the newest result is never shed.

The shaper also records each step's measured `messages` size in `replay[]`, which `src/api/tokenAccounting.ts` uses to attribute the tool-transcript token slice from real measurements rather than a modelled rule.

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
- **`host`** (`createToolHost(scope)`) injects `config` paths, `search()`, and the raw graph primitives — a plugin never imports internal modules. `search` and `graph.*` are **pre-bound to the request's package**, so a plugin written before package scoping existed is scoped for free; `host.scope` is there for wording output or skipping work, not for opting out.
- **Failure is isolated.** A load-time throw or an execute-time throw is logged, recorded on the `/v1/tools` entry, and skipped; other tools are unaffected. An execute error is returned to the model as `{ error }` rather than breaking the stream.
- **No shadowing.** A plugin whose `name` matches a built-in is rejected, so an external file cannot hijack core behaviour.
- **Hot reload** (`TOOLS_HOT_RELOAD`, defaults on outside production): `fs.watch` + 300ms debounce bumps a generation counter; the reload itself happens when the next request asks for tools, so an in-flight stream is never swapped. It works via `import(url + '?v=<mtime>')` — the ESM module cache cannot be purged, so each reload leaks the previous module. That is why it defaults off in production.
  - **Staleness is a counter, not a flag, and it counts directory changes — not load attempts.** A load captures the generation before reading the directory and publishes only if it has not moved. Requests overlap (two concurrent chats; `GET /v1/tools` forces a load of its own), and with a boolean the loader that *started* first can finish last and overwrite the newer registry with the pre-change one — while the flag reads clean, so nothing ever reloads it again. The loser still returns its own result to its caller, one edit out of date; it just does not cache it. `src/agent/skills.ts` mirrors this exactly.
- **`GET /v1/tools`** reports `{ builtin, plugins[], skills[], toolsDir, skillsDir, hotReload }`, each list carrying its per-file errors. Hot reload without this is undebuggable.
  - It is the **unscoped** inventory, and only unscoped loads write it. A factory can branch on `host.scope` when it registers — returning different specs, or throwing for one package and not another — so a scoped load's entries describe that package rather than the deployment, and letting them land in the global inventory would report whichever scoped request happened to load last. The residual gap is deliberate: a plugin that fails *only* under some scope will not show that failure here, because the endpoint takes no scope parameter and has nowhere to put it.

## Skills (src/agent/skills.ts, SKILLS_DIR)

The third extension point, next to built-in tools and `tools.d` plugins. A **tool** is an action the model can take; a **skill** is knowledge about *how* to act — a playbook for one mod's quirks, a house style for a class of question. Adding one is dropping a markdown file in `SKILLS_DIR` (default `./skills.d`), not editing the prompt in this repo, which is what makes skills the main carrier for domain knowledge in a self-hosted deployment.

```markdown
---
name: inheritance-depth-order
triggers: [继承, 父类, inherit, extends]
---
Order the answer by depth, cite each layer's file, and say which layer won.
```

- **Triggers are mandatory here — the opposite of a plugin tool, and deliberately so.** Hiding a tool from the first step costs the model an option it can still ask for on a later one. Prose has no such recovery: an always-on skill is paid for in *every* turn's context whether or not it is relevant. A skill declaring no triggers is a configuration error, recorded and skipped — and so is one whose triggers are all blank, because "loads but can never be selected" is the same failure with none of the noise.
- **Bodies are capped at 16 000 characters** (~4K tokens), rejected at load time rather than truncated. The body goes into the system prompt of every matching turn, and the route rejects an oversized prompt with a 400 — so without the cap one long file turns every question that trips its triggers into a failed request, blaming the prompt rather than the file. Over the cap, split it into narrower skills with tighter triggers.
- Matching is the same case-insensitive substring check as `triggers` on a plugin tool — one mental model for "when does my extension fire". CJK works because it is plain string inclusion.
- Activated skills are appended to the system prompt **after** the package-scope section, framed as advice the constraints above outrank. A skills directory is an extension point, not a way to edit the server's own rules.
- Frontmatter parsing is a deliberately tiny reader (`key: value`, with `triggers` accepting `[a, b]` or a `-` list) — not YAML. A dependency to parse six lines of metadata is a poor trade, and a partial YAML implementation that silently mis-parses an author's file is worse than one that understands two shapes.
- Failure is per file, like plugins: a malformed skill is recorded on its `/v1/tools` entry and skipped. Hot reload shares `TOOLS_HOT_RELOAD` and the same timing rule — a change flips a dirty flag, the reload happens on the *next* request, so an in-flight turn never has its prompt swapped underneath it.
- `GET /v1/tools` reports `skills[]` (with per-file errors) and `skillsDir` alongside the tool inventory.
- **The repo ships four few-shot playbooks** — `fewshot-inheritance`, `fewshot-enumeration`, `fewshot-comparison`, `fewshot-reverse-lookup` — and they are the reference for how to write one. Each carries only worked question→answer pairs plus one framing line ("format sample; take the values from this turn's tool results"), **no procedural rules**: `SYSTEM_PROMPT` already has the playbooks, and restating them measurably pushed one eval case from 5 steps to 7. Every value in them was verified against the indexed data; each file is ~1–2K characters. `tests/unit/skillsContent.test.ts` pins their load, their size, and which phrasings fire them in both languages.
  - Known overlap, pinned rather than fixed: "有哪些武器引用了 X" fires *both* the enumeration and reverse-lookup playbooks. Substring matching cannot exclude, and triggers narrow enough to never overlap would make each playbook miss its own question — at ~1K per body the overlap is the cheaper trade.

### Progressive tool disclosure (`src/agent/toolSelection.ts`)

When built-ins + plugins exceed `TOOL_DISCLOSURE_THRESHOLD` (default `12`, `0` = disabled), the agent loop's **first step** narrows which tool schemas the model sees: `prepareStep` returns `activeTools` = the built-ins always, plus any plugin whose `triggers` matched the query. Later steps always get full disclosure, and the full registry stays the execution set throughout — `activeTools` only filters schemas, so `repairToolCall` aliases and tool execution are untouched. Below the threshold it is a byte-for-byte no-op (`undefined` → SDK uses every tool).

- **`triggers?: string[]`** is an optional `PluginToolSpec` field (`src/agent/plugins.ts`), matched case-insensitively as a substring of the user's query (CJK works because it is plain string inclusion). Declaring it is an **author opt-in to being hidden**; plugins without it are always visible. `lookup-upgrade.js` is the annotated example.
- Metadata (`coreNames` / `allNames` / `pluginTriggers`) is cached per scope in `toolDefs.ts` on the same dirty/`registries` lifecycle, populated by `getAgentTools()`, read via `getToolDisclosureMeta(scope)`.
- Token budgeting stays conservative: `measureToolDefTokens` still counts the **full** registry, so `breakdown.toolDefs` overstates the first step rather than understating any step.
- Smoke-test with `TOOL_DISCLOSURE_THRESHOLD=2` + `DEBUG_DISCLOSURE=1`: the first step logs `active=N/all=M` (N < M) and later steps log nothing.

⚠️ **Trust model.** Plugins are `import()`ed into the server process and run with its full privileges — filesystem, network, `process.env`. This is fine for files an operator placed themselves. It is **not** a sandbox: never wire plugin loading to untrusted uploads. That would require `worker_threads` isolation, which this loader deliberately does not implement.

## Parsers (src/ingestion/)

- **Excluded dirs**: `models/`, `maps/` — pruned by `walkFiles` *before* descending, so their ~1.4 GB never gets enumerated.
- **Supported extensions**: `.weapon`, `.projectile`, `.carry_item`, `.base_weapon`, `.base_carry_item`, `.animation_base`, `.base`, `.call`, `.character`, `.xml` → XML parser (with `file=` inheritance resolution); `.as` → AngelScript parser; `.ai`, `.resources`, `.models`, `.name`, `.text_lines` → plain-text fallback.
- `i18n.ts` loads `<translation><text key="…" text="…"/>` files from a package's `languages/<lang>/` dirs, following `file=` indirections.

Parsed `StructuredDocument`s feed the index builder directly — there is no intermediate `extracted-documents.json` stage any more.

**Every parser entry point takes content, not a path.** `parseContent()` (`shared.ts`) dispatches on extension; `parseXmlTree()` (`xmlParser.ts`) dispatches an already-parsed tree to the per-type extractor. There are deliberately **no** `parseFile` / `parseXmlFile` / `parseCallFile`-style wrappers that read the file themselves: they existed, and because the XML dispatcher chooses a branch by root element, a `.xml` file holding `<calls>` was read and parsed *three* times per build (graph pass, search pass, then again inside the per-type entry). If you need a path-based convenience wrapper, read the file at the call site instead of reintroducing one here.

### Directory walking (`walk.ts`) — symlinks are supported

`walkFiles()` is the one directory traversal behind `collectFiles()` and `collectTranslationFiles()`. **Do not replace it with `fs.readdir(dir, { recursive: true })`.** That built-in reports a symlink as neither file nor directory (`Dirent.isFile()` and `isDirectory()` are both `false`) and never descends into a symlinked directory — so a `DATA_DIR` assembled out of links into a steamcmd download indexes as *zero documents*, silently: `discoverPackages()` uses `fs.stat` and still finds the package, the build "succeeds", and the only symptom is `documents: 0` on `GET /health`. `loadAllLanguages()` has the same hazard for a symlinked `languages/<lang>` and stats explicitly for it.

Three invariants the walker holds:

- **Paths stay lexical, never `realpath`'d.** `readSource` guards traversal with a lexical `dataRoot` prefix check ([`tools.ts`](src/agent/tools.ts)), so a resolved path pointing outside the data root would make every linked file unreadable. `fs.readFile` follows the link on its own.
- **Cycle guard.** Realpaths of the root and of every directory entered *through* a link are memoised. A cycle must cross a link each lap, so that is sufficient — and seeding the root is what stops a self-link (`pkg/x -> pkg`) from indexing the package twice under a different lexical prefix.
- **Dangling links are skipped**, not fatal.

Verified: an index built from a symlinked data root is byte-identical to one built from the real tree (modulo the positional `entry.id`, which is per-build and never persisted).

### AngelScript (`asSymbols.ts`)

One implementation shared by `asParser.ts` (documents) and `graphBuilder.ts` (`script-symbols.json`). A line/brace scanner over comment- and string-blanked source — deliberately not a parser. Handles multi-line signatures, default-valued parameters, class members and ctor/dtor, `enum` / `namespace` / `funcdef`, and tracks the enclosing container as `ScriptSymbol.parent`.

Every `.as` file becomes exactly **one** `script_chunk` document. Because `structuredDocToRWRDocument` only feeds `raw_text.slice(0, 500)` into the searchable content, the symbol summary is written into `description` + `flat_attributes` (`classes`, `functions`, `includes`, `enums`, `funcdefs`, `properties`, capped at 120 names each) — those are rendered into the content in full. That is what makes "which script defines X" / "what includes Y" answerable by search instead of only via `getScriptSymbols`.

**Historical trap:** an `extractSoldierBlocks` heuristic used to match `<tag>…</tag>` inside `.as`. It was actually matching AngelScript generics (`array<string>`, `dictionary`), emitting junk `soldier` documents keyed `string`/`float`/`int`, and returning early so the entire script body never reached the index — 16 of 108 files were invisible. Real soldier data comes from faction XML. Never reintroduce tag-shaped matching over `.as`.

**On tree-sitter:** worth it only when call graphs, cross-file symbol resolution, or `#include` dependency graphs are needed. No AngelScript grammar is published to npm ([Relrin/tree-sitter-angelscript](https://github.com/Relrin/tree-sitter-angelscript) is the most complete but must be cloned and built), so adopting it means vendoring a self-built `.wasm` for `web-tree-sitter`. The migration surface is one function: `extractScriptSymbols(source, fileBase)`.

## Architecture

Diagrams for the request pipeline, the tool loop, the stream contract and the index build live in [`ARCHITECTURE.md`](./ARCHITECTURE.md). This section covers the details a coding agent needs, not the overview.

### Entry Points
- `src/app.ts` — `buildApp()`: `await ensureIndexes()`, CORS, `/v1/*`, `/health`, static serving.
- `src/api/server.ts` — local entry (`app.listen`).
- `src/index.ts` — programmatic entry, exports a built app without calling `listen` (`main` in `package.json`).
- Static serving: `@fastify/static` over `public/` with an SPA fallback to `index.html`.

### Routes
| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | Main endpoint. Extra fields: `mod`, `response_format`, `mode` ('max' = best-of-N), `candidates` |
| `POST /v1/chat/steer` | `{turnId, message}` → add an instruction to a *running* turn. See [Steering](#steering-a-running-turn-srcagentturnregistryts) |
| `POST /v1/chat/stop` | `{turnId}` → end a running turn, keeping what it already produced |
| `GET /v1/models` | Model list |
| `GET /v1/packages` | Packages in the current index (`name`, `displayName`, `count`) |
| `GET /v1/tools` | Tool inventory: built-ins, plugin *and* skill entries with per-file errors, `toolsDir`, `skillsDir`, `hotReload` |
| `GET /v1/limits` | `{max_conversation_rounds, max_context_tokens}` — the caps the UI shows before the first turn |
| `GET /health` | `{status, index:{ready, documents, packages, builtAt, reason?}}` — no external check |

### Request pipeline (src/api/routes/chat.ts)
1. External `system` messages dropped; server enforces its own `SYSTEM_PROMPT` (`src/retrieval/prompt.ts`). Anti-injection.
2. Conversation-round guard: `ceil(nonSystemMessages / 2) > MAX_CONVERSATION_ROUNDS` → 400 `conversation_limit_exceeded` (carries `rounds` / `max_rounds`). Bounds thread length, not request rate — the history is re-sent every turn *and* once per tool-loop step, so an endless thread is the real cost sink. `0` disables it.
3. Token-size guard at ~`maxContextTokens * 0.7`.
4. `x-session-id` keys a rolling summary (`src/memory/summarizer.ts`, in-process `Map`, never persisted); summaries regenerate every `SUMMARY_INTERVAL_TURNS`.
5. `isMetaQuery` short-circuits search for questions about the bot.
6. `buildSearchQuery` (`src/retrieval/queryRewrite.ts`) merges history + summary + CN↔EN synonym expansion.
7. `retrievalTopK(category, exactKey)` picks the breadth: 5 for a bare key, 150 for enumeration, 12 for inheritance/source/script (those are answered by graph tools, so prose only has to identify the entity), else 30. `localSearch(query, filters, topK, enrichedQuery)` then runs, optionally filtered by `body.mod`.
8. `buildUserPrompt` embeds each result at up to 2000 chars **until `CONTEXT_BUDGET_TOKENS` is spent**; the remainder are listed as `Key | type | name | mod | file` one-liners with an instruction to expand them via `searchDocs`/`readSource`. Every hit still appears, so enumeration keeps full coverage while the prompt stops growing.
9. A second size guard runs here, once the real prompt exists: the first one only sees the incoming messages, and a 150-result enumeration adds far more than the user typed.
10. Tools come from `getAgentTools()` (`src/agent/toolDefs.ts`), re-queried per request so hot-reloaded plugins take effect.
11. `streamText` with graph tools, or `streamObject` with `EnumResultSchema`/`ComparisonResultSchema` (`src/types/schemas.ts`) when the query is enumeration/comparison **and** `response_format: json_object` (or `x-response-format`) is set.

### Steering a running turn (src/agent/turnRegistry.ts)

A turn is one long-lived `POST /v1/chat/completions`, and its request body was consumed before the first token went out — so there is nowhere on that connection to say anything else. `POST /v1/chat/steer` and `POST /v1/chat/stop` are that "anything else", keyed by the `turnId` the stream announces in `turn-start`.

`createTurn(abort)` registers the turn; the route keeps owning the `AbortController` and **must** call `endTurn(id)` in its `finally`. The registry's TTL sweep (30 min, lazy, on create) only covers a crash that skipped it.

**Steering is sticky, not a queue.** Accepted messages accumulate and `prepareStep` re-appends *all* of them on *every* later step. This is not a style choice: the AI SDK rebuilds `messages` from the original input plus its own accumulated response on each step, so a `prepareStep` rewrite reaches only that one outgoing request. Measured — injecting once left the instruction alive only because the provider happened to echo the model's `reasoning_content` back. Caps: 8 messages per turn, 2000 chars each, because every one of them is re-sent on every step.

Two ordering rules inside `prepareStep`:
- **Append before `shaper.prepare()`.** The shaper's `replay[]` is what token accounting attributes against; injecting after it would leave the appended message off the books.
- **Pass `messages` explicitly once there is any steering.** `shaper.prepare()` reports "nothing to rewrite" as `{}`, and the SDK then falls back to its own list — silently dropping the injection.

`stopTurn` fires the same `AbortController` a client disconnect uses, so the two are told apart by `stoppedByUser()`: a user stop keeps everything generated and finishes with `stopReason: 'stopped'`; a disconnect has nobody left to finish for.

**An abort does not reliably throw out of `fullStream`.** Measured: the SDK ended the iterator *gracefully* with `finishReason: 'other'`, so a `try/catch` around the loop never fired and the stopped turn reported `completed`. The stop reason therefore comes from asking the registry after the loop, not from catching. The catch is still needed for the case where it does throw — and that is the only case that skips `result.totalUsage` / `usage` / `steps`, because a gracefully-ended stream still has real usage that would otherwise be thrown away and reported as an estimate.

⚠️ **Process-local, single-replica.** Behind more than one replica a steer request lands on a process that never heard of the turn and answers 404. Fixing that means shared state; until then this deployment stays one service.

**The bundled Web UI only stops; it never steers.** A running turn is exclusive there: the composer's Send button *becomes* Stop, and Enter does nothing until the turn ends. Typed text is kept, not queued — a follow-up composed against a half-finished answer is usually not the question the user would ask against the finished one, and auto-sending it produces a turn nobody chose. So `POST /v1/chat/steer` currently has no in-tree caller besides `eval:agent`. It stays a supported public route (the `steer-applied` frame is still rendered when another client uses it), but that means **its only regression cover is the eval harness** — `agent-steer-narrow` is what keeps sticky injection working, and there is no browser path that would notice it breaking.

### Streaming format
Custom **NDJSON**, not SSE — the OpenAI-shaped path is a naming coincidence, not a wire promise, and a real OpenAI client cannot read this stream. One JSON object per line, keyed by `type`: `turn-start`, `text-delta`, `reasoning-delta`, `json-delta`, `tool-step`, `steer-applied`, `reflection`, `revision`, `finish`, `error`, `ping`. Treat these shapes as a contract with the Web UI — **extend with new optional fields, never repurpose an existing one.**

- `turn-start` — first line of every stream: `turnId` (the steer/stop key) and `protocolVersion`. It also commits the response head at a buffering proxy, the job the first heartbeat ping used to do alone — so it goes out even when `STREAM_HEARTBEAT_MS=0`. A client that never sees one is talking to a pre-steering backend and must keep its old behaviour rather than offering buttons that would 404 — which is why the UI's Stop button appears only once `turnId` is known, falling back to the plain disabled spinner in the gap before it.
- `steer-applied` — a steering message reached the loop: `turnId`, `step`, `message`. Emitted **once per message**, not once per step, even though the injection itself repeats on every later step.
- `tool-step` — emitted twice per call: opening (`toolCallId`, `toolName`, `summary`) and closing (same `toolCallId`, `done: true`, `ok`, `durationMs`). `ok: false` marks a failed call; the UI must still close the card or a failure reads as still running. **`toolCallId` is the pairing key** — the UI renders one card per call and updates it in place. Against a backend old enough not to send it, the closing event pairs with the turn's still-open card (calls never overlap within a turn); a closing event with no open card at all still renders as a closed card — the outcome is shown rather than dropped. Opening carries the argument summary, closing the result summary; neither is the raw input/output, and neither should grow into it.
- `finish` — `stopReason` is `completed` | `step-limit` | `output-limit` | `stopped`. Clients **must** have a default branch: adding a value here is allowed by the contract, changing what one means is not. `step-limit` is narrower than it sounds: it means the loop stopped with the model still asking for tools and *no answer text written*. A turn that hit `MAX_TOOL_STEPS` after already answering reports `completed`. `usage` separates **spend** from **occupancy**: `promptTokens`/`completionTokens` sum every step of the tool loop, while `contextTokens` is what the *next* request will carry (the tool transcript is excluded — it never survives the turn, and the UI gates sending on this number). `maxContextTokens` lets the UI follow server config. `breakdown` attributes the totals per slice, with `exact` listing which figures the provider reported verbatim.
- `reflection` — the post-answer self-check's outcome: `verdict` (`pass` | `revised`), `issues[]` (`{code, detail?}`), `trigger[]` (the risk signals that selected the turn). Absence means *not checked*, never *checked and clean*. `code` is an **open set** — `missing-citation`, `missing-key`, `scope-violation`, `count-mismatch`, `unsupported-claim`, `no-answer`, `other` today — so clients need a fallback; `detail` is model prose in the question's language and is shown verbatim rather than localized. See [Reflection](#reflection-post-answer-self-critique).
- `revision` — the revised answer, **whole rather than as deltas**: the original already streamed and stays on screen. Only ever follows a `reflection` with `verdict: 'revised'`. This is the version that enters the conversation history — a client that ignores the event keeps the original and stays consistent with itself.
- `error` — the stream itself broke. **Not** used for tool failures (those are `tool-step` with `ok: false`), for stop reasons (those are `finish.stopReason`), or for reflection findings (those are `reflection.issues`). Never put user-facing prose here that the frontend could localize itself.

### Step budget (`MAX_TOOL_STEPS`, default 100)

`npm run eval:agent` once measured "有哪些武器引用了 bullet.projectile" — answerable by a single `findReferences` call — at **20 steps / 889K input tokens on one run and 41 steps / 2.5M on the next**. Same question, 3× spread.

**The step cap is not the lever for that.** It stays at 100, the historical value, now behind `MAX_TOOL_STEPS` so an operator can lower it. A deep question needs the room: a reference or inheritance chain crossing several packages is *sequential* — each `readSource` depends on what the previous layer reported — and truncating it mid-walk yields a confidently wrong answer rather than a slow one.

**Steps are not tool calls.** One step can fan out many parallel calls, and measured runs do: 15 calls in 9 steps, and 54 `getScriptSymbols` in a single step. A cap on steps therefore bounds round-trips, not work — which is why the two fixes below are what actually moved the numbers:

1. **Reverse lookups no longer retrieve like enumerations.** `isReverseLookup()` (`src/retrieval/intent.ts`) drops "有哪些 X 引用了 Y" from topK 150 to 12, because `findReferences` returns that list whole. Detected as *an enumerating interrogative followed by a reference verb* — the **order** is load-bearing, since a forward lookup ("G36 使用什么弹药") puts the interrogative after the verb and must not match. It is passed to `retrievalTopK` separately rather than becoming a `QueryCategory`, because the category also picks the structured-output schema and a reverse lookup still wants the enumeration schema.
   - This only bites the phrasings that do *not* reduce to one key. The eval's own "有哪些武器引用了 bullet.projectile？" already hit the exact-key fast path (topK 5) before the change — so the breadth was never that case's problem, which is why measuring before blaming mattered.
2. **A `SYSTEM_PROMPT` playbook** points those questions at one `findReferences` call and tells the model not to go hunting with `searchDocs` afterwards.

Measured after both, on the same non-deterministic harness (single runs, but well outside the previously observed ranges — and both finished on their own, not on the cap):

| Case | Before | After |
|---|---|---|
| `agent-references` | 20–41 steps · 889K–2.5M in | **5 steps · 4 calls · 59K in** |
| `agent-absence-escalation` | 14 steps · 28 calls · 523K in | **9 steps · 15 calls · 319K in** |

Still open: the prompt claims a 3–6 call budget that nothing enforces.

### Best-of-N synthesis ("max mode")
`mode: 'max'` on `/v1/chat/completions` (the UI's per-message Max toggle) runs **N parallel candidate agent loops, then one tool-less synthesis ("judge") call** that merges the drafts into the final answer. Orchestrated by `runBestOfN()` (`src/agent/synthesize.ts`), prompted by `buildSynthesisPrompt()` (`src/retrieval/synthesisPrompt.ts`). Not Cursor-style Max mode: this is best-of-N / self-consistency, and there is **no quota, billing or tiering** — a per-message toggle and an env-guarded N.

- **Cost guardrail is the whole point.** The normal loop's `MAX_TOOL_STEPS` backstop is 100; best-of-N multiplies spend by N, so every candidate runs under `stopWhen: stepCountIs(BEST_OF_N_MAX_STEPS)` (default **6**) — deliberately tight. Do not raise it casually, and never widen the candidate count beyond `BEST_OF_N`/`body.candidates` (clamped to ≤ 8).
- **Retrieval and the tool registry are shared, once.** `ragUserPrompt`, `tools`, disclosure metadata and the input-token estimates are computed once; only each candidate's temperature/seed (`buildCandidateProviderOptions`) and its own transcript shaper differ. Every candidate must get **its own** `createToolTranscriptShaper()` — the shaper holds mutable `replay` state.
- **Candidates reuse the full tool surface**: `prepareStep` disclosure, `repairToolCall` aliases, `toolRuntime` envelope — the same as the normal path, so a candidate cannot drift from normal behaviour.
- **Failure policy** (`runBestOfN` never throws): fewer than 2 successful drafts, or a judge that fails/produces nothing, degrades to the "best" draft (most steps, `finishReason` ≠ error) emitted as a one-shot `text-delta`. All candidates failed → whatever partial text the longest run produced, `stopReason` stays `completed`. Judge `length` → `output-limit`.
- **Structured mode is excluded**: enumeration/comparison with `response_format: json_object` never enters best-of-N (`useStructured` short-circuits).
- **Stream contract additions (all additive)**: `candidate-open`/`candidate-close` frame each run; `candidate-step` reuses the `tool-step` shape plus a `candidate` index; judge `text-delta`/`reasoning-delta` are the final answer; `candidates` delivers the raw drafts (`{i, steps, ok, answer}[]` + `kind: synthesis|fallback`) for the collapsible panel. `finish.usage.breakdown` adds optional `candidates`, `perCandidate[]`, `judge` — existing fields keep their meanings and sum the whole turn.
- **Token accounting is a sum plus one exclusion**: `aggregateBestOfN()` (`src/api/tokenAccounting.ts`) sums every candidate loop + the judge for `promptTokens`/`completionTokens`, but `contextTokens` is **baseIn + the final answer only** — candidate-loop tokens never occupy the next request, mirroring how the tool transcript is excluded on the normal path. Don't let the usage bar start counting candidate context.
- **Judges and candidates share the provider** (`getProvider()`); the judge follows the turn's selected model (`body.model`) unless `JUDGE_MODEL` was explicitly set. Each candidate and the judge get their own Langfuse generation observation so N runs do not collapse into one span.

### Reflection (post-answer self-critique)

One tool-less call *after* the answer has streamed, re-checking it against the retrieved context and the tool transcript and rewriting it when a check fails. Orchestrated by `runReflection()` (`src/agent/reflect.ts`), prompted by `buildReflectionPrompt()` (`src/retrieval/reflectionPrompt.ts`) — the same shape as the best-of-N judge, and deliberately so: one streamed call, no tools, no shaper, no step loop, with the JSON verdict accumulated and parsed afterwards (see below for why it is neither `generateObject` nor non-streamed).

**It checks what the system prompt already asks for and nothing else** — citations, `**Name** (\`key\`)` form, package scope, enumeration counts, claims with no evidence. Those instructions were never verified programmatically; this is the first thing that does. A checker with opinions of its own would rewrite answers that were already fine.

- **The answer is already on screen.** Buffering it to check first would trade the whole turn's TTFB for a check that usually passes, so reflection *appends*: a `reflection` event, plus a `revision` event when it rewrote. Both blocks stay visible; the timeline is what actually happened.
- **The revision is what enters history.** The server stores no answers — the client replays them — so `web/src/App.svelte` writes `revisionText ?? answerText()` into `history`. That is also what the session summarizer sees (it reads the replayed history), so `src/memory/` needed no change. Appending *both* versions was rejected: every later turn would carry two answers, one of which the server itself flagged.
- **Conditional, and off by default** (`REFLECTION_ENABLED`). `shouldReflect()` fires on a failed tool call, on `step-limit`, or on an inheritance/enumeration intent — and refuses outright on a user stop, a vanished client, or an empty answer that `step-limit` does not explain. `output-limit` is not a signal: a rewrite would hit the same output cap. `DEBUG_REFLECTION=force` fires it on any otherwise eligible turn, for wiring up a client.
- **A `step-limit` turn is the valuable case**, not an edge case: it streamed nothing, and the transcript usually holds everything needed to build the answer the loop never wrote. The prompt handles the empty answer as its own branch (`no-answer`) instead of reporting a pile of findings about a string that does not exist.
- **Fail-open, and never recursive.** Every failure — `NoObjectGeneratedError`, timeout, abort — resolves to `undefined` and emits *nothing*; a turn that produced an answer must not be failed by its own optional check. A revision is never itself reflected on.
- **JSON asked for in the prompt, parsed leniently, validated after** — the summarizer's pattern (`src/memory/summarizer.ts`), and *not* `generateObject`. Two measured reasons, both worth knowing before "fixing" this:
  - The backend rejects the schema: `The feature "responseFormat" is not supported. JSON response format schema is only supported with structuredOutputs`. It never reaches the provider, and the call then fails on a real prompt with `No object generated`.
  - It must **stream**. A non-streamed request sends no bytes until the model finishes, and the gateway in front of this backend cuts it off first (`Response Timeout by Origin Server`) — which is also why the tool loop and the judge stream. `runReflection` streams and accumulates internally; nothing reaches the client. The one non-streamed call in this repo (the summarizer) survives only because its prompt is a few hundred characters.
  - `parseReflectionOutput()` is therefore the contract's real boundary: it unwraps a ```json fence, tolerates prose around the object, and **folds `missing_citation` onto `missing-citation`** — the model writes snake_case about as often as not, and a finding dropped over a separator is a finding the user never sees. An unrecognised code becomes `other` carrying the original in `detail`. `verdict: 'fail'` with no `revisedAnswer` degrades to a pass with a warning.
- **Its own output cap, deadline and budget**, not the turn's: `MAX_REFLECTION_OUTPUT_TOKENS` (8192), `REFLECTION_TIMEOUT_MS` (60s) with `maxRetries: 1`, and `CONTEXT_BUDGET_TOKENS` as the prompt budget. The shaper's budget (~340K by default) would trim nothing and reached the origin timeout; the user is already waiting on the turn to close, so an optional check that hangs for minutes is worse than one that gives up.
- **Covers the single path and max mode; structured output is excluded** — zod already constrains that shape, and its content is assembled from the retrieved context rather than narrated. In max mode the transcript is empty (candidate tool steps never leave the orchestrator), so the check runs against the shared retrieval context alone; `BestOfNCandidateResult.toolFailures` is what carries the risk signal out.
- **Accounting**: `applyReflection()` (`src/api/tokenAccounting.ts`) adds the round trip to spend and fills `breakdown.reflection`, but only moves `contextTokens` when a revision *replaced* the answer (`-original +revised`) — the client gates its send button on that number.
- **UI**: a clean check is a one-line badge. A revision renders as an **ordinary AI bubble** — not a collapsible panel or a quote — because it *is* the answer the conversation continues from; framing it as an aside made the superseded text look like the real answer. It therefore takes over the turn's action bar and meta line (`turnEndIds` counts a revision and, being later, it wins), and the turn's copy yields it. Findings collapse into one note above it, **aggregated by code** (`缺少证据支撑的结论 ×10`): a reflection routinely reports the same finding about several claims, and one badge each filled the header with a dozen identical chips. The per-claim `detail` stays on the wire.

### Frontend
Svelte 5 + Vite + Tailwind 4 + daisyUI in `web/`, building into `public/` — treat `public/` as generated. `web/vite.config.ts` reads `PORT` from the repo-root `.env` via `loadEnv`, so the dev proxy always follows the backend port. The Header's dropdown is a package filter fed by `GET /v1/packages`; it hides itself when there is only one package.

**A turn renders as many blocks, not one bubble.** Text, reasoning and each tool call are separate `DisplayItem`s appended in arrival order, so the rendered order equals the real timeline: a tool call closes the current text block, and whatever the model writes next opens a new one *below* the tool card. `turnId` is what still groups them — retry, recall and copy all key on it, never on an item index, and `history` carries the same id so a recall can truncate by turn instead of reconstructing itself from the rendered items (one answer would fold back into several assistant messages).

The timeline is persisted: assistant `Message`s carry `segments: TurnSegment[]`, so a reload replays the same blocks. Sessions written before this exist without the field and fall back to a single bubble — `buildDisplayItems` branches on it, and there is no migration.

Streaming state lives in two variables: `streaming` (the turn is live — its action bar and meta line stay hidden) and `activeBlockId` (the one block still receiving deltas — it gets the caret). While a tool runs, `activeBlockId` is null, which is what stops the caret from blinking on a block that already ended.

### Observability
`src/observability/langfuse.ts` + `src/instrumentation.ts` — Langfuse OTel tracing wraps the chat chain (search / generation spans), gated by `LANGFUSE_ENABLED`.

## Environment & Config

`LLM_API_KEY` is the only required variable (`SILICONFLOW_API_KEY` is still accepted as a fallback for older `.env` files). Everything else has a default in `src/config/index.ts`:

| Variable | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://api.siliconflow.cn/v1` | |
| `LLM_MODEL` | `deepseek-v4-flash` | |
| `LLM_MODELS` | `LLM_MODEL` | Comma-separated list served by `GET /v1/models` and accepted in `body.model`; anything else (incl. the legacy `rwr-agent` alias) falls back to `LLM_MODEL`. The UI's model switcher only lists these |
| `LLM_MODEL_LABELS` | — | Display-name mapping for the switcher (`id=Label` pairs, comma-separated); each `/v1/models` entry carries a `display_name`, which the UI renders instead of the raw id — raw ids stay the wire format only |
| `DATA_DIR` | `./data` | Single package or directory of packages |
| `OUTPUT_DIR` | `./output` | |
| `GRAPH_PATH` / `SEARCH_INDEX_PATH` | `<OUTPUT_DIR>/…` | Individual overrides |
| `AUTO_BUILD_INDEX` | `true` | |
| `TOOLS_DIR` | `./tools.d` | Runtime tool plugins; skipped if absent |
| `TOOLS_HOT_RELOAD` | on outside prod | Watch `TOOLS_DIR` and `SKILLS_DIR`, reload on the next request |
| `SKILLS_DIR` | `./skills.d` | Markdown playbooks appended to the system prompt on a trigger match. See [Skills](#skills-srcagentskillsts-skills_dir) |
| `TOOL_DISCLOSURE_THRESHOLD` | `12` | Progressive tool disclosure gate: above this tool count the first step exposes built-ins + trigger-matched plugins only; `0` disables |
| `PORT` | `3000` | |
| `MAX_CONTEXT_TOKENS` | `500000` | Also reported to the UI on `finish`, so the usage bar follows it |
| `LLM_MAX_OUTPUT_TOKENS` | `32768` | Reasoning + answer share this budget |
| `CORS_ORIGINS` | empty (reflect any) | Comma-separated allowlist; set it once the port is not LAN-only |
| `API_TOKEN` | empty (no auth) | When set, `/v1/*` needs `Authorization: Bearer` or `x-api-key` |
| `MAX_CONVERSATION_ROUNDS` | `20` | Max rounds one thread may carry (round = question + answer, counted off the replayed history). Past it `/v1/chat/completions` answers 400 `conversation_limit_exceeded`; `0` disables |
| `CONTEXT_BUDGET_TOKENS` | `24000` | Cap on full-text retrieved context; the rest become one-liners |
| `MAX_TOOL_STEPS` | `100` | Runaway backstop for the agent loop, in LLM round-trips (not tool calls). See [Step budget](#step-budget-max_tool_steps-default-100) |
| `TOOL_TIMEOUT_MS` | `15000` | Deadline per tool execution; expiry returns `{error, hint}` |
| `TOOL_CONTEXT_BUDGET_RATIO` | `0.75` | Window fraction a step's prompt may fill before old tool results are shed |
| `TOOL_SHED_RESULT_TOKENS` | `600` | Size an old tool result is shrunk to when shedding is unavoidable |
| `LLM_REASONING_EFFORT` / `LLM_THINKING_ENABLED` / `LLM_TEMPERATURE` | unset | Omitted from the request when unset |
| `SUMMARY_INTERVAL_TURNS` / `SUMMARY_MODEL` | `3` / `LLM_MODEL` | |
| `BEST_OF_N_ENABLED` | `true` | Master switch for max mode |
| `BEST_OF_N` | `3` | Candidate count for max mode (`body.candidates` overrides, clamped ≤ 8) |
| `BEST_OF_N_MAX_STEPS` | `6` | Per-candidate step cap — the cost guardrail |
| `BEST_OF_N_TEMPERATURES` | `0.3,0.6,0.9` | Candidate temperature sequence, cycled |
| `BEST_OF_N_SEED_BASE` | `1` | Seed of candidate 0; each candidate adds its index |
| `JUDGE_MODEL` | `LLM_MODEL` | Model for the synthesis call |
| `REFLECTION_ENABLED` | `false` | Master switch for post-answer self-critique. Off by default: it fires on its own (not per-message like max mode) and inheritance/enumeration are common, so it is opt-in until measured. See [Reflection](#reflection-post-answer-self-critique) |
| `REFLECTION_MODEL` | `LLM_MODEL` | Model for the reflection call; pinned only when set explicitly, otherwise follows `body.model` |
| `LANGFUSE_*` | disabled | |

## Deployment

### Docker
`docker compose up -d --build` — a single `app` service. `./data` mounts read-only at `/app/data`; `./output` is a writable volume so restarts skip the rebuild; `./tools.d` mounts read-only at `/app/tools.d`.

**Resource ceilings are deliberate.** `mem_limit`, `cpus` and `NODE_OPTIONS=--max-old-space-size` are set (overridable via `MEM_LIMIT` / `CPUS` / `NODE_OPTIONS`) because an index build is the heaviest thing this service ever does and it shares the box. Keep the heap cap well under `mem_limit`: unbounded, V8 sizes its old space from the *host's* RAM, so on a 2 GB VPS a build climbs until it is thrashing GC and dragging the whole machine down instead of collecting.

**On a small host, don't build in the serving process at all.** Run `npm run build:index:prod` as a one-shot job (a separate compose service, or a deploy step) and set `AUTO_BUILD_INDEX=false` on `app` so the server only ever loads. Startup no longer blocks on the build either way — see [Startup](#startup) — but a one-shot builder is what keeps a rebuild from competing with live requests for two cores.

**Sharing a steamcmd download.** `DATA_DIR` may be a directory of symlinks into a steamcmd tree instead of a copy — `walkFiles` follows them (see [Directory walking](#directory-walking-walkts--symlinks-are-supported)). The links must resolve *inside the container*, so mount the steam tree and point the links at the container-side path:

```yaml
    volumes:
      - /srv/steam/rwr:/srv/steam/rwr:ro    # same path inside and out, so links stay valid
      - ./data:/app/data:ro                 # dir of symlinks -> /srv/steam/rwr/...
```

Workshop packages live at `steamapps/workshop/content/270150/<itemid>/<pkgname>/`. `discoverPackages()` only looks at the root and its immediate children, so link the `<pkgname>` level — pointing at `<itemid>` finds nothing.

## Testing

Three nets, in ascending cost. Reach for the cheapest one that can catch the class of bug you are risking. The reason all three exist: the eval harnesses assert *answers*, so a change that silently breaks token attribution, tool disclosure, or transcript shaping still lets every case pass — and they cost real quota per run, which makes them a poor place to hang a check you want on every commit.

- `npm run test` — vitest over `tests/unit/`. **Pure functions only**: intent classification, tool disclosure, the transcript shaper, token accounting, the tool envelope, plugin loading. Deterministic, no LLM, no network, ~1s. These cover exactly what the eval harnesses cannot notice — a token-attribution drift or a disclosure regression breaks no eval assertion.
  - **Keep the boundary.** Once a test needs a mocked LLM provider to assert loop behaviour, it belongs in `eval:agent` instead; maintaining provider mocks costs more than the bugs they catch.
  - `tests/tsconfig.json` exists because the root config pins `rootDir: ./src` for the build, and ESLint's `projectService` refuses to lint a TS file belonging to no project. `npm run typecheck` runs both.
  - Two assertions are **safety** assertions, not regression ones, and must never be relaxed: `repairToolCall` maps no write/shell/exec name, and a plugin may not shadow a built-in.
- `npm run eval` — 30-case retrieval harness over `tests/eval/dataset.json`, writes a timestamped report into `tests/eval/`. **No LLM calls.** Note the dataset references some keys that no longer exist in the current `./data` snapshot, so absolute recall understates real quality; track deltas, not the absolute number. Baseline on the current snapshot: 15/30 (R@5 0.533, MRR@10 0.507).
- `npm run eval:agent [id-filter]` — tool-loop harness over `tests/eval/agent-dataset.json`, driving the real route in-process via `app.inject()`. **Spends real LLM quota** (~2–5 min for the full 12 cases) and is non-deterministic, so assertions are "at least this" — `expectedTools` must all have been called, `expectedKeys` must appear in the answer, and `maxSteps` bounds the loop. Run it after any change to tools, the tool loop, intent classification, or prompt structure.
  - Step budgets come from the design reference (a single-entity question is 1–3 targeted calls) and the system prompt's own "4–6 attempts settle absence" rule, **not** from observed behaviour — so a case that exceeds its budget is reporting a real inefficiency, not a broken test. `agent-inheritance-english` currently passes at exactly its budget; expect it to be the first to go red on a prompt-structure change, and read that as signal.
  - **Assertions are per case type**, keyed off the fields a case declares:

    | Case declares | `stopReason` expected | Side channel 200 | `steer-applied` frame | Non-empty answer |
    |---|---|---|---|---|
    | neither | `completed` | — | — | required |
    | `steer` | `completed` | required | required | required |
    | `stopAfterToolSteps` | `stopped` (via `expectStopReason`) | required | — | **not** required |

    The last row is why the table exists: a stopped turn is *supposed* to be cut short, so an empty answer is the intended outcome rather than a failure, and nothing was steered so there is no frame to wait for. Only a `steer` case asserts both halves, and it asserts them separately on purpose — the 200 says the server accepted the message, the frame says the loop actually carried it, and the first can pass while the second fails. That gap is exactly the bug the sticky-injection rule exists to prevent.
  - **Those two kinds of case cannot use `inject()`.** It hands back the whole body once the stream is over, so there is no moment during the turn at which the side channel could be called, and no way to learn the `turnId` in time. They run against a real listener on an ephemeral loopback port and read incrementally, exactly as the browser does. The listener is only started when a selected case needs one.
  - Both report files and the eval reports are untracked build artifacts; `tests/eval/report-*.json` is **not** gitignored, so delete stray reports before committing.
- `npm run validate:index` — exercises all 7 graph tools, picking real sample keys out of the built graph so it works against any data directory.

## Style

Prettier, configured in `.prettierrc.json` (single quotes, `printWidth` 100, trailing commas, semicolons, 2-space tabs). Prettier does **not** read `.gitignore`, so `.prettierignore` must be kept in sync with it by hand — `web/` is the one manual addition (its own toolchain). Otherwise, match the surrounding code.

The tree was formatted in full and `format:check` is a CI gate, so run `npm run format` before pushing. Prettier does not reflow comments, so the wide comment blocks throughout `src/` are hand-wrapped at the same 100 columns — keep them that way when editing, or they drift out of alignment with the code Prettier does wrap.
