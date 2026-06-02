# AGENTS.md

## Project Overview

RAG AI Agent for *Running With Rifles* game data. Node.js 20+ / TypeScript / Fastify. OpenAI-compatible chat completions API with built-in retrieval. Includes a built-in chat UI served at `/`.

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
```

## Running Locally (Required Order)

1. `docker compose up -d` — Postgres with pgvector
2. `cp .env.example .env` — fill in `DATABASE_URL`, `SILICONFLOW_API_KEY`, `LLM_API_KEY`
3. `npm run db:migrate` — creates table, extension, HNSW/GIN indexes
4. `npm run extract -- --source ./data --mod GFL_Castling` — extract data to JSON for review
5. `npm run embed -- --input ./extracted-documents.json` — embed JSON into database
6. `npm run dev`

## Extract CLI (Step 1: Parse → Structured JSON)

```bash
npm run extract -- --source ./data --mod GFL_Castling
npm run extract -- --source ./data --mod GFL_Castling --output ./my-data.json
npm run extract -- --source ./data --mod GFL_Castling --languages ./custom/path/languages
```

Output is a JSON file (`extracted-documents.json` by default) containing **structured documents** with:
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
npm run embed -- --input ./extracted-documents.json
npm run embed -- --input ./extracted-documents.json --clear   # wipe mod first
npm run embed -- --input ./extracted-documents.json --resume  # skip existing
npm run embed -- --input ./extracted-documents.json --filter-type weapon  # only weapons
npm run embed -- --input ./extracted-documents.json --limit 10  # embed first 10 docs (testing)
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
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `DATABASE_PROVIDER` | `pg` | `pg` for Docker/local, `neon` for Neon serverless |
| `DATABASE_POOL_MAX` | `20` | Connection pool max (Neon free tier: `10`) |
| `DATABASE_SSL` | `false` | Enable SSL (Neon requires `true`) |
| `DATABASE_TABLE` | `rwr_documents` | Table name for environment isolation |
| `SILICONFLOW_API_KEY` | (required) | SiliconFlow API key for embeddings |
| `LLM_API_KEY` | falls back to `SILICONFLOW_API_KEY` | LLM API key |
| `EMBEDDING_DIMENSION` | `1024` | BAAI/bge-m3 dimension. **Changing after data exists requires dropping the table.** |

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