# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> A detailed `AGENTS.md` also exists. It is **partially stale** — see "Where AGENTS.md is outdated" below. When the two disagree, trust this file.

## What this is

A RAG agent for *Running With Rifles* game data: a Fastify server exposing an **OpenAI-compatible** `/v1/chat/completions` endpoint with built-in retrieval over a pgvector store, plus a Svelte chat UI. Data flows through a two-stage ingestion pipeline (parse game files → JSON → embed).

## Critical conventions

- **ESM only** (`"type": "module"`, `NodeNext` resolution). All relative imports use `.js` extensions even from `.ts` source. The `~/*` path alias is mapped in tsconfig but **unused in practice** — follow the relative-import style.
- Strict TypeScript. No test framework; correctness is checked via the eval harness (see below) and a curl smoke test.
- ESLint/Prettier run with **default config** (no config files).

## Commands

```bash
npm run dev          # backend hot-reload (tsx) — src/api/server.ts
npm run web:dev      # frontend dev server (vite :5173, proxies /v1 + /health)
npm run build        # tsc → dist/  AND  vite build web/ → public/
npm start            # node dist/api/server.js

npm run db:migrate   # custom SQL: CREATE EXTENSION vector + table + HNSW/GIN indexes
npm run extract -- --source ./data --mod GFL_Castling   # game files → extracted JSON
npm run embed   -- --input ./extracted-documents.json   # JSON → vector DB
npm run ingest  -- --source ./data --mod GFL_Castling   # legacy: extract+embed combined

npm run eval         # retrieval eval harness → src/eval/run.ts (no unit-test runner exists)
npm run lint         # eslint src
npm run format       # prettier
```

Ingestion flags: `--clear` (wipe mod first), `--resume` (skip existing, dedup key `${type}:${key}`), `--filter-type <t>`, `--limit <n>`. `*:prod` script variants run compiled `dist/` for Docker.

### Required local startup order
1. `docker compose up -d` (Postgres + pgvector)
2. `cp .env.example .env`, fill `DATABASE_URL`, `SILICONFLOW_API_KEY`, `LLM_API_KEY`
3. `npm run db:migrate`
4. `npm run extract …` then `npm run embed …`
5. `npm run dev`

## Architecture

### Entry points & app factory
- `src/app.ts` — `buildApp()` factory: registers CORS, `/v1/*` routes, `/health`, and static serving. Used by both entry points.
- `src/api/server.ts` — local dev entry (`app.listen()`).
- `src/index.ts` / `api/index.ts` — Vercel serverless entry (exports the Fastify instance, no `listen`).
- Static serving is environment-split: **local** uses `@fastify/static` over `public/` with an SPA fallback to `index.html`; **Vercel** (`process.env.VERCEL`) reads `public/index.html` manually.

### Frontend (`web/` → builds into `public/`)
The UI is a **Svelte 5 + Vite + Tailwind 4 + daisyUI** app in `web/`. `vite build` outputs to `../public`, which the backend serves. `public/` is therefore **build output**, not hand-written. The dev server proxies `/v1` and `/health` to the backend.
- ⚠️ `web/vite.config.ts` proxies to **`http://localhost:3344`**, but the backend defaults to **port 3000** (`config.port`). Run the backend on 3344 (`PORT=3344`) or update the proxy when developing the UI together.

### Request pipeline (`src/api/routes/chat.ts`)
This is the heart of the system. Per request:
1. **External `system` messages are dropped** — server enforces its own `SYSTEM_PROMPT` (`src/retrieval/prompt.ts`). Anti-injection.
2. Token-size guard rejects oversized requests (~`maxContextTokens * 0.7`).
3. **Session memory**: `x-session-id` header keys a rolling summary (`src/memory/summarizer.ts`); summaries regenerate every `SUMMARY_INTERVAL_TURNS`.
4. **Meta-query detection** (`isMetaQuery`) short-circuits search entirely for questions about the bot itself.
5. **Query rewrite** (`src/retrieval/queryRewrite.ts`) enriches the query with conversation history + summary before searching.
6. **Search** (`src/retrieval/search.ts`) → **rerank** (`src/retrieval/rerank.ts`).
7. **Structured vs text output**: when the query is classified `enumeration`/`comparison` AND the request sets `response_format: json_object` (or `x-response-format` header), it uses `streamObject` with `EnumResultSchema`/`ComparisonResultSchema` (`src/types/schemas.ts`); otherwise `streamText`.

