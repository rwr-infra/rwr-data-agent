# AGENTS.md

## Project Overview

Local AI Agent for *Running With Rifles* game data. Node.js 20+ / TypeScript / Fastify. OpenAI-compatible chat completions API with **local full-text search (Minisearch) + graph index + agent tools** — no database required. Includes a built-in chat UI served at `/`.

## Critical Conventions

- **ESM only**: `"type": "module"`. All imports use `.js` extensions even for `.ts` source files. `tsconfig` uses `NodeNext` module resolution.
- **No path alias usage in practice**: `~/*` is mapped in `tsconfig.json`, but the entire codebase uses relative imports. Follow the existing style.

## Developer Commands

```bash
npm install
npm run dev              # backend hot-reload (tsx --watch src/api/server.ts)
npm run web:dev          # frontend dev server (vite :5173, proxies /v1 + /health)
npm run build            # tsc → dist/  AND  vite build web/ → public/
npm start                # node dist/api/server.js
npm run db:migrate       # raw SQL init (pgvector + table + indexes)
npm run extract           # CLI extraction to JSON (see below)
npm run embed             # CLI embed JSON to database (see below)
npm run ingest            # CLI extraction + embed in one step (legacy)
npm run eval              # retrieval eval harness (src/eval/run.ts)
npm run lint              # ESLint (no config file, uses defaults)
npm run format            # Prettier (no config file, uses defaults)
npm run build:graph       # build graph index from data/ (nodes + edges + AS symbols)
npm run validate:graph    # validate agent tool functions against real data
```

## Running Locally (Required Order)

1. `cp .env.example .env` — fill in `LLM_API_KEY` (and `LLM_BASE_URL`, `LLM_MODEL`)
2. `npm run build:graph` — build all indexes from `data/`: graph + search index + AS symbols
3. `npm run dev`

## Graph Index & Agent Tools (src/agent/)

The graph index is a **file-system + relationship overlay** that solves three gaps that embedding-RAG alone cannot address: locating original source files, tracing inheritance chains, and querying AngelScript symbols.

```bash
npm run build:graph                                      # default: --source ./data --mod GFL_Castling
npm run build:graph -- --source ./other-data --mod MyMod # custom source
npm run validate:graph                                   # smoke-test all 7 tools against real data
```

Output files (generated in `output/`, not tracked by git):
- `output/graph.json` — nodes (entities keyed by `key`/`name`/filename) + edges (relationships)
- `output/script-symbols.json` — AngelScript function/class/include signatures with line numbers
- `output/search-index.json` — Minisearch full-text index (replaces pgvector + embedding + rerank)

**Edge types extracted:**

| Relationship | Meaning | Example |
|---|---|---|
| `extends` | XML `file="parent"` inheritance | `<weapon file="base_primary.weapon">` |
| `fires` | Weapon→projectile reference | `<projectile file="556.projectile">` |
| `transforms_to` | Carry item degradation chain | `transform_on_consume="K309_1"` |
| `includes` | Call file aggregation | `<calls><call file="x.call"/></calls>` |
| `next_in_chain` | Weapon mode switching | `<next_in_chain key="m4_gl"/>` |
| `references` | Generic weapon file include | `<weapon file="..."/>` inside other elements |

**Tool functions** (`src/agent/tools.ts`, in-process, no external service):
- `getInheritanceChain(key)` — full parent chain with depth
- `findReferences(key)` — reverse lookup: who points to this entity
- `getTransformChain(key)` — armor/item degradation layers
- `readSource(file, startLine?, endLine?)` — read raw source with path-traversal guard
- `listFiles(pattern, type?)` — glob search over indexed nodes
- `getScriptSymbols(file)` — AngelScript function/class/include signatures
- `getNode(key)` — basic entity lookup

These are plain async functions designed to be wrapped as AI SDK `tool()` definitions and are **now integrated** into `chat.ts` via `streamText({ tools, stopWhen: stepCountIs(5) })`. The LLM autonomously calls these tools during multi-step agent loops, interleaved with the existing RAG context (now powered by Minisearch local full-text search). Tool-call and tool-result events are streamed to the frontend as `tool-step` NDJSON lines for live UI feedback.

## Extract CLI (Step 1: Parse → Structured JSON)

```bash
npm run extract -- --source ./data --mod GFL_Castling
npm run extract -- --source ./data --mod GFL_Castling --output ./my-data.json
npm run extract -- --source ./data --mod GFL_Castling --languages ./custom/path/languages
```