### ⚠️ Streaming is custom NDJSON, not OpenAI SSE
Despite the "OpenAI-compatible" framing, the streaming response is **newline-delimited JSON** built for the Vercel AI SDK, not SSE `data:` chunks. Each line is one JSON object with a `type`:
- `{type:'text-delta', textDelta}` — plain text chunks
- `{type:'json-delta', jsonDelta}` — partial structured object
- `{type:'finish', usage}` / `{type:'error', error}`

The frontend (`web/src/lib/api.ts`) consumes this format. README/AGENTS.md examples showing SSE are aspirational for the non-streaming shape only.

### Retrieval internals (`src/retrieval/search.ts`)
- **Exact-key fast path**: queries containing `key=…`/`key: …` bypass embeddings for a direct SQL lookup.
- **Hybrid search with weighted RRF**: fuses vector (pgvector `<=>` cosine), Postgres FTS, and `ILIKE` candidate lists via Reciprocal Rank Fusion. Weights are configurable (`RRF_WEIGHT_VECTOR/FTS/ILIKE`, `RRF_K`).
- **Pinned prefix**: exact/normalized entity matches are pinned ahead of the fused results (`RERANK_PINNED_PREFIX`).
- **Intent parsing** (`src/retrieval/intent.ts`): Chinese/English regex infer document type (`weapon`, `soldier`, `vehicle`, …), detect enumeration/comparison, and extract `class="N"` filters. This logic is **hardcoded**, not LLM-driven.

### Database (dual driver)
`DATABASE_PROVIDER` selects the driver at startup via top-level `await` in `src/db/index.ts`: `pg` (default, Docker/local) or `neon` (`@neondatabase/serverless`, for Vercel). Both expose the same `Pool` interface so the rest of the code is driver-agnostic.
- **Drizzle is only for schema definition** (`src/db/schema.ts`). All vector search and migration use **raw SQL** through the `pg` Pool — Drizzle has no pgvector operator support, and `db:migrate.ts` is hand-written SQL, **not** `drizzle-kit push`.
- `DATABASE_TABLE` isolates environments (dev/staging/prod) without code changes. `GET /v1/tables` auto-discovers tables (by `doc_id` column) and requests may target one via `body.table`.

### Ingestion (`src/ingestion/`)
Two stages, reviewable in between:
- **extract** (`extract.ts`): walks the source tree, dispatches by extension to `xmlParser.ts` (`.weapon/.projectile/.call/.character/.xml`, with inheritance resolution), `asParser.ts` (`.as` AngelScript), or plain-text fallback. Resolves i18n (`i18n.ts`) from `languages/` dirs into an `i18n` field so Chinese names match. Skips `models/` and `maps/`. Output: structured JSON with `description`, `raw_text`, full `data` (XML-as-JSON), `flat_attributes`, `metadata`, `i18n`.
- **embed** (`embed.ts` + `store.ts` + `embeddings.ts`): chunks, embeds via SiliconFlow `bge-m3`, stores. Embedding content is the **compact** form (`description` + `flat_attributes` + `i18n`, dropping verbose `raw_text` to save ~60% storage); the full XML lives in the extracted JSON only.

### Cross-cutting
- **Caching** (`src/cache/`): memory + Postgres backends, gated by `CACHE_ENABLED` / `CACHE_TTL_SECONDS`.
- **Observability** (`src/observability/langfuse.ts`, `src/instrumentation.ts`): Langfuse OTel tracing wraps the chat chain (search/rerank/generation spans), gated by `LANGFUSE_ENABLED`.

## Where AGENTS.md is outdated
- **"Single-turn only / no session history"** — no longer true. Full message history is used, plus `x-session-id` session summaries and history-aware query rewrite.
- **"`public/index.html` is a self-contained UI, no build step"** — replaced by the Svelte app in `web/` that builds into `public/`. Treat `public/` as generated.
- **Streaming as SSE** — actual format is custom NDJSON (above).

## Key environment variables
Beyond the required keys, notable knobs (all in `src/config/index.ts`): `DATABASE_PROVIDER`, `DATABASE_TABLE`, `EMBEDDING_DIMENSION` (1024; **changing after data exists requires recreating the table**), `RERANK_MODEL`, `RRF_*` weights, `SUMMARY_INTERVAL_TURNS`, `CACHE_*`, `LANGFUSE_*`, `MAX_CONTEXT_TOKENS`, `PORT`.