Output is a JSON file (`output/extracted-documents.json` by default) containing **structured documents** with:
- `type`, `key`, `label` — document identity
- `description` — natural language description generated from attributes
- `raw_text` — raw text representation
- `data` — the full parsed/resolved XML structure as JSON (for verifying inheritance, nested elements, multi-state items, etc.)
- `flat_attributes` — flattened key-value pairs for quick reference
- `metadata` — extra fields (faction, weapon_class, etc.)
- `i18n` — localized names resolved from translation files (e.g. `{"cn": {"GK-Adeline": "Adeline 艾德琳"}}`)

The extract CLI automatically discovers the `languages/` directory inside the source path or its subdirectories. Translation files (`<translation><text key="..." text="..."/>`) are loaded and matched against document `name` attributes to add localized names.

Review/edit this JSON before embedding. The `data` field contains the XML-as-JSON structure so you can verify inheritance resolution, nested elements, and multi-state items (e.g. armor transform chains).

## Embed CLI (Step 2: JSON → Database)

```bash
npm run embed -- --input ./output/extracted-documents.json
npm run embed -- --input ./output/extracted-documents.json --clear   # wipe mod first
npm run embed -- --input ./output/extracted-documents.json --resume  # skip existing
npm run embed -- --input ./output/extracted-documents.json --filter-type weapon  # only weapons
npm run embed -- --input ./output/extracted-documents.json --limit 10  # embed first 10 docs (testing)
```

## Ingestion CLI (Legacy: Combined Extract + Embed)

```bash
npm run ingest -- --source ./data --mod GFL_Castling
npm run ingest -- --source ./data --mod GFL_Castling --clear   # wipe mod first
npm run ingest -- --source ./data --mod GFL_Castling --resume  # skip existing
```

- **Excluded dirs**: `models/`, `maps/` (3D assets / terrain, skipped by `collectFiles`).
- **Supported extensions**: `.weapon`, `.projectile`, `.call`, `.character`, `.xml` → XML parser; `.as` → AngelScript parser; `.ai`, `.resources`, `.models`, `.name`, `.text_lines` → plain text fallback.
- **Resume dedup key**: `${type}:${key}`.
- **Batch delay**: 500ms between embedding batches to avoid rate limits (SiliconFlow).

## Architecture

### Entry Points

- `src/index.ts` — Vercel entry point. Creates app via `buildApp()`, exports the Fastify instance for Vercel Functions.
- `src/api/server.ts` — Local development entry point. Same `buildApp()` but with `app.listen()`.
- `src/app.ts` — `buildApp()` factory: registers CORS, API routes (`/v1/*`), health check, and static file serving (`public/`).

### Database Provider (Dual Driver)

`DATABASE_PROVIDER` selects the database driver at startup:

| Value | Driver | Use case |
|-------|--------|----------|
| `pg` (default) | `pg` + `drizzle-orm/node-postgres` | Local Docker, traditional servers |
| `neon` | `@neondatabase/serverless` + `drizzle-orm/neon-serverless` | Vercel + Neon |

`src/db/index.ts` uses top-level `await` to dynamically import the correct driver. The rest of the codebase (`pool.connect()`, raw SQL, Drizzle insert) works unchanged because both drivers expose the same `Pool` / query interface.

### Frontend

The chat UI is a **Svelte 5 + Vite + Tailwind 4 + daisyUI** app in `web/`. `vite build` outputs to `../public`, so `public/` is **build output, not hand-written** — do not edit `public/index.html` directly. Served by `@fastify/static` in local dev (with SPA fallback to `index.html`); on Vercel, `src/app.ts` reads `public/index.html` manually and `vercel.json` includes it.

- Frontend dev server: `npm run web:dev` (vite on :5173, proxies `/v1` and `/health`).
- ⚠️ `web/vite.config.ts` proxies to `http://localhost:3344`, but the backend defaults to port `3000` (`config.port`). When developing the UI against the backend, run the backend with `PORT=3344` or update the proxy target.
- The UI consumes the backend's custom NDJSON stream (see Gotchas), not OpenAI SSE. It calls `/v1/chat/completions` and sends an `x-session-id` header for session memory.

### Gotchas

- **Drizzle ORM is only used for schema definition and basic queries**. Vector search and migration use **raw SQL** through the `pg` Pool because Drizzle does not support pgvector operators (`<=>`).
- **Migration is custom SQL**, not `drizzle-kit push`. `src/db/migrate.ts` runs `CREATE EXTENSION vector`, `CREATE TABLE ...`, and HNSW/GIN indexes.
- **Search has an exact-key fast path**: if the query contains `key=...` or `key: ...`, embeddings are bypassed entirely for a direct SQL lookup.
- **Hybrid search with weighted RRF**: `src/retrieval/search.ts` fuses vector (pgvector `<=>`), Postgres FTS, and `ILIKE` candidate lists via Reciprocal Rank Fusion (`RRF_K`, `RRF_WEIGHT_VECTOR/FTS/ILIKE`). Exact/normalized entity matches are pinned ahead of the fused list (`RERANK_PINNED_PREFIX`), then results go through the reranker.
- **Query intent is hardcoded in `src/retrieval/intent.ts`**: Chinese/English regex patterns infer document type (`weapon`, `soldier`, `vehicle`, etc.), detect enumeration/comparison requests, and extract `class="N"` filters — not LLM-driven.
- **External system prompts are dropped**: `chat.ts` filters out all `role: 'system'` messages from the request and enforces `SYSTEM_PROMPT` server-side.
- **Multi-turn with session memory**: full conversation history is passed to the LLM, and an `x-session-id` header keys a rolling summary (`src/memory/summarizer.ts`, regenerated every `SUMMARY_INTERVAL_TURNS`). Retrieval is history-aware — `src/retrieval/queryRewrite.ts` enriches the latest user query with history + summary before searching.
- **Custom NDJSON streaming (not SSE)**: the streamed response is newline-delimited JSON for the Vercel AI SDK, not OpenAI `data:` SSE. Each line is one object with a `type`: `text-delta` (`{textDelta}`), `json-delta` (`{jsonDelta}`, partial structured object), `finish` (`{usage}`), or `error`. Consumed by `web/src/lib/api.ts`.
- **Structured output for enumeration/comparison**: when `classifyQuery` returns `enumeration`/`comparison` AND the request sets `response_format: json_object` (or the `x-response-format` header), `chat.ts` uses `streamObject` with `EnumResultSchema`/`ComparisonResultSchema` (`src/types/schemas.ts`); otherwise plain `streamText`.
- **Meta queries skip search**: `isMetaQuery` (`src/retrieval/intent.ts`) short-circuits retrieval for questions about the bot itself.
- **Embedding content uses compact format**: `structuredDocToRWRDocument` produces content from `description` + `flat_attributes` + `i18n`, omitting the verbose `raw_text` to save ~60% storage. The full XML structure is preserved in the extracted JSON `data` field for review.

## Environment & Config

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_KEY` | falls back to `SILICONFLOW_API_KEY` | LLM API key (required) |
| `LLM_BASE_URL` | SiliconFlow URL | LLM API base URL |
| `LLM_MODEL` | `deepseek-v4-flash` | LLM model name |
| `DATA_DIR` | `./data` | Source data directory (for file-reading tools) |
| `GRAPH_PATH` | `./output/graph.json` | Graph index path |
| `SEARCH_INDEX_PATH` | `./output/search-index.json` | Minisearch index path |
| `PORT` | `3000` | Server port |

> **Note**: PostgreSQL / pgvector / embedding API / rerank API are **no longer required** for the main chat flow. The legacy `src/retrieval/search.ts` (pgvector hybrid search) and `src/db/` modules remain for backward compatibility with the extract/embed CLI, but `chat.ts` now uses `src/retrieval/localSearch.ts` (Minisearch) exclusively.

## Vercel + Neon Deployment

1. Create a Neon database and run migration once:
   ```bash
   DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require \
   DATABASE_PROVIDER=neon DATABASE_SSL=true \
   npm run db:migrate
   ```
2. Ingest data (run locally with Neon connection string):
   ```bash
   DATABASE_URL=postgresql://... DATABASE_PROVIDER=neon DATABASE_SSL=true \
   npm run ingest -- --source ./data --mod GFL_Castling
   ```
3. Deploy to Vercel:
   ```bash
   vercel
   ```
4. Set Vercel environment variables:
   - `DATABASE_URL` — Neon connection string (with `?sslmode=require`)
   - `DATABASE_PROVIDER=neon`
   - `DATABASE_SSL=true`
   - `DATABASE_POOL_MAX=10`
   - `SILICONFLOW_API_KEY`
   - `LLM_API_KEY`

The frontend chat UI is available at the deployed root URL. The API remains at `/v1/chat/completions`.

## Docker

```bash
docker compose up -d                          # Postgres + App
docker compose run --rm app npm run db:migrate:prod
docker compose run --rm app npm run ingest:prod -- --source /app/data --mod GFL_Castling
docker compose down -v                        # wipe Postgres data
```

Production targets use compiled `dist/` (not `tsx`). Data directory is mounted read-only at `/app/data`.

## Testing

- **No unit-test runner** (no Jest/Vitest/Mocha). Retrieval quality is checked by the **eval harness**: `npm run eval` runs `src/eval/run.ts` over cases in `tests/eval/`, scoring with `src/eval/metrics.ts`. `test.sh` (if present) is a single `curl` smoke test against `/v1/chat/completions`.

## Style

- Strict TypeScript (`strict: true`).
- Prefer concise, accurate responses. Use existing relative import style.